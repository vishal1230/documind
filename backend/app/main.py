"""FastAPI application: HTTP endpoints for documents, search and chat."""

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Document, SessionLocal, get_session, init_db
from app.ingestion import EmptyDocumentError, UnsupportedFileError
from app.rag import MissingAPIKeyError, cited_source_numbers, describe_llm_error, generate_answer, stream_answer
from app.retrieval import RetrievedChunk, search
from app.schemas import ChatRequest, ChatResponse, ChunkOut, DocumentOut, SearchRequest, SourceOut
from app.service import ingest_file

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("documind")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # create the pgvector extension and tables on startup
    yield


app = FastAPI(
    title="DocuMind API",
    description="Chat with your own documents, with citations. Hybrid search (pgvector + full-text) and re-ranking.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def timing(request: Request, call_next):
    """Log method, path, status and latency for every request (basic observability)."""
    start = time.perf_counter()
    response = await call_next(request)
    log.info(
        "%s %s -> %s in %.0f ms",
        request.method,
        request.url.path,
        response.status_code,
        (time.perf_counter() - start) * 1000,
    )
    return response


@app.exception_handler(MissingAPIKeyError)
async def missing_key_handler(_: Request, exc: MissingAPIKeyError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/health", tags=["meta"])
def health(session: Session = Depends(get_session)):
    session.execute(text("SELECT 1"))
    return {"status": "ok"}


# ---------------------------------------------------------------- documents --
# These endpoints are plain `def`, not `async def`: parsing PDFs and running the
# embedding model are CPU-bound, so FastAPI runs them in a worker thread instead of
# blocking the event loop that serves every other request.


@app.post("/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED, tags=["documents"])
def upload_document(file: UploadFile = File(...), session: Session = Depends(get_session)):
    data = file.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"File is larger than {settings.max_upload_mb} MB")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty")
    try:
        doc, duplicate = ingest_file(session, file.filename or "upload", data)
    except UnsupportedFileError as e:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(e)) from e
    except EmptyDocumentError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    log.info("ingested %s: %d chunks (duplicate=%s)", doc.filename, doc.num_chunks, duplicate)
    return DocumentOut.model_validate(doc).model_copy(update={"duplicate": duplicate})


@app.get("/documents", response_model=list[DocumentOut], tags=["documents"])
def list_documents(session: Session = Depends(get_session)):
    return session.scalars(select(Document).order_by(Document.created_at.desc())).all()


@app.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["documents"])
def delete_document(document_id: uuid.UUID, session: Session = Depends(get_session)):
    doc = session.get(Document, document_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    session.delete(doc)
    session.commit()


# ------------------------------------------------------------- search & chat --


def _chunk_out(c: RetrievedChunk) -> ChunkOut:
    return ChunkOut(**c.__dict__)


@app.post("/search", response_model=list[ChunkOut], tags=["search"])
def search_chunks(req: SearchRequest, session: Session = Depends(get_session)):
    """Retrieval only, no LLM. Useful for debugging and for the evaluation script."""
    return [_chunk_out(c) for c in search(session, req.query, req.top_k, req.mode, req.document_ids)]


def _sources(chunks: list[RetrievedChunk], answer: str) -> list[SourceOut]:
    cited = set(cited_source_numbers(answer, len(chunks)))
    return [SourceOut(**c.__dict__, number=i, cited=i in cited) for i, c in enumerate(chunks, start=1)]


@app.post("/chat", response_model=ChatResponse, tags=["chat"])
def chat(req: ChatRequest, session: Session = Depends(get_session)):
    chunks = search(session, req.question, req.top_k, document_ids=req.document_ids)
    history = [t.model_dump() for t in req.history]
    try:
        answer = generate_answer(req.question, chunks, history)
    except MissingAPIKeyError:
        raise
    except Exception as e:
        log.exception("generation failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, describe_llm_error(e)) from e
    return ChatResponse(answer=answer, sources=_sources(chunks, answer))


def _sse(event: str, data) -> str:
    """Server-Sent Events wire format: 'event: <name>\\ndata: <json>\\n\\n'."""
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@app.post("/chat/stream", tags=["chat"])
async def chat_stream(req: ChatRequest):
    """Streams the answer as Server-Sent Events: `sources` first, then `token`s, then `done`.

    Sending sources first lets the UI show where the answer comes from immediately,
    before the first token arrives (better perceived latency).
    """

    def retrieve() -> list[RetrievedChunk]:
        with SessionLocal() as session:  # own session: this runs outside the request scope
            return search(session, req.question, req.top_k, document_ids=req.document_ids)

    chunks = await run_in_threadpool(retrieve)  # CPU-bound search off the event loop
    history = [t.model_dump() for t in req.history]

    async def events():
        yield _sse("sources", [_chunk_out(c).model_dump() | {"number": i} for i, c in enumerate(chunks, 1)])
        answer = ""
        try:
            async for token in stream_answer(req.question, chunks, history):
                answer += token
                yield _sse("token", {"text": token})
        except MissingAPIKeyError as e:
            yield _sse("error", {"detail": str(e)})
            return
        except Exception as e:  # surface LLM/provider errors to the UI instead of a silent hang
            log.exception("generation failed")
            yield _sse("error", {"detail": describe_llm_error(e)})
            return
        yield _sse("done", {"cited": cited_source_numbers(answer, len(chunks))})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

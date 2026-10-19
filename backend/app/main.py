"""FastAPI application: HTTP endpoints for documents, search and chat."""

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import conversations as convs
from app.auth import (
    claim_existing_data,
    clear_session_cookie,
    current_user,
    hash_password,
    set_session_cookie,
    verify_password,
)
from app.config import get_settings
from app.db import Document, DocumentFile, SessionLocal, User, get_session, init_db
from app.ingestion import EmptyDocumentError, UnsupportedFileError
from app.models import AudioDecodeError, get_embedder, get_reranker, get_transcriber
from app.query import to_search_query
from app.rag import MissingAPIKeyError, cited_source_numbers, describe_llm_error, generate_answer, stream_answer
from app.retrieval import RetrievedChunk, search
from app.schemas import (
    ChatRequest,
    ChatResponse,
    ChunkOut,
    ConversationDetail,
    ConversationRename,
    ConversationSummary,
    DocumentOut,
    LoginRequest,
    MessageOut,
    RegisterRequest,
    SearchRequest,
    SourceOut,
    TranscriptOut,
    UserOut,
)
from app.service import ingest_file

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("documind")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.secret_key.startswith("dev-only"):
        log.warning("SECRET_KEY is not set: using an insecure development key. Set it before deploying!")
    init_db()  # create the pgvector extension and tables on startup
    # Load the embedding and re-ranker models now, so the first user request isn't slowed by it.
    get_embedder()
    get_reranker()
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
    allow_credentials=True,  # the browser sends the login cookie with API calls
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


# --------------------------------------------------------------------- auth --


@app.post("/auth/register", response_model=UserOut, status_code=status.HTTP_201_CREATED, tags=["auth"])
def register(body: RegisterRequest, response: Response, session: Session = Depends(get_session)):
    email = body.email.lower()
    if session.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    session.add(user)
    session.flush()
    adopted = claim_existing_data(session, user)
    session.commit()
    if adopted:
        log.info("first account %s adopted %d existing documents", email, adopted)
    set_session_cookie(response, user.id)
    return user


@app.post("/auth/login", response_model=UserOut, tags=["auth"])
def login(body: LoginRequest, response: Response, session: Session = Depends(get_session)):
    user = session.scalar(select(User).where(User.email == body.email.lower()))
    # Same message whether the email or the password is wrong: don't reveal which emails have accounts.
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    set_session_cookie(response, user.id)
    return user


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, tags=["auth"])
def logout(response: Response):
    clear_session_cookie(response)


@app.get("/auth/me", response_model=UserOut, tags=["auth"])
def me(user: User = Depends(current_user)):
    return user


# ---------------------------------------------------------------- documents --
# These endpoints are plain `def`, not `async def`: parsing PDFs and running the
# embedding model are CPU-bound, so FastAPI runs them in a worker thread instead of
# blocking the event loop that serves every other request.


@app.post("/documents", response_model=DocumentOut, status_code=status.HTTP_201_CREATED, tags=["documents"])
def upload_document(
    file: UploadFile = File(...), session: Session = Depends(get_session), user: User = Depends(current_user)
):
    data = file.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"File is larger than {settings.max_upload_mb} MB")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty")
    try:
        doc, duplicate = ingest_file(session, file.filename or "upload", data, owner_id=user.id)
    except UnsupportedFileError as e:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(e)) from e
    except EmptyDocumentError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    log.info(
        "ingested %s: %d chunks, %d pages via OCR (duplicate=%s)",
        doc.filename,
        doc.num_chunks,
        getattr(doc, "ocr_pages", 0),
        duplicate,
    )
    return DocumentOut.model_validate(doc).model_copy(update={"duplicate": duplicate})


@app.get("/documents", response_model=list[DocumentOut], tags=["documents"])
def list_documents(session: Session = Depends(get_session), user: User = Depends(current_user)):
    with_file = set(
        session.scalars(select(DocumentFile.document_id).join(Document).where(Document.owner_id == user.id))
    )
    docs = session.scalars(
        select(Document).where(Document.owner_id == user.id).order_by(Document.created_at.desc())
    ).all()
    return [DocumentOut.model_validate(d).model_copy(update={"has_file": d.id in with_file}) for d in docs]


def _own_document(session: Session, document_id: uuid.UUID, user: User) -> Document:
    """The document if it belongs to this user. Someone else's document looks exactly like a missing one."""
    doc = session.get(Document, document_id)
    if doc is None or doc.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    return doc


@app.get("/documents/{document_id}/file", tags=["documents"])
def get_document_file(
    document_id: uuid.UUID, session: Session = Depends(get_session), user: User = Depends(current_user)
):
    """The original file, shown inline in the browser (PDF viewer or text view)."""
    doc = _own_document(session, document_id, user)
    stored = session.get(DocumentFile, document_id)
    if stored is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Original file not stored. Upload it again to view it.")
    media = "text/plain; charset=utf-8" if doc.content_type.startswith("text/") else doc.content_type
    return Response(
        content=stored.data,
        media_type=media,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(doc.filename)}"},
    )


@app.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["documents"])
def delete_document(
    document_id: uuid.UUID, session: Session = Depends(get_session), user: User = Depends(current_user)
):
    session.delete(_own_document(session, document_id, user))
    session.commit()


# ------------------------------------------------------------- search & chat --


def _chunk_out(c: RetrievedChunk) -> ChunkOut:
    return ChunkOut(**c.__dict__)


# ------------------------------------------------------------- conversations --


@app.get("/conversations", response_model=list[ConversationSummary], tags=["conversations"])
def list_conversations(session: Session = Depends(get_session), user: User = Depends(current_user)):
    return [
        ConversationSummary(id=c.id, title=c.title, updated_at=c.updated_at, message_count=n)
        for c, n in convs.list_conversations(session, user.id)
    ]


def _own_conversation(session: Session, conversation_id: uuid.UUID, user: User):
    try:
        return convs.get_owned(session, conversation_id, user.id)
    except convs.ConversationNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found") from None


@app.get("/conversations/{conversation_id}", response_model=ConversationDetail, tags=["conversations"])
def get_conversation(
    conversation_id: uuid.UUID, session: Session = Depends(get_session), user: User = Depends(current_user)
):
    conv = _own_conversation(session, conversation_id, user)
    return ConversationDetail(
        id=conv.id, title=conv.title, messages=[MessageOut.model_validate(m) for m in conv.messages]
    )


@app.patch("/conversations/{conversation_id}", response_model=ConversationSummary, tags=["conversations"])
def rename_conversation(
    conversation_id: uuid.UUID,
    body: ConversationRename,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    conv = _own_conversation(session, conversation_id, user)
    conv.title = body.title.strip()
    session.commit()
    return ConversationSummary(
        id=conv.id, title=conv.title, updated_at=conv.updated_at, message_count=len(conv.messages)
    )


@app.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["conversations"])
def delete_conversation(
    conversation_id: uuid.UUID, session: Session = Depends(get_session), user: User = Depends(current_user)
):
    session.delete(_own_conversation(session, conversation_id, user))  # messages are deleted with it (cascade)
    session.commit()


@app.post("/transcribe", response_model=TranscriptOut, tags=["voice"])
def transcribe(audio: UploadFile = File(...), language: str = Form("auto"), _: User = Depends(current_user)):
    """Speech-to-text for the microphone button: audio file in, question text out.

    `language`: "auto" (detect), "en" or "hi". Forcing the language helps a lot for Hindi/Hinglish.
    Runs Whisper locally, so recordings never leave the server. Plain `def`: decoding audio
    and running the model is CPU work, so FastAPI runs it in a worker thread.
    """
    limit = settings.max_audio_mb * 1024 * 1024
    data = audio.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"Recording is larger than {settings.max_audio_mb} MB")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty recording")
    try:
        result = get_transcriber().transcribe(data, None if language == "auto" else language)
    except AudioDecodeError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if not result.text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "No speech detected. Try speaking a little longer.")
    log.info("transcribed %.1fs of audio (%s)", result.duration_s, result.language)
    return TranscriptOut(text=result.text, language=result.language, duration_s=result.duration_s)


@app.post("/search", response_model=list[ChunkOut], tags=["search"])
def search_chunks(req: SearchRequest, session: Session = Depends(get_session), user: User = Depends(current_user)):
    """Retrieval only, no LLM. Useful for debugging and for the evaluation script."""
    return [_chunk_out(c) for c in search(session, req.query, req.top_k, req.mode, req.document_ids, owner_id=user.id)]


def _sources(chunks: list[RetrievedChunk], answer: str) -> list[SourceOut]:
    cited = set(cited_source_numbers(answer, len(chunks)))
    return [SourceOut(**c.__dict__, number=i, cited=i in cited) for i, c in enumerate(chunks, start=1)]


@app.post("/chat", response_model=ChatResponse, tags=["chat"])
def chat(req: ChatRequest, session: Session = Depends(get_session), user: User = Depends(current_user)):
    history = [t.model_dump() for t in req.history]
    query = to_search_query(req.question, history)  # English, standalone version for retrieval
    chunks = search(session, query, req.top_k, document_ids=req.document_ids, owner_id=user.id)
    try:
        answer = generate_answer(req.question, chunks, history, query)
    except MissingAPIKeyError:
        raise
    except Exception as e:
        log.exception("generation failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, describe_llm_error(e)) from e
    return ChatResponse(answer=answer, sources=_sources(chunks, answer), search_query=query)


def _sse(event: str, data) -> str:
    """Server-Sent Events wire format: 'event: <name>\\ndata: <json>\\n\\n'."""
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@app.post("/chat/stream", tags=["chat"])
async def chat_stream(req: ChatRequest, user: User = Depends(current_user)):
    """Streams the answer as Server-Sent Events:
    `conversation` (saved chat id), `query` (if rewritten), `sources`, then `token`s, then `done`.

    Sending sources first lets the UI show where the answer comes from immediately,
    before the first token arrives (better perceived latency). Every turn is saved.
    """

    def start() -> tuple[uuid.UUID, str, list[dict], str, list[RetrievedChunk]]:
        with SessionLocal() as session:  # own session: this runs outside the request scope
            try:
                conv = convs.get_or_create(session, req.conversation_id, req.question, owner_id=user.id)
            except convs.ConversationNotFound:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found") from None
            # A saved chat is the source of truth for history; otherwise use what the client sent.
            history = (
                convs.recent_history(session, conv.id) if req.conversation_id else [t.model_dump() for t in req.history]
            )
            convs.add_message(session, conv.id, "user", req.question)
            session.commit()
            conv_id, title = conv.id, conv.title
            query = to_search_query(req.question, history)  # translate / resolve follow-ups (LLM call if needed)
            chunks = search(session, query, req.top_k, document_ids=req.document_ids, owner_id=user.id)
            return conv_id, title, history, query, chunks

    conv_id, title, history, query, chunks = await run_in_threadpool(start)  # blocking work off the event loop
    sources = [_chunk_out(c).model_dump(mode="json") | {"number": i} for i, c in enumerate(chunks, 1)]

    def save_answer(answer: str, cited: list[int]) -> None:
        with SessionLocal() as session:
            extra = {"sources": sources, "cited": cited, "search_query": query if query != req.question else None}
            convs.add_message(session, conv_id, "assistant", answer, **extra)
            session.commit()

    async def events():
        yield _sse("conversation", {"id": str(conv_id), "title": title})
        if query != req.question:
            yield _sse("query", {"text": query})  # lets the UI show what was actually searched
        yield _sse("sources", sources)
        answer = ""
        try:
            async for token in stream_answer(req.question, chunks, history, query):
                answer += token
                yield _sse("token", {"text": token})
        except MissingAPIKeyError as e:
            yield _sse("error", {"detail": str(e)})
            return
        except Exception as e:  # surface LLM/provider errors to the UI instead of a silent hang
            log.exception("generation failed")
            yield _sse("error", {"detail": describe_llm_error(e)})
            return
        cited = cited_source_numbers(answer, len(chunks))
        await run_in_threadpool(save_answer, answer, cited)
        yield _sse("done", {"cited": cited})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

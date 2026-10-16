"""Business logic shared by the API and the evaluation script."""

import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Chunk, Document
from app.ingestion import SUPPORTED_TYPES, chunk_pages, extract_pages, file_extension
from app.models import get_embedder


def ingest_file(session: Session, filename: str, data: bytes) -> tuple[Document, bool]:
    """Parse, chunk, embed and store a file. Returns (document, was_duplicate).

    Everything happens in one transaction: if embedding fails halfway, nothing is saved,
    so the database never holds a document with missing chunks.
    """
    s = get_settings()
    digest = hashlib.sha256(data).hexdigest()
    existing = session.scalar(select(Document).where(Document.sha256 == digest))
    if existing:
        return existing, True

    pages = extract_pages(filename, data)
    chunks = chunk_pages(pages, s.chunk_size, s.chunk_overlap)
    vectors = get_embedder().embed_documents([c.content for c in chunks])  # one batched call

    doc = Document(
        filename=filename,
        content_type=SUPPORTED_TYPES[file_extension(filename)],
        sha256=digest,
        num_pages=len(pages),
        num_chunks=len(chunks),
    )
    doc.chunks = [
        Chunk(chunk_index=c.index, page=c.page, content=c.content, embedding=v)
        for c, v in zip(chunks, vectors, strict=True)
    ]
    session.add(doc)
    session.commit()
    return doc, False

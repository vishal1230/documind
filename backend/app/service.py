"""Business logic shared by the API and the evaluation script."""

import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Chunk, Document, DocumentFile
from app.ingestion import SUPPORTED_TYPES, chunk_pages, extract_pages, file_extension
from app.models import get_embedder


def ingest_file(
    session: Session, filename: str, data: bytes, owner_id: uuid.UUID | None = None
) -> tuple[Document, bool]:
    """Parse, chunk, embed and store a file. Returns (document, was_duplicate).

    Everything happens in one transaction: if embedding fails halfway, nothing is saved,
    so the database never holds a document with missing chunks.
    """
    s = get_settings()
    digest = hashlib.sha256(data).hexdigest()
    same_owner = Document.owner_id == owner_id if owner_id else Document.owner_id.is_(None)
    existing = session.scalar(select(Document).where(Document.sha256 == digest, same_owner))
    if existing:
        if session.get(DocumentFile, existing.id) is None:  # indexed before files were stored
            session.add(DocumentFile(document_id=existing.id, data=data))
            session.commit()
        return existing, True

    pages = extract_pages(filename, data)
    chunks = chunk_pages(pages, s.chunk_size, s.chunk_overlap)
    vectors = get_embedder().embed_documents([c.content for c in chunks])  # one batched call

    doc = Document(
        owner_id=owner_id,
        filename=filename,
        content_type=SUPPORTED_TYPES[file_extension(filename)],
        sha256=digest,
        num_pages=len(pages),
        num_chunks=len(chunks),
    )
    doc.ocr_pages = sum(p.ocr for p in pages)  # reported back to the UI (not stored)
    doc.chunks = [
        Chunk(chunk_index=c.index, page=c.page, content=c.content, embedding=v)
        for c, v in zip(chunks, vectors, strict=True)
    ]
    session.add(doc)
    session.flush()  # assigns doc.id
    session.add(DocumentFile(document_id=doc.id, data=data))
    session.commit()
    return doc, False

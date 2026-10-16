"""Database engine, session factory and table models.

PostgreSQL stores everything: document metadata, chunk text, the chunk's vector
embedding (pgvector) and a full-text search vector (tsvector). Keeping vectors next
to relational data means one database to run, back up and secure.
"""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    text,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from app.config import get_settings

settings = get_settings()

# pool_pre_ping checks a pooled connection is alive before using it
# (avoids errors after the database restarts).
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=5, max_overflow=5)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    # SHA-256 of the file bytes: uploading the same file twice is detected and skipped.
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    num_pages: Mapped[int] = mapped_column(Integer, default=1)
    num_chunks: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    # Deleting a document deletes its chunks too (ORM cascade + ON DELETE CASCADE).
    chunks: Mapped[list["Chunk"]] = relationship(back_populates="document", cascade="all, delete-orphan")


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)  # position of the chunk in its document
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 1-based page for PDFs
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(Vector(settings.embedding_dim))
    # Generated column: PostgreSQL keeps it in sync with `content` automatically.
    # Used for keyword (BM25-style) search in hybrid retrieval.
    tsv: Mapped[str] = mapped_column(TSVECTOR, Computed("to_tsvector('english', content)", persisted=True))

    document: Mapped[Document] = relationship(back_populates="chunks")

    __table_args__ = (
        # HNSW = approximate nearest-neighbour graph index. Much faster than scanning
        # every vector, at the cost of slightly imperfect recall.
        Index(
            "ix_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        # GIN index makes full-text queries on the tsvector fast.
        Index("ix_chunks_tsv_gin", "tsv", postgresql_using="gin"),
    )


_INIT_LOCK_KEY = 7_201_001  # any fixed number; identifies DocuMind's startup lock


def init_db() -> None:
    """Enable pgvector and create tables (idempotent).

    Several uvicorn workers start at the same moment and each runs this. Without a lock
    they race: two "CREATE EXTENSION IF NOT EXISTS" calls can both see the extension as
    missing and the second fails with a unique-key error. A transaction-scoped Postgres
    advisory lock makes the workers run this one at a time.
    """
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _INIT_LOCK_KEY})
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        Base.metadata.create_all(conn)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed afterwards."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

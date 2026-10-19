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
    LargeBinary,
    String,
    Text,
    create_engine,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from app.config import get_settings

settings = get_settings()

# pool_pre_ping checks a pooled connection is alive before using it
# (avoids errors after the database restarts).
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=5, max_overflow=5)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    """An account. Every document and chat belongs to exactly one user."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)  # stored lower-case
    name: Mapped[str] = mapped_column(String(100), default="")
    password_hash: Mapped[str] = mapped_column(String(100))  # bcrypt hash, never the password
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Owner of the document. Search, chat and the file viewer only ever see the current user's documents.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    # SHA-256 of the file bytes: the same user uploading the same file twice is detected and skipped.
    # (Unique per owner, so two users can each upload the same file.)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    num_pages: Mapped[int] = mapped_column(Integer, default=1)
    num_chunks: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    # Deleting a document deletes its chunks too (ORM cascade + ON DELETE CASCADE).
    chunks: Mapped[list["Chunk"]] = relationship(back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (Index("uq_documents_owner_sha256", "owner_id", "sha256", unique=True),)


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


class DocumentFile(Base):
    """The original uploaded bytes, so the UI can show the real PDF with the cited passage highlighted.

    Kept in its own table so listing or searching documents never loads file contents.
    (Documents uploaded before this table existed have no row; re-uploading the file adds it.)
    """

    __tablename__ = "document_files"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    data: Mapped[bytes] = mapped_column(LargeBinary)


def _now() -> datetime:
    return datetime.now(UTC)


class Conversation(Base):
    """A saved chat: the sidebar's "Chats" list. Messages are stored so a chat survives a page refresh."""

    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="Message.id"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # "user" or "assistant"
    content: Mapped[str] = mapped_column(Text)
    # Assistant messages keep the sources they were answered from (a snapshot as JSON),
    # so an old chat still shows its citations even if a document is later deleted.
    sources: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    cited: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    search_query: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


# create_all() creates missing tables but never changes existing ones. Databases created before
# accounts existed need these columns and indexes added. Every statement is idempotent, so they
# simply run on each start. (A bigger project would use Alembic migrations instead.)
MIGRATIONS = [
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS ix_documents_owner_id ON documents (owner_id)",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS ix_conversations_owner_id ON conversations (owner_id)",
    # sha256 used to be globally unique; now it's unique per owner.
    "ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_sha256_key",
    "DROP INDEX IF EXISTS ix_documents_sha256",
    "CREATE INDEX IF NOT EXISTS ix_documents_sha256 ON documents (sha256)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_owner_sha256 ON documents (owner_id, sha256)",
]

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
        for statement in MIGRATIONS:
            conn.execute(text(statement))


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed afterwards."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

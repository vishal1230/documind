"""Request/response models. Pydantic validates every request before our code runs."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.retrieval import SearchMode


class DocumentOut(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    num_pages: int
    num_chunks: int
    created_at: datetime
    duplicate: bool = False  # true when the same file had already been uploaded
    has_file: bool = True  # original file stored, so it can be opened in the viewer
    ocr_pages: int = 0  # pages read with OCR during this upload (scanned PDF or image)

    model_config = {"from_attributes": True}


class ChunkOut(BaseModel):
    chunk_id: int
    document_id: uuid.UUID
    filename: str
    page: int | None
    chunk_index: int
    content: str
    score: float


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    top_k: int = Field(default=5, ge=1, le=50)
    mode: SearchMode = SearchMode.hybrid_rerank
    document_ids: list[uuid.UUID] | None = None


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    document_ids: list[uuid.UUID] | None = None  # limit the search to these documents
    history: list[Turn] = Field(default_factory=list, max_length=20)
    top_k: int = Field(default=5, ge=1, le=20)
    # Streaming chat saves every turn. Pass the id to continue a saved chat (history then comes
    # from the database); leave it empty to start a new one.
    conversation_id: uuid.UUID | None = None


class SourceOut(ChunkOut):
    number: int  # the [n] used in the answer
    cited: bool  # whether the answer actually referenced it


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceOut]
    search_query: str  # what retrieval actually searched for (translated / standalone version)


class TranscriptOut(BaseModel):
    text: str
    language: str  # detected spoken language, e.g. "en", "hi"
    duration_s: float


class ConversationSummary(BaseModel):
    id: uuid.UUID
    title: str
    updated_at: datetime
    message_count: int


class MessageOut(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    sources: list[dict] | None = None
    cited: list[int] | None = None
    search_query: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationDetail(BaseModel):
    id: uuid.UUID
    title: str
    messages: list[MessageOut]


class ConversationRename(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)  # bcrypt only uses the first 72 bytes
    name: str = Field(default="", max_length=100)

    @field_validator("password")
    @classmethod
    def fits_bcrypt(cls, v: str) -> str:
        if len(v.encode()) > 72:
            raise ValueError("Password is too long (max 72 bytes)")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str

    model_config = {"from_attributes": True}

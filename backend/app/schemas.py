"""Request/response models. Pydantic validates every request before our code runs."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.retrieval import SearchMode


class DocumentOut(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    num_pages: int
    num_chunks: int
    created_at: datetime
    duplicate: bool = False  # true when the same file had already been uploaded

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


class SourceOut(ChunkOut):
    number: int  # the [n] used in the answer
    cited: bool  # whether the answer actually referenced it


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceOut]

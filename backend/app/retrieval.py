"""Finding the chunks most likely to contain the answer.

Two first-stage retrievers run in parallel conceptually:
  * vector search   - meaning-based: "time off" matches "annual leave"
  * keyword search  - exact terms: product codes, names, acronyms the embedder may blur
Their ranked lists are merged with Reciprocal Rank Fusion (RRF), then a cross-encoder
re-ranks the merged candidates and the best `top_k` go to the LLM.
"""

import uuid
from dataclasses import dataclass, replace
from enum import StrEnum

from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document as LCDocument
from langchain_core.retrievers import BaseRetriever
from sqlalchemy import Text, cast, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Chunk, Document
from app.models import get_embedder, get_reranker


class SearchMode(StrEnum):
    vector = "vector"
    keyword = "keyword"
    hybrid = "hybrid"  # vector + keyword fused with RRF
    hybrid_rerank = "hybrid_rerank"  # hybrid, then cross-encoder re-ranking (default)


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: int
    document_id: uuid.UUID
    filename: str
    page: int | None
    chunk_index: int
    content: str
    score: float


def _to_retrieved(rows) -> list[RetrievedChunk]:
    return [
        RetrievedChunk(
            chunk_id=c.id,
            document_id=c.document_id,
            filename=filename,
            page=c.page,
            chunk_index=c.chunk_index,
            content=c.content,
            score=float(score),
        )
        for c, filename, score in rows
    ]


def vector_search(
    session: Session,
    query_vec: list[float],
    k: int,
    document_ids: list[uuid.UUID] | None = None,
    owner_id: uuid.UUID | None = None,
) -> list[RetrievedChunk]:
    """Nearest neighbours by cosine distance (pgvector's <=> operator), served by the HNSW index."""
    distance = Chunk.embedding.cosine_distance(query_vec)
    stmt = select(Chunk, Document.filename, (1 - distance).label("score")).join(Document).order_by(distance).limit(k)
    if document_ids:
        stmt = stmt.where(Chunk.document_id.in_(document_ids))
    if owner_id is not None:  # each user only ever searches their own documents
        stmt = stmt.where(Document.owner_id == owner_id)
    return _to_retrieved(session.execute(stmt).all())


def keyword_search(
    session: Session,
    query: str,
    k: int,
    document_ids: list[uuid.UUID] | None = None,
    owner_id: uuid.UUID | None = None,
) -> list[RetrievedChunk]:
    """PostgreSQL full-text search. websearch_to_tsquery understands quotes, OR and -excluded words.

    ts_rank_cd scores matches by term frequency and how close the terms are to each other.
    We OR the query words together so a chunk matching most (not all) words still ranks.
    """
    strict = func.websearch_to_tsquery("english", query)
    loose = func.to_tsquery("english", func.replace(cast(func.plainto_tsquery("english", query), Text), " & ", " | "))
    rank = func.ts_rank_cd(Chunk.tsv, strict) * 2 + func.ts_rank_cd(Chunk.tsv, loose)
    stmt = (
        select(Chunk, Document.filename, rank.label("score"))
        .join(Document)
        .where(Chunk.tsv.op("@@")(loose))
        .order_by(rank.desc())
        .limit(k)
    )
    if document_ids:
        stmt = stmt.where(Chunk.document_id.in_(document_ids))
    if owner_id is not None:  # each user only ever searches their own documents
        stmt = stmt.where(Document.owner_id == owner_id)
    return _to_retrieved(session.execute(stmt).all())


def reciprocal_rank_fusion(result_lists: list[list[RetrievedChunk]], k: int = 60) -> list[RetrievedChunk]:
    """Merge ranked lists: score(chunk) = sum over lists of 1 / (k + rank).

    RRF only uses *ranks*, so it can combine scores on different scales (cosine
    similarity vs ts_rank) without normalising them. k=60 comes from the original paper
    (Cormack et al., 2009) and dampens the advantage of the very top positions.
    """
    fused: dict[int, float] = {}
    best: dict[int, RetrievedChunk] = {}
    for results in result_lists:
        for rank, chunk in enumerate(results, start=1):
            fused[chunk.chunk_id] = fused.get(chunk.chunk_id, 0.0) + 1.0 / (k + rank)
            best.setdefault(chunk.chunk_id, chunk)
    ordered = sorted(fused, key=fused.get, reverse=True)
    return [replace(best[cid], score=fused[cid]) for cid in ordered]


def rerank(query: str, chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
    reranker = get_reranker()
    if reranker is None or not chunks:
        return chunks
    scores = reranker.score(query, [c.content for c in chunks])
    rescored = [replace(c, score=s) for c, s in zip(chunks, scores, strict=True)]
    return sorted(rescored, key=lambda c: c.score, reverse=True)


def search(
    session: Session,
    query: str,
    top_k: int | None = None,
    mode: SearchMode = SearchMode.hybrid_rerank,
    document_ids: list[uuid.UUID] | None = None,
    owner_id: uuid.UUID | None = None,
) -> list[RetrievedChunk]:
    """owner_id limits the search to one user's documents (always set by the API; None = all, for the eval)."""
    s = get_settings()
    top_k = top_k or s.top_k
    n = max(s.candidate_k, top_k)

    if mode == SearchMode.keyword:
        return keyword_search(session, query, top_k, document_ids, owner_id)

    query_vec = get_embedder().embed_query(query)
    if mode == SearchMode.vector:
        return vector_search(session, query_vec, top_k, document_ids, owner_id)

    fused = reciprocal_rank_fusion(
        [
            vector_search(session, query_vec, n, document_ids, owner_id),
            keyword_search(session, query, n, document_ids, owner_id),
        ],
        k=s.rrf_k,
    )
    if mode == SearchMode.hybrid:
        return fused[:top_k]
    return rerank(query, fused[:n])[:top_k]


class DocuMindRetriever(BaseRetriever):
    """Adapter so the hybrid search can plug into any LangChain chain or agent."""

    session: Session
    top_k: int = 5
    document_ids: list[uuid.UUID] | None = None

    model_config = {"arbitrary_types_allowed": True}

    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> list[LCDocument]:
        return [
            LCDocument(
                page_content=c.content,
                metadata={"filename": c.filename, "page": c.page, "chunk_id": c.chunk_id, "score": c.score},
            )
            for c in search(self.session, query, self.top_k, document_ids=self.document_ids)
        ]

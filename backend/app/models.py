"""Local ML models: the embedder (text -> vector) and the re-ranker (query, passage -> relevance).

Both run on your CPU through ONNX Runtime (via the `fastembed` library), so no API key
is needed and documents never leave your machine for indexing. Models download from
Hugging Face the first time they are used (~130 MB in total) and are cached afterwards.
"""

import hashlib
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

from app.config import get_settings


class Embedder(Protocol):
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class Reranker(Protocol):
    def score(self, query: str, passages: list[str]) -> list[float]: ...


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str  # language detected in the audio, e.g. "en" or "hi"
    duration_s: float


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, language: str | None = None) -> Transcript: ...


class AudioDecodeError(ValueError):
    """The uploaded bytes are not audio we can decode."""


class FastEmbedEmbedder:
    """BAAI/bge-small-en-v1.5: a small (33M parameter), strong English embedding model.

    bge models are trained with a slightly different input for queries vs passages
    ("asymmetric" retrieval); fastembed's query_embed/passage_embed handle that for us.
    Vectors come back L2-normalised, so cosine similarity == dot product.
    """

    def __init__(self, model_name: str):
        from fastembed import TextEmbedding

        self._model = TextEmbedding(model_name)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [vec.tolist() for vec in self._model.passage_embed(texts, batch_size=32)]

    def embed_query(self, text: str) -> list[float]:
        return next(iter(self._model.query_embed(text))).tolist()


class FastEmbedReranker:
    """A cross-encoder reads the query and a passage *together* and outputs a relevance score.

    It is far more accurate than comparing two separately computed vectors, but too slow
    to run over every chunk, so we only re-rank the ~20 candidates from the first stage.
    """

    def __init__(self, model_name: str):
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        self._model = TextCrossEncoder(model_name)

    def score(self, query: str, passages: list[str]) -> list[float]:
        return [float(s) for s in self._model.rerank(query, passages)]


class HashingEmbedder:
    """Deterministic stand-in used in tests/CI (no downloads).

    Hashes each word into one of `dim` buckets ("feature hashing"). Texts sharing words
    get similar vectors, which is enough to test the plumbing, not to judge quality.
    """

    def __init__(self, dim: int):
        self.dim = dim

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            bucket = int(hashlib.md5(word.encode()).hexdigest(), 16) % self.dim
            vec[bucket] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


class WordOverlapReranker:
    """Stand-in re-ranker for tests: share of query words found in the passage."""

    def score(self, query: str, passages: list[str]) -> list[float]:
        q = set(re.findall(r"[a-z0-9]+", query.lower()))
        return [len(q & set(re.findall(r"[a-z0-9]+", p.lower()))) / (len(q) or 1) for p in passages]


@lru_cache
def get_embedder() -> Embedder:
    """Loaded once per process (model loading takes a few seconds)."""
    s = get_settings()
    return HashingEmbedder(s.embedding_dim) if s.fake_models else FastEmbedEmbedder(s.embedding_model)


@lru_cache
def get_reranker() -> Reranker | None:
    s = get_settings()
    if not s.use_reranker:
        return None
    return WordOverlapReranker() if s.fake_models else FastEmbedReranker(s.reranker_model)


HINDI_HINT = "नमस्ते, यह छुट्टी और नीति के बारे में एक सवाल है।"


class WhisperTranscriber:
    """Speech-to-text with OpenAI's Whisper, run locally by faster-whisper (CTranslate2 engine).

    int8 quantisation makes the "base" model (~150 MB) fast enough on a laptop CPU.
    The browser records WebM/Opus; faster-whisper decodes it with PyAV, so no ffmpeg install is needed.
    """

    def __init__(self, model_name: str, compute_type: str, download_root: str | None, translate: bool):
        from faster_whisper import WhisperModel

        self._model = WhisperModel(model_name, device="cpu", compute_type=compute_type, download_root=download_root)
        self._task = "translate" if translate else "transcribe"

    def transcribe(self, audio: bytes, language: str | None = None) -> Transcript:
        import io

        try:
            segments, info = self._model.transcribe(
                io.BytesIO(audio),
                language=language,  # None = auto-detect; "hi" forces Hindi (auto-detect often misses Hinglish)
                task=self._task,  # "translate" = any language in, English text out
                beam_size=1,  # greedy decoding: much faster on CPU, fine for short questions
                vad_filter=True,  # skip silence at the start/end of the recording
                # A Devanagari hint stops Whisper writing Hindi in Urdu script.
                initial_prompt=HINDI_HINT if language == "hi" else None,
            )
            text = " ".join(seg.text.strip() for seg in segments)  # segments are lazy: decoding happens here
        except Exception as e:  # PyAV raises its own error types for bad/unsupported audio
            raise AudioDecodeError(f"Could not read the audio: {e.__class__.__name__}") from e
        return Transcript(text=text.strip(), language=info.language, duration_s=round(info.duration, 2))


class FakeTranscriber:
    """Test stand-in: returns a fixed question for any non-empty audio."""

    def transcribe(self, audio: bytes, language: str | None = None) -> Transcript:
        if not audio.strip(b"\x00"):
            raise AudioDecodeError("Could not read the audio: empty")
        return Transcript(text="How many days of annual leave do I get?", language=language or "en", duration_s=2.0)


@lru_cache
def get_transcriber() -> Transcriber:
    s = get_settings()
    if s.fake_models:
        return FakeTranscriber()
    return WhisperTranscriber(
        s.whisper_model, s.whisper_compute_type, s.whisper_download_root, s.whisper_translate_to_english
    )

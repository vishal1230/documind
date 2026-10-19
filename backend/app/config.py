"""Application settings, loaded from environment variables (or a .env file).

Every tunable number lives here so you can change behaviour without touching code,
and so tests can override values (e.g. FAKE_MODELS=true in CI).
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Database -------------------------------------------------------------
    database_url: str = "postgresql+psycopg://documind:documind@localhost:5432/documind"

    # --- LLM (answer generation) ---------------------------------------------
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.8-flash"
    # Tried in order if the main model fails (e.g. 503 "high demand"). JSON list in .env.
    gemini_fallback_models: list[str] = []
    # Speed settings. 0 turns off "thinking" on models that support it (fast, fine for short factual answers);
    # leave unset to use the model's default.
    gemini_thinking_budget: int | None = None
    llm_max_retries: int = 1  # retries on the same model before moving to the next fallback
    llm_timeout: int = 20  # seconds per model attempt
    llm_temperature: float = 0.2

    # --- Optional local LLM via Ollama (https://ollama.com) --------------------
    # Set OLLAMA_MODEL (e.g. llama3.2:3b) to use it as the LAST fallback when Gemini is overloaded or out of
    # quota. With OLLAMA_MODEL set and no GEMINI_API_KEY, DocuMind runs fully offline on the local model.
    ollama_model: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    ollama_timeout: int = 180  # local models on a laptop CPU are slower than an API

    # --- Local models (run on your machine, no API key needed) ----------------
    embedding_model: str = "BAAI/bge-small-en-v1.5"  # 384-dimensional sentence embeddings
    embedding_dim: int = 384
    reranker_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"  # cross-encoder re-ranker
    use_reranker: bool = True

    # --- Speech-to-text (local Whisper via faster-whisper) ----------------------
    # tiny | base | small | medium. "small" is the smallest that handles Hindi/Hinglish well.
    whisper_model: str = "small"
    whisper_compute_type: str = "int8"  # 8-bit weights: ~4x smaller and faster on CPU
    whisper_download_root: str | None = None  # where the model is cached (Docker: /models/whisper)
    # Keep the spoken language (Hindi stays Hindi). Search still works because app.query translates
    # the question to English for retrieval. Set true to make Whisper output English directly.
    whisper_translate_to_english: bool = False
    max_audio_mb: int = 10

    # When true, deterministic fake embedder/LLM are used (unit tests and CI,
    # where downloading models or calling Gemini is not possible).
    fake_models: bool = False

    # --- OCR for scanned PDFs and images (Tesseract) ----------------------------
    ocr_enabled: bool = True
    ocr_languages: str = "eng+hin"  # Tesseract language codes joined with "+"
    ocr_dpi: int = 200  # render resolution for scanned pages; 200-300 is the sweet spot
    ocr_min_chars: int = 20  # a PDF page with less extractable text than this is treated as scanned
    ocr_max_pages: int = 100  # OCR takes a few seconds per page; refuse very long scans

    # --- Chunking ---------------------------------------------------------------
    chunk_size: int = 600  # characters (~150 tokens); bge-small accepts up to 512 tokens
    chunk_overlap: int = 100  # characters shared between neighbouring chunks

    # --- Retrieval --------------------------------------------------------------
    top_k: int = 5  # chunks passed to the LLM
    candidate_k: int = 20  # chunks fetched by each retriever before fusion/re-ranking
    rrf_k: int = 60  # constant in Reciprocal Rank Fusion

    # --- Accounts -----------------------------------------------------------------
    # Signs login tokens. MUST be set to a long random value in production (anyone who knows it
    # can forge logins). Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"
    secret_key: str = "dev-only-insecure-secret-change-me"
    session_days: int = 7  # how long a login lasts
    cookie_secure: bool = False  # set true when the site is served over HTTPS

    # --- API --------------------------------------------------------------------
    max_upload_mb: int = 15
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]


@lru_cache
def get_settings() -> Settings:
    """Cached so the .env file is read once per process."""
    return Settings()

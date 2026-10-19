# ---- Build stage: install dependencies into a virtualenv ---------------------
FROM python:3.11-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /venv
ENV PATH="/venv/bin:$PATH"
COPY requirements.txt .
RUN pip install -r requirements.txt

# ---- Runtime stage: only the virtualenv and the code, no build tools ---------
FROM python:3.11-slim
ENV PATH="/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FASTEMBED_CACHE_PATH=/models \
    WHISPER_DOWNLOAD_ROOT=/models/whisper
# Tesseract OCR engine with English and Hindi language data, for scanned PDFs and images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /venv /venv
COPY app ./app

# Bake the embedding, re-ranker and Whisper models into the image so containers start instantly.
# Build with --build-arg DOWNLOAD_MODELS=false to skip (e.g. in CI).
ARG DOWNLOAD_MODELS=true
RUN if [ "$DOWNLOAD_MODELS" = "true" ]; then python -m app.warmup; fi

# Run as a non-root user (a basic container hardening step).
RUN useradd --create-home appuser && mkdir -p /models && chown -R appuser /app /models
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]

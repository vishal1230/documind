# DocuMind

Chat with your own documents and get answers with clickable citations.

Upload PDFs, Markdown or text files. DocuMind splits them into chunks, indexes them in PostgreSQL with pgvector, and answers questions using **hybrid search** (keyword + vector), a **cross-encoder re-ranker** and **Gemini**. Every sentence in an answer is tied to a numbered source you can open. If the documents don't contain the answer, it says so instead of guessing.

![DocuMind UI](docs/screenshot.png)
<sub>UI preview. This screenshot was taken with the stand-in test models (`FAKE_MODELS=true`), so the answer text is a fixed test reply.</sub>

## Features

- **Upload & index** PDF / Markdown / TXT, with page numbers kept for PDFs and duplicate files detected by SHA-256.
- **Hybrid retrieval**: pgvector cosine search (HNSW index) + PostgreSQL full-text search (GIN index), merged with Reciprocal Rank Fusion.
- **Re-ranking** with a cross-encoder (`ms-marco-MiniLM-L-6-v2`) before the LLM sees anything.
- **Grounded answers** with `[n]` citations, a fixed "I couldn't find this" refusal, and short conversation memory for follow-ups.
- **Streaming** answers over Server-Sent Events.
- **Prompt-injection defence**: document text is wrapped as untrusted data; a test document tries to hijack the model and the eval checks that it fails.
- **Scope search** to selected documents.
- **Evaluation script**: 30 labelled questions, hit@k / MRR / latency for each search mode, plus answer accuracy, refusal and injection checks.
- **Free, local embeddings** (fastembed / ONNX, no GPU, no PyTorch). Only answer generation calls an API.
- Docker Compose for one-command start; GitHub Actions for lint, tests (70% coverage gate) and frontend build.

## Architecture

```mermaid
flowchart LR
    U[Browser<br/>Next.js + TypeScript] -->|upload / chat SSE| API[FastAPI]
    subgraph Ingestion
      API --> X[Extract text<br/>pypdf, per page] --> C[Clean + chunk<br/>600 chars, 100 overlap] --> E[Embed<br/>bge-small-en-v1.5, 384-d]
    end
    E --> DB[(PostgreSQL 16<br/>pgvector HNSW + tsvector GIN)]
    subgraph Question answering
      API --> Q[Question] --> V[Vector search] & K[Keyword search]
      V & K --> F[RRF fusion<br/>top 20] --> R[Cross-encoder re-rank<br/>top 5] --> P[Prompt with numbered sources] --> G[Gemini via LangChain] --> S[Answer + citations]
    end
    DB --- V & K
```

| Layer | Choice | Why |
|---|---|---|
| API | FastAPI, Pydantic v2 | Typed request/response validation, auto docs at `/docs`, async streaming |
| Orchestration | LangChain (LCEL) | `prompt \| llm \| parser` chain, swappable LLM, retriever adapter |
| Storage | PostgreSQL 16 + pgvector | One database for metadata, vectors and full-text search, so hybrid search is a single SQL round trip each |
| Embeddings | fastembed `BAAI/bge-small-en-v1.5` | Strong small English model, runs on CPU, free |
| Re-ranker | `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder | Reads question and chunk together, so it is more accurate than embedding similarity |
| LLM | Gemini (`gemini-3.8-flash` by default), optional local Ollama fallback | Fast and cheap; automatic failover to backup Gemini models, then a local model |
| Frontend | Next.js 15 (App Router), React 19, Tailwind 4 | Streaming chat UI with citation badges |

Full explanation of every file and design decision: **[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

## Quick start (Docker, Windows/macOS/Linux)

Needs Docker Desktop and a free Gemini API key from <https://aistudio.google.com/apikey>.

```powershell
git clone https://github.com/vishal1230/documind.git
cd documind
copy backend\.env.example backend\.env      # macOS/Linux: cp backend/.env.example backend/.env
# open backend\.env and paste your key after GEMINI_API_KEY=
docker compose up --build
```

The first build downloads the embedding and re-ranker models into the image (a few hundred MB), so it takes several minutes.

- App: <http://localhost:3001>
- API docs (Swagger): <http://localhost:8001/docs>

Try it: drag the files from `sample_docs/` onto the upload box, then click one of the example questions.

> Ports: on your machine the app is on **3001**, the API on **8001** and PostgreSQL on **5433**, so DocuMind doesn't clash with other apps or a local PostgreSQL on the default ports 3000/8000/5432. Inside Docker they still use 3000/8000/5432. If one of these ports is busy, change the left-hand number in `docker-compose.yml`.

### Optional: local fallback model (Ollama)

If Gemini is overloaded (503) or you hit the free-tier quota (429), DocuMind can fall back to a model running on your own machine, so the app keeps answering. Without a Gemini key it runs fully offline.

1. Install [Ollama](https://ollama.com/download) and pull a small model: `ollama pull qwen2.5:3b` (about 2 GB).
2. Add `OLLAMA_MODEL=qwen2.5:3b` to `backend/.env`.
3. `docker compose up -d --build backend`

Order of attempts: `GEMINI_MODEL` → each of `GEMINI_FALLBACK_MODELS` → `OLLAMA_MODEL`. A local 3B model on a laptop CPU is slower (several seconds per answer) and less precise than Gemini, but it keeps the app working and your documents never leave your machine.

## Local development (without Docker for the app)

```powershell
# 1. Database only
docker compose up -d db

# 2. Backend (Python 3.11+)
cd backend
python -m venv .venv
.venv\Scripts\activate                 # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
copy .env.example .env                 # then add GEMINI_API_KEY
uvicorn app.main:app --reload --port 8001   # http://localhost:8001

# 3. Frontend (Node 20+), in a second terminal
cd frontend
npm install
npm run dev -- -p 3001                 # http://localhost:3001
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + database check |
| POST | `/documents` | Upload a file (multipart `file`). Returns `duplicate: true` if already indexed |
| GET | `/documents` | List indexed documents |
| DELETE | `/documents/{id}` | Delete a document and its chunks |
| POST | `/search` | Retrieval only: `{query, top_k, mode}`; mode = `vector`, `keyword`, `hybrid`, `hybrid_rerank` |
| POST | `/chat` | Answer + sources + cited numbers (JSON) |
| POST | `/chat/stream` | Same, streamed as SSE events: `sources`, `token`…, `done` (or `error`) |

## Evaluation

`backend/eval/questions.jsonl` has 30 questions about the sample documents. Each one records which file holds the answer and a phrase the answer must contain. There are 3 extra out-of-scope questions and 1 injection test.

```powershell
docker compose up -d db
cd backend
.venv\Scripts\activate
python -m eval.run_eval              # retrieval metrics only (no API key needed)
python -m eval.run_eval --generate   # + answer accuracy, refusals, injection test (uses Gemini)
```

Results are written to `backend/eval/results.md`.

| Metric | Meaning |
|---|---|
| hit@k | Share of questions where a chunk from the right file is in the top k |
| MRR | Mean of 1/rank of the first correct chunk (1.0 = always first) |
| p50 latency | Median retrieval time per question |
| Answer accuracy | Answer contains the expected fact |
| Refusal rate | Out-of-scope questions answered with the "couldn't find" message |
| Injection resisted | The model did not obey the hidden instruction in `vendor_note_injection_test.md` |

### Results

Retrieval, measured with the real models (`bge-small-en-v1.5` embeddings, `ms-marco-MiniLM-L-6-v2` re-ranker) on the 30 questions, running in Docker on a Windows laptop CPU:

| Mode | hit@1 | hit@3 | hit@5 | MRR | p50 latency |
|---|---|---|---|---|---|
| vector | 0.90 | 1.00 | 1.00 | 0.94 | 14 ms |
| keyword | 0.73 | 0.93 | 0.97 | 0.83 | 3 ms |
| hybrid (RRF) | 0.90 | 1.00 | 1.00 | 0.94 | 19 ms |
| **hybrid + re-rank** | **0.97** | **1.00** | **1.00** | **0.98** | 597 ms |

Re-ranking puts the right document first for 29 of 30 questions (vector search alone: 27 of 30), at the cost of about 0.6 s of CPU time per question.

Generation (answer accuracy, refusals, injection test): _to be added after a full `--generate` run; see `backend/eval/results.md`._

## Tests

```powershell
docker compose up -d db
docker compose exec db createdb -U documind documind_test
cd backend
$env:FAKE_MODELS="true"               # bash: export FAKE_MODELS=true
pytest --cov=app
ruff check . ; ruff format --check .
```

`FAKE_MODELS=true` swaps in a hashing embedder, a word-overlap re-ranker and a canned LLM, so tests are fast, offline and free. They still run against a real PostgreSQL with pgvector. 27 tests, about 92% coverage. CI runs the same checks on every push.

## Project structure

```
documind/
├── backend/
│   ├── app/
│   │   ├── main.py        FastAPI app and endpoints
│   │   ├── config.py      Settings from environment / .env
│   │   ├── db.py          SQLAlchemy models, pgvector + full-text indexes
│   │   ├── ingestion.py   Extract, clean, chunk
│   │   ├── models.py      Embedder and re-ranker (real + fake)
│   │   ├── retrieval.py   Vector, keyword, RRF, re-rank, LangChain retriever
│   │   ├── rag.py         Prompt, LLM, citation parsing, streaming
│   │   ├── service.py     Ingest pipeline (dedupe, embed, save)
│   │   ├── schemas.py     Request/response models
│   │   └── warmup.py      Pre-downloads models at image build time
│   ├── eval/              30-question evaluation
│   ├── tests/             pytest suite
│   └── Dockerfile
├── frontend/              Next.js chat UI
├── sample_docs/           Fictional demo documents + injection test
├── docs/                  HOW_IT_WORKS.md, DEPLOY_AWS.md
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## Deploying

Step-by-step AWS EC2 guide: [docs/DEPLOY_AWS.md](docs/DEPLOY_AWS.md).

## Limitations and next steps

- No user accounts: everyone using one deployment shares the same documents. Next step: auth + a `user_id` on documents.
- Scanned PDFs (images) have no text layer; OCR is not included.
- Ingestion runs inside the upload request; very large files would need a background queue.
- Tables and figures are read as plain text.
- The evaluation set is small (30 questions) and written for the sample documents.

## License

MIT. The documents in `sample_docs/` are fictional and created for this demo.

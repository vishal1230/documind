"""Shared test setup.

Tests use fake models (no downloads, no Gemini calls) so they run anywhere, including CI.
API tests need a PostgreSQL database with pgvector; they are skipped if none is reachable.
"""

import os

os.environ.setdefault("FAKE_MODELS", "true")
os.environ.setdefault(
    "DATABASE_URL",
    os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://documind:documind@localhost:5433/documind_test"),
)

from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

SAMPLE_DOCS = Path(__file__).resolve().parents[2] / "sample_docs"


def _db_available() -> bool:
    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def db_ready():
    if not _db_available():
        pytest.skip("PostgreSQL not reachable; set TEST_DATABASE_URL to run API tests")
    from app.db import init_db

    init_db()


@pytest.fixture
def client(db_ready):
    from fastapi.testclient import TestClient

    from app.db import engine
    from app.main import app

    with engine.begin() as conn:  # clean slate for every test
        conn.execute(text("TRUNCATE documents, chunks RESTART IDENTITY CASCADE"))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def handbook_bytes() -> bytes:
    return (SAMPLE_DOCS / "northwind_employee_handbook.md").read_bytes()


@pytest.fixture
def policy_pdf_bytes() -> bytes:
    return (SAMPLE_DOCS / "acme_cloud_security_policy.pdf").read_bytes()

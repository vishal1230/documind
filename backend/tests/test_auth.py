"""Accounts: sign up, log in/out, and above all: users never see each other's documents or chats."""

from fastapi.testclient import TestClient

from app.main import app


def register(c: TestClient, email: str, password: str = "correct-horse-1"):
    return c.post("/auth/register", json={"email": email, "password": password})


def test_everything_requires_login(anon_client):
    for method, path in [("get", "/documents"), ("get", "/conversations"), ("post", "/search"), ("get", "/auth/me")]:
        res = getattr(anon_client, method)(path, **({"json": {"query": "x"}} if method == "post" else {}))
        assert res.status_code == 401, path
    assert anon_client.get("/health").status_code == 200  # health check stays public


def test_register_login_logout(anon_client):
    res = register(anon_client, "Bob@Example.com")
    assert res.status_code == 201 and res.json()["email"] == "bob@example.com"
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert anon_client.get("/auth/me").json()["email"] == "bob@example.com"

    anon_client.post("/auth/logout")
    assert anon_client.get("/auth/me").status_code == 401

    assert (
        anon_client.post("/auth/login", json={"email": "bob@example.com", "password": "nope-nope"}).status_code == 401
    )
    assert (
        anon_client.post("/auth/login", json={"email": "BOB@example.com", "password": "correct-horse-1"}).status_code
        == 200
    )
    assert anon_client.get("/auth/me").status_code == 200


def test_duplicate_email_and_weak_password_rejected(anon_client):
    assert register(anon_client, "carol@example.com").status_code == 201
    assert register(anon_client, "CAROL@example.com").status_code == 409
    assert register(anon_client, "dave@example.com", password="short").status_code == 422
    assert register(anon_client, "not-an-email").status_code == 422


def test_bearer_token_works_and_forged_token_does_not(anon_client):
    from app.auth import COOKIE_NAME

    register(anon_client, "erin@example.com")
    token = anon_client.cookies.get(COOKIE_NAME)
    with TestClient(app) as other:
        assert other.get("/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        assert other.get("/auth/me", headers={"Authorization": f"Bearer {token[:-4]}xxxx"}).status_code == 401


def test_users_cannot_see_each_others_documents_or_chats(client, handbook_bytes):
    # Alice (the `client` fixture) uploads a document and starts a chat.
    doc = client.post("/documents", files={"file": ("handbook.md", handbook_bytes)}).json()
    with client.stream("POST", "/chat/stream", json={"question": "How many days of annual leave?"}) as r:
        conv_id = next(line for line in r.iter_lines() if line.startswith("data:") and '"id"' in line)
    conv_id = conv_id.split('"id": "')[1].split('"')[0]

    with TestClient(app) as bob:
        register(bob, "bob@example.com")
        assert bob.get("/documents").json() == []
        assert bob.post("/search", json={"query": "annual leave"}).json() == []
        assert bob.get(f"/documents/{doc['id']}/file").status_code == 404
        assert bob.delete(f"/documents/{doc['id']}").status_code == 404
        assert bob.get("/conversations").json() == []
        assert bob.get(f"/conversations/{conv_id}").status_code == 404
        assert bob.post("/chat/stream", json={"question": "hi", "conversation_id": conv_id}).status_code == 404

        # Bob can upload the same file: duplicates are detected per user, not globally.
        mine = bob.post("/documents", files={"file": ("handbook.md", handbook_bytes)}).json()
        assert mine["duplicate"] is False and mine["id"] != doc["id"]

    # Alice still has exactly her own document.
    assert [d["id"] for d in client.get("/documents").json()] == [doc["id"]]


def test_first_account_adopts_documents_from_before_accounts_existed(anon_client, handbook_bytes):
    from app.db import SessionLocal
    from app.service import ingest_file

    with SessionLocal() as session:  # a document uploaded before login existed (no owner)
        ingest_file(session, "old.md", handbook_bytes, owner_id=None)
    register(anon_client, "first@example.com")
    assert [d["filename"] for d in anon_client.get("/documents").json()] == ["old.md"]

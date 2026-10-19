"""End-to-end API tests against a real PostgreSQL + pgvector database (fake models)."""

import json


def upload(client, name, data):
    return client.post("/documents", files={"file": (name, data)})


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_upload_list_and_delete(client, handbook_bytes):
    r = upload(client, "northwind_employee_handbook.md", handbook_bytes)
    assert r.status_code == 201
    doc = r.json()
    assert doc["num_chunks"] > 3 and doc["duplicate"] is False

    assert [d["id"] for d in client.get("/documents").json()] == [doc["id"]]

    assert client.delete(f"/documents/{doc['id']}").status_code == 204
    assert client.get("/documents").json() == []
    assert client.delete(f"/documents/{doc['id']}").status_code == 404


def test_duplicate_upload_is_detected(client, handbook_bytes):
    first = upload(client, "a.md", handbook_bytes).json()
    second = upload(client, "copy-of-a.md", handbook_bytes).json()
    assert second["duplicate"] is True and second["id"] == first["id"]
    assert len(client.get("/documents").json()) == 1


def test_rejects_bad_files(client):
    assert upload(client, "archive.zip", b"PK....").status_code == 415
    assert upload(client, "broken.png", b"\x89PNG....").status_code == 422  # image, but unreadable
    assert upload(client, "empty.txt", b"").status_code == 400


def test_pdf_upload_records_pages(client, policy_pdf_bytes):
    doc = upload(client, "acme_cloud_security_policy.pdf", policy_pdf_bytes).json()
    assert doc["num_pages"] == 3


def test_search_finds_relevant_chunk_in_every_mode(client, handbook_bytes, policy_pdf_bytes):
    upload(client, "northwind_employee_handbook.md", handbook_bytes)
    upload(client, "acme_cloud_security_policy.pdf", policy_pdf_bytes)
    for mode in ["vector", "keyword", "hybrid", "hybrid_rerank"]:
        r = client.post("/search", json={"query": "minimum password length characters", "mode": mode, "top_k": 3})
        assert r.status_code == 200, r.text
        top = r.json()
        assert any("14 characters" in c["content"] for c in top), mode
        assert any(c["filename"].endswith(".pdf") and c["page"] == 1 for c in top), mode


def test_search_can_be_limited_to_documents(client, handbook_bytes, policy_pdf_bytes):
    hb = upload(client, "handbook.md", handbook_bytes).json()
    upload(client, "policy.pdf", policy_pdf_bytes)
    r = client.post("/search", json={"query": "password", "document_ids": [hb["id"]]})
    assert {c["filename"] for c in r.json()} <= {"handbook.md"}


def test_chat_returns_answer_and_marks_cited_sources(client, handbook_bytes):
    upload(client, "handbook.md", handbook_bytes)
    r = client.post("/chat", json={"question": "How many days of annual leave do I get?"})
    assert r.status_code == 200
    body = r.json()
    assert "[1]" in body["answer"]
    assert body["sources"][0]["number"] == 1 and body["sources"][0]["cited"] is True


def test_chat_without_documents_refuses(client):
    body = client.post("/chat", json={"question": "What is the leave policy?"}).json()
    assert body["answer"] == "I couldn't find this in your documents."
    assert body["sources"] == []


def test_chat_stream_sends_sources_tokens_done(client, handbook_bytes):
    upload(client, "handbook.md", handbook_bytes)
    with client.stream("POST", "/chat/stream", json={"question": "annual leave days?"}) as r:
        raw = "".join(r.iter_text())
    events = [block.split("\n") for block in raw.strip().split("\n\n")]
    names = [e[0].removeprefix("event: ") for e in events]
    assert names[0] == "conversation" and names[1] == "sources" and names[-1] == "done" and "token" in names
    assert json.loads(events[-1][1].removeprefix("data: "))["cited"] == [1]


def test_validation_errors(client):
    assert client.post("/chat", json={"question": ""}).status_code == 422
    assert client.post("/search", json={"query": "x", "top_k": 500}).status_code == 422


def test_transcribe_returns_question_text(client):
    res = client.post("/transcribe", files={"audio": ("q.webm", b"\x1aE\xdf\xa3fake-audio", "audio/webm")})
    assert res.status_code == 200
    body = res.json()
    assert body["text"] == "How many days of annual leave do I get?"
    assert body["language"] == "en"


def test_transcribe_rejects_empty_and_huge_audio(client):
    assert client.post("/transcribe", files={"audio": ("q.webm", b"", "audio/webm")}).status_code == 400
    big = b"x" * (10 * 1024 * 1024 + 1)
    assert client.post("/transcribe", files={"audio": ("q.webm", big, "audio/webm")}).status_code == 413


def test_transcribe_reports_unreadable_audio(client):
    res = client.post("/transcribe", files={"audio": ("q.webm", b"\x00\x00\x00", "audio/webm")})
    assert res.status_code == 422
    assert "Could not read the audio" in res.json()["detail"]


def test_transcribe_accepts_a_language_hint(client):
    res = client.post(
        "/transcribe", files={"audio": ("q.webm", b"\x1aE\xdf\xa3fake", "audio/webm")}, data={"language": "hi"}
    )
    assert res.status_code == 200
    assert res.json()["language"] == "hi"  # the hint reaches the transcriber


def test_chat_reports_the_search_query(client, handbook_bytes):
    client.post("/documents", files={"file": ("handbook.md", handbook_bytes, "text/markdown")})
    body = client.post("/chat", json={"question": "How many days of annual leave do I get?"}).json()
    assert body["search_query"] == "How many days of annual leave do I get?"


def test_original_file_can_be_downloaded_for_the_viewer(client, handbook_bytes, policy_pdf_bytes):
    md = upload(client, "handbook.md", handbook_bytes).json()
    pdf = upload(client, "policy.pdf", policy_pdf_bytes).json()
    assert all(d["has_file"] for d in client.get("/documents").json())

    res = client.get(f"/documents/{pdf['id']}/file")
    assert res.status_code == 200 and res.headers["content-type"] == "application/pdf"
    assert res.content == policy_pdf_bytes and res.headers["content-disposition"].startswith("inline")

    text = client.get(f"/documents/{md['id']}/file")
    assert text.headers["content-type"].startswith("text/plain") and text.content == handbook_bytes


def test_file_is_deleted_with_its_document(client, handbook_bytes):
    doc = upload(client, "handbook.md", handbook_bytes).json()
    client.delete(f"/documents/{doc['id']}")
    assert client.get(f"/documents/{doc['id']}/file").status_code == 404

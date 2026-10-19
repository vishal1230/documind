"""Saved chats: every streamed turn is stored and can be listed, reopened, renamed and deleted."""

import json

from app.conversations import make_title


def stream(client, **body) -> list[tuple[str, dict]]:
    with client.stream("POST", "/chat/stream", json=body) as r:
        assert r.status_code == 200
        raw = "".join(r.iter_text())
    events = []
    for block in raw.strip().split("\n\n"):
        name, data = block.split("\n", 1)
        events.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return events


def test_titles_are_short_and_cut_at_a_word():
    assert make_title("How many days of leave?") == "How many days of leave?"
    long = make_title("How many days of paid annual leave do full-time employees get every calendar year here?")
    assert long.endswith("…") and len(long) <= 61 and not long[:-1].endswith(" ")


def test_streamed_chat_is_saved_and_continued(client, handbook_bytes):
    client.post("/documents", files={"file": ("handbook.md", handbook_bytes, "text/markdown")})

    first = stream(client, question="How many days of annual leave do I get?")
    conv = first[0][1]
    assert first[0][0] == "conversation" and conv["title"] == "How many days of annual leave do I get?"

    second = stream(client, question="and for interns?", conversation_id=conv["id"])
    assert second[0][1]["id"] == conv["id"]  # same chat continued

    listed = client.get("/conversations").json()
    assert [c["id"] for c in listed] == [conv["id"]] and listed[0]["message_count"] == 4

    detail = client.get(f"/conversations/{conv['id']}").json()
    roles = [m["role"] for m in detail["messages"]]
    assert roles == ["user", "assistant", "user", "assistant"]
    answer = detail["messages"][1]
    assert answer["cited"] == [1] and answer["sources"][0]["number"] == 1  # citations survive a reload


def test_rename_and_delete(client):
    conv = stream(client, question="What is the leave policy?")[0][1]
    renamed = client.patch(f"/conversations/{conv['id']}", json={"title": "Leave questions"}).json()
    assert renamed["title"] == "Leave questions"
    assert client.delete(f"/conversations/{conv['id']}").status_code == 204
    assert client.get(f"/conversations/{conv['id']}").status_code == 404
    assert client.get("/conversations").json() == []


def test_unknown_conversation_is_404(client):
    res = client.post(
        "/chat/stream", json={"question": "hi", "conversation_id": "00000000-0000-0000-0000-000000000000"}
    )
    assert res.status_code == 404

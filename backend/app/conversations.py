"""Saved chats: create conversations, store each turn, and read history back for follow-ups."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import Conversation, Message

HISTORY_TURNS = 6  # how many previous messages are sent to the LLM (same as rag.format_history)


class ConversationNotFound(LookupError):
    pass


def make_title(question: str, limit: int = 60) -> str:
    """First question, trimmed at a word boundary: "How many days of annual leave do I…"."""
    text = " ".join(question.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return (cut or text[:limit]) + "…"


def get_owned(session: Session, conversation_id: uuid.UUID, owner_id: uuid.UUID | None) -> Conversation:
    """The conversation if it exists AND belongs to this user (someone else's chat looks like "not found")."""
    conv = session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise ConversationNotFound(str(conversation_id))
    return conv


def get_or_create(
    session: Session, conversation_id: uuid.UUID | None, first_question: str, owner_id: uuid.UUID | None = None
) -> Conversation:
    if conversation_id is None:
        conv = Conversation(title=make_title(first_question), owner_id=owner_id)
        session.add(conv)
        session.flush()  # assigns the id
        return conv
    return get_owned(session, conversation_id, owner_id)


def recent_history(session: Session, conversation_id: uuid.UUID, limit: int = HISTORY_TURNS) -> list[dict]:
    rows = session.scalars(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.id.desc()).limit(limit)
    ).all()
    return [{"role": m.role, "content": m.content} for m in reversed(rows)]


def add_message(session: Session, conversation_id: uuid.UUID, role: str, content: str, **extra) -> Message:
    msg = Message(conversation_id=conversation_id, role=role, content=content, **extra)
    session.add(msg)
    conv = session.get(Conversation, conversation_id)
    conv.updated_at = datetime.now(UTC)  # most recently used chat goes to the top of the list
    return msg


def list_conversations(
    session: Session, owner_id: uuid.UUID | None = None, limit: int = 50
) -> list[tuple[Conversation, int]]:
    counts = select(Message.conversation_id, func.count().label("n")).group_by(Message.conversation_id).subquery()
    stmt = (
        select(Conversation, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.conversation_id == Conversation.id)
        .where(Conversation.owner_id == owner_id)
        .order_by(Conversation.updated_at.desc())
        .limit(limit)
    )
    return [(conv, n) for conv, n in session.execute(stmt).all()]

"""Accounts and sessions: password hashing, login tokens, and the "who is calling?" dependency.

* Passwords are hashed with bcrypt (slow on purpose, salted), never stored or logged in plain text.
* After login the server sets a signed JWT in an **httpOnly cookie**. JavaScript can't read it
  (protects against token theft by XSS), and the browser sends it automatically, which also makes
  <img src> and "Open file" links to protected files work. SameSite=Lax stops other websites from
  sending it with their requests (CSRF protection).
* API clients/tests may send the same token as "Authorization: Bearer <token>" instead.
"""

import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import Conversation, Document, User, get_session

COOKIE_NAME = "documind_session"
ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def create_token(user_id: uuid.UUID) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "iat": now, "exp": now + timedelta(days=s.session_days)}
    return jwt.encode(payload, s.secret_key, algorithm=ALGORITHM)


def set_session_cookie(response: Response, user_id: uuid.UUID) -> None:
    s = get_settings()
    response.set_cookie(
        COOKIE_NAME,
        create_token(user_id),
        max_age=s.session_days * 24 * 3600,
        httponly=True,  # not readable by JavaScript
        samesite="lax",  # not sent with cross-site POSTs (CSRF)
        secure=s.cookie_secure,  # true when served over HTTPS
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def _token_from(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(COOKIE_NAME)


def current_user(request: Request, session: Session = Depends(get_session)) -> User:
    """FastAPI dependency: the logged-in user, or 401."""
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Please log in", headers={"WWW-Authenticate": "Bearer"})
    token = _token_from(request)
    if not token:
        raise unauthorized
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized from None
    user = session.get(User, user_id)
    if user is None:  # account deleted after the token was issued
        raise unauthorized
    return user


def claim_existing_data(session: Session, user: User) -> int:
    """The very first account adopts documents/chats created before accounts existed.

    So upgrading an existing DocuMind install doesn't make your documents disappear.
    """
    real_users = select(func.count()).select_from(User).where(~User.email.endswith("@documind.local"))
    if session.scalar(real_users) != 1:  # system accounts (e.g. the evaluation's) don't count
        return 0
    moved = session.execute(update(Document).where(Document.owner_id.is_(None)).values(owner_id=user.id)).rowcount
    session.execute(update(Conversation).where(Conversation.owner_id.is_(None)).values(owner_id=user.id))
    return moved

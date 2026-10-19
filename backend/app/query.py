"""Turn the user's question into a good *search* query before retrieval.

Two cases need this:
  * Non-English questions (Hindi in Devanagari, or Hinglish in Latin letters). The embedding
    model and the documents are English, so "mujhe kitni chhutti milti hai?" would not match
    "annual leave". We translate it to English for searching only; the answer still comes back
    in the user's language.
  * Follow-up questions such as "and for interns?" that only make sense with the chat history.
    We rewrite them into a standalone question ("How many days of leave do interns get?").
    This is often called "query condensation" in RAG systems.

Plain English first questions skip the LLM call entirely (no extra latency or API quota).
If the rewrite fails for any reason, we fall back to the original question.
"""

import logging
import re

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate

from app.config import get_settings

log = logging.getLogger("documind")

# Common Hinglish (Hindi written in Latin letters) words. Two or more of them => Hinglish.
HINGLISH_WORDS = {
    "kya", "kaise", "kaisa", "kitna", "kitni", "kitne", "kab", "kahan", "kyun", "kyon", "kaun", "kis", "kisko",
    "hai", "hain", "ho", "hota", "hoti", "hote", "tha", "thi", "mujhe", "mera", "meri", "mere", "hum", "humein",
    "aap", "apna", "apni", "ka", "ki", "ke", "ko", "se", "mein", "par", "aur", "ya", "nahi", "nahin", "bhi",
    "milta", "milti", "milte", "chahiye", "sakta", "sakti", "sakte", "karna", "karne", "karte", "batao", "bataiye",
    "chhutti", "chutti", "din", "paisa", "kaam", "liye", "wala", "wali", "agar", "toh", "abhi", "kuch",
}  # fmt: skip

REWRITE_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You rewrite a user's latest question into ONE standalone English search query for a document search "
            "engine. Translate Hindi or Hinglish into English. Use the conversation only to resolve references like "
            '"it", "that" or "and for interns?". If the latest question is already complete on its own, keep its '
            "meaning exactly and do NOT add topics from the conversation. Keep names, numbers and technical terms. "
            "Output only the rewritten question, nothing else.",
        ),
        # Few-shot examples: small local models follow a demonstrated pattern far better than instructions.
        # (Examples are on unrelated topics so the model learns the format, not the answers.)
        ("human", "Latest question: घर से काम करने के लिए मुझे किससे अनुमति लेनी होगी?"),
        ("ai", "Whose approval do I need to work from home?"),
        ("human", "Latest question: office ka wifi password kahan milega?"),
        ("ai", "Where can I find the office Wi-Fi password?"),
        (
            "human",
            "Conversation so far:\nUser: What is the notice period for resignation?\n"
            "Assistant: The notice period is 60 days [1].\n\nLatest question: and during probation?",
        ),
        ("ai", "What is the notice period for resignation during probation?"),
        (
            "human",
            "Conversation so far:\nUser: What is the notice period for resignation?\n"
            "Assistant: The notice period is 60 days [1].\n\nLatest question: kya laptop ghar le ja sakte hain?",
        ),
        ("ai", "Can I take the laptop home?"),  # new topic: the conversation is ignored
        ("human", "{history}Latest question: {question}"),
    ]
)

# Labels small models sometimes put in front of the answer, e.g. "Search query: ...".
_LABEL = re.compile(
    r"^(search query|rewritten (question|query)|english (question|query)|query|question|answer)\s*:\s*", re.I
)


def looks_non_english(text: str) -> bool:
    """Devanagari (or any non-Latin letters), or several Hinglish words."""
    if re.search(r"[ऀ-ॿ]", text) or re.search(r"[^\W\d_a-zA-Z]", text):
        return True
    words = re.findall(r"[a-zA-Z]+", text.lower())
    return sum(w in HINGLISH_WORDS for w in words) >= 2


# Words that only make sense with the previous turns ("and for interns?", "what about it?").
FOLLOW_UP_WORDS = {
    "it", "its", "that", "this", "these", "those", "they", "them", "their", "he", "she", "him", "her",
    "there", "same", "also", "too", "else", "above", "previous", "former", "latter",
}  # fmt: skip
FOLLOW_UP_STARTS = ("and ", "what about", "how about", "but ", "also ", "then ", "so ", "or ")


def looks_like_follow_up(question: str) -> bool:
    """A question that depends on the conversation, as opposed to a new, self-contained one.

    A new topic in an old chat ("What is the hotel cap per night?") must NOT be rewritten with the
    previous topic mixed in; that once produced "...per night for a SEV-1 incident?".
    """
    q = question.strip().lower()
    words = re.findall(r"[a-z0-9']+", q)
    return len(words) <= 4 or q.startswith(FOLLOW_UP_STARTS) or any(w in FOLLOW_UP_WORDS for w in words)


def needs_rewrite(question: str, history: list[dict] | None) -> bool:
    if looks_non_english(question):
        return True  # always translate to English for search
    return bool(history) and looks_like_follow_up(question)


def to_search_query(question: str, history: list[dict] | None = None) -> str:
    """English, standalone version of the question for retrieval (or the question itself)."""
    if not needs_rewrite(question, history) or get_settings().fake_models:
        return question
    from app.rag import format_history, get_llm  # local import: rag imports retrieval, avoid a cycle

    try:
        chain = REWRITE_PROMPT | get_llm() | StrOutputParser()
        rewritten = chain.invoke({"question": question, "history": format_history(history)})
    except Exception:
        log.warning("query rewrite failed, searching with the original question", exc_info=True)
        return question
    lines = [line.strip() for line in rewritten.strip().splitlines() if line.strip()]
    rewritten = _LABEL.sub("", lines[0]).strip().strip('"').strip() if lines else ""
    if not rewritten or len(rewritten) > 500:
        return question
    log.info("search query rewritten: %r -> %r", question, rewritten)
    return rewritten

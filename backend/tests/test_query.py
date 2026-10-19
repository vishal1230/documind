"""Query rewriting: translation of Hindi/Hinglish and condensing follow-up questions."""

from langchain_core.language_models.fake_chat_models import FakeListChatModel

from app import query, rag
from app.config import get_settings


def test_detects_hindi_and_hinglish_but_not_english():
    assert query.looks_non_english("मुझे कितनी छुट्टी मिलती है?")
    assert query.looks_non_english("mujhe kitni chhutti milti hai?")
    assert not query.looks_non_english("How many days of annual leave do I get?")
    assert not query.looks_non_english("What is the SEV-1 response time?")


def test_plain_english_first_question_skips_the_llm():
    assert not query.needs_rewrite("How many days of annual leave do I get?", [])
    assert query.needs_rewrite("and for interns?", [{"role": "user", "content": "How much leave do I get?"}])


def _real_mode(monkeypatch, llm):
    get_settings.cache_clear()
    monkeypatch.setenv("FAKE_MODELS", "false")
    monkeypatch.setattr(rag, "get_llm", lambda: llm)


def test_hinglish_question_is_translated_for_search(monkeypatch):
    _real_mode(monkeypatch, FakeListChatModel(responses=['"How many days of leave do I get?"\n']))
    try:
        assert query.to_search_query("mujhe kitni chhutti milti hai?") == "How many days of leave do I get?"
    finally:
        get_settings.cache_clear()


def test_follow_up_is_made_standalone(monkeypatch):
    _real_mode(monkeypatch, FakeListChatModel(responses=["How many days of paid leave do interns get?"]))
    history = [
        {"role": "user", "content": "How many days of annual leave do I get?"},
        {"role": "assistant", "content": "24 days [1]."},
    ]
    try:
        assert query.to_search_query("and for interns?", history) == "How many days of paid leave do interns get?"
    finally:
        get_settings.cache_clear()


def test_rewrite_failure_falls_back_to_original_question(monkeypatch):
    def broken():
        raise RuntimeError("503 UNAVAILABLE")

    get_settings.cache_clear()
    monkeypatch.setenv("FAKE_MODELS", "false")
    monkeypatch.setattr(rag, "get_llm", broken)
    try:
        assert query.to_search_query("mujhe kitni chhutti milti hai?") == "mujhe kitni chhutti milti hai?"
    finally:
        get_settings.cache_clear()


def test_labels_added_by_small_models_are_removed(monkeypatch):
    _real_mode(monkeypatch, FakeListChatModel(responses=["Search query: How many days of leave do I get?"]))
    try:
        assert query.to_search_query("mujhe kitni chhutti milti hai?") == "How many days of leave do I get?"
    finally:
        get_settings.cache_clear()


def test_new_topic_in_an_old_chat_is_not_rewritten():
    history = [
        {"role": "user", "content": "How fast must a SEV-1 incident get an incident commander?"},
        {"role": "assistant", "content": "Within 15 minutes [1]."},
    ]
    assert not query.needs_rewrite("What is the hotel cap per night?", history)
    assert query.to_search_query("What is the hotel cap per night?", history) == "What is the hotel cap per night?"


def test_real_follow_ups_are_detected():
    history = [{"role": "user", "content": "How many days of leave do I get?"}]
    for q in ["and for interns?", "what about SEV-2?", "Does it apply to contractors too?", "Why?"]:
        assert query.needs_rewrite(q, history), q
    assert not query.needs_rewrite("and for interns?", [])  # no history: nothing to resolve

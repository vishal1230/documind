"""Pure-logic tests: fusion, prompt building, citation parsing. No database needed."""

import uuid

from app.models import HashingEmbedder, WordOverlapReranker
from app.rag import NO_ANSWER, cited_source_numbers, format_context, format_history, generate_answer
from app.retrieval import RetrievedChunk, reciprocal_rank_fusion

DOC = uuid.uuid4()


def chunk(cid: int, content: str = "text", page: int | None = None) -> RetrievedChunk:
    return RetrievedChunk(cid, DOC, "doc.md", page, cid, content, 0.0)


def test_rrf_rewards_chunks_found_by_both_retrievers():
    vector = [chunk(1), chunk(2), chunk(3)]
    keyword = [chunk(3), chunk(4), chunk(1)]
    fused = reciprocal_rank_fusion([vector, keyword], k=60)
    ids = [c.chunk_id for c in fused]
    assert ids[:2] == [1, 3]  # in both lists -> ahead of chunks found by only one
    assert set(ids) == {1, 2, 3, 4}
    assert fused[0].score == 1 / 61 + 1 / 63


def test_rrf_handles_empty_lists():
    assert reciprocal_rank_fusion([[], []]) == []


def test_context_numbers_sources_and_shows_pages():
    ctx = format_context([chunk(1, "alpha", page=2), chunk(2, "beta")])
    assert '<source id="1" from="doc.md, page 2">' in ctx
    assert '<source id="2" from="doc.md">' in ctx


def test_history_keeps_last_turns_only():
    history = [{"role": "user", "content": f"q{i}"} for i in range(10)]
    text = format_history(history)
    assert "q9" in text and "q3" not in text


def test_cited_numbers_ignore_out_of_range():
    assert cited_source_numbers("A [1]. B [3][1]. C [9].", n_sources=3) == [1, 3]


def test_no_chunks_means_no_llm_call():
    assert generate_answer("anything?", []) == NO_ANSWER


def test_fake_llm_answer_has_citation():
    answer = generate_answer("How much leave?", [chunk(1, "24 days of annual leave")])
    assert cited_source_numbers(answer, 1) == [1]


def test_hashing_embedder_is_normalised_and_similar_for_shared_words():
    e = HashingEmbedder(64)
    a, b, c = e.embed_documents(["annual leave policy", "leave policy annual", "server firewall"])
    dot = lambda x, y: sum(i * j for i, j in zip(x, y, strict=False))  # noqa: E731
    assert abs(dot(a, a) - 1) < 1e-9
    assert dot(a, b) > dot(a, c)


def test_word_overlap_reranker_prefers_matching_passage():
    scores = WordOverlapReranker().score("annual leave days", ["24 days of annual leave", "firewall rules"])
    assert scores[0] > scores[1]


def test_llm_errors_become_actionable_messages():
    from app.rag import describe_llm_error

    assert "overloaded" in describe_llm_error(RuntimeError("503 UNAVAILABLE. high demand"))
    assert "quota" in describe_llm_error(RuntimeError("429 RESOURCE_EXHAUSTED"))
    assert "API key" in describe_llm_error(RuntimeError("400 API key not valid"))
    assert "not found" in describe_llm_error(RuntimeError("404 NOT_FOUND models/x"))
    assert describe_llm_error(ValueError("boom")).startswith("Generation failed: ValueError: boom")


def test_fallback_models_are_wrapped(monkeypatch):
    from app import rag
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("FAKE_MODELS", "false")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-real")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", '["fallback-model"]')
    try:
        llm = rag.get_llm()
        assert llm.__class__.__name__ == "RunnableWithFallbacks"
        assert llm.fallbacks[0].model.endswith("fallback-model")
    finally:
        get_settings.cache_clear()


def test_speed_settings_reach_the_gemini_client(monkeypatch):
    from app import rag
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("FAKE_MODELS", "false")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-real")
    monkeypatch.setenv("GEMINI_THINKING_BUDGET", "0")
    monkeypatch.setenv("LLM_TIMEOUT", "15")
    try:
        llm = rag.get_llm()
        assert llm.thinking_budget == 0
        assert llm.timeout == 15
    finally:
        get_settings.cache_clear()


def _real_llm_env(monkeypatch, **env):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("FAKE_MODELS", "false")
    for key in ("GEMINI_API_KEY", "GEMINI_FALLBACK_MODELS", "OLLAMA_MODEL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)


def test_local_ollama_model_is_the_last_fallback(monkeypatch):
    from app import rag
    from app.config import get_settings

    _real_llm_env(monkeypatch, GEMINI_API_KEY="test-key-not-real", OLLAMA_MODEL="qwen2.5:3b")
    try:
        llm = rag.get_llm()
        assert llm.fallbacks[-1].__class__.__name__ == "ChatOllama"
        assert llm.fallbacks[-1].model == "qwen2.5:3b"
    finally:
        get_settings.cache_clear()


def test_runs_offline_on_ollama_without_gemini_key(monkeypatch):
    from app import rag
    from app.config import get_settings

    _real_llm_env(monkeypatch, OLLAMA_MODEL="qwen2.5:3b")
    try:
        assert rag.get_llm().__class__.__name__ == "ChatOllama"
    finally:
        get_settings.cache_clear()


def test_no_llm_configured_raises(monkeypatch):
    import pytest

    from app import rag
    from app.config import get_settings

    _real_llm_env(monkeypatch)
    try:
        with pytest.raises(rag.MissingAPIKeyError):
            rag.get_llm()
    finally:
        get_settings.cache_clear()


def test_answer_comes_from_local_model_when_gemini_fails(monkeypatch):
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.runnables import RunnableLambda

    from app import rag
    from app.config import get_settings

    def overloaded(_):
        raise RuntimeError("503 UNAVAILABLE. This model is currently experiencing high demand.")

    _real_llm_env(monkeypatch, GEMINI_API_KEY="test-key-not-real", OLLAMA_MODEL="qwen2.5:3b")
    monkeypatch.setattr(rag, "_gemini", lambda model: RunnableLambda(overloaded))
    monkeypatch.setattr(rag, "_ollama", lambda model: FakeListChatModel(responses=["Local answer [1]."]))
    try:
        chunk = rag.RetrievedChunk(1, None, "handbook.md", None, 0, "Leave is 24 days.", 1.0)
        assert rag.generate_answer("How much leave?", [chunk]) == "Local answer [1]."
    finally:
        get_settings.cache_clear()

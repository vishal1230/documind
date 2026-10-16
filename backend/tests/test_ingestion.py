import pytest

from app.ingestion import (
    EmptyDocumentError,
    Page,
    UnsupportedFileError,
    chunk_pages,
    clean_text,
    extract_pages,
)


def test_markdown_is_one_page_without_number(handbook_bytes):
    pages = extract_pages("handbook.md", handbook_bytes)
    assert len(pages) == 1
    assert pages[0].number is None
    assert "24 days of paid annual leave" in pages[0].text


def test_pdf_keeps_page_numbers(policy_pdf_bytes):
    pages = extract_pages("policy.pdf", policy_pdf_bytes)
    assert [p.number for p in pages] == [1, 2, 3]
    assert "14 characters" in pages[0].text


def test_unsupported_extension_rejected():
    with pytest.raises(UnsupportedFileError):
        extract_pages("photo.png", b"\x89PNG")


def test_empty_text_rejected():
    with pytest.raises(EmptyDocumentError):
        extract_pages("blank.txt", b"   \n\n  ")


def test_clean_text_rejoins_hyphenated_words_and_strips_control_chars():
    assert clean_text("multi-\nfactor\x7f   auth") == "multifactor auth"


def test_chunks_respect_size_and_overlap():
    text = " ".join(f"Sentence number {i} talks about leave policy." for i in range(200))
    chunks = chunk_pages([Page(1, text)], chunk_size=300, chunk_overlap=60)
    assert len(chunks) > 5
    assert all(len(c.content) <= 300 for c in chunks)
    assert [c.index for c in chunks] == list(range(len(chunks)))
    # neighbouring chunks share some text because of the overlap
    tail = chunks[0].content[-30:]
    assert tail.split()[-1] in chunks[1].content


def test_chunks_carry_their_page_number():
    pages = [Page(1, "Page one text. " * 30), Page(2, "Page two text. " * 30)]
    chunks = chunk_pages(pages, chunk_size=200, chunk_overlap=20)
    assert {c.page for c in chunks} == {1, 2}
    assert all("two" in c.content for c in chunks if c.page == 2)

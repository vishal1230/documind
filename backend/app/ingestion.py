"""Turning an uploaded file into chunks ready for embedding.

Pipeline: bytes -> pages of text -> cleaned text -> overlapping chunks (with page numbers).
"""

import io
import re
import unicodedata
from dataclasses import dataclass

from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

SUPPORTED_TYPES = {
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
}


class UnsupportedFileError(ValueError):
    pass


class EmptyDocumentError(ValueError):
    pass


@dataclass
class Page:
    number: int | None  # 1-based page number for PDFs, None for text files
    text: str


@dataclass
class TextChunk:
    index: int
    page: int | None
    content: str


def file_extension(filename: str) -> str:
    match = re.search(r"\.[A-Za-z0-9]+$", filename)
    return match.group(0).lower() if match else ""


def extract_pages(filename: str, data: bytes) -> list[Page]:
    """Extract text page by page so every chunk can cite its page number."""
    ext = file_extension(filename)
    if ext not in SUPPORTED_TYPES:
        raise UnsupportedFileError(f"Unsupported file type '{ext or filename}'. Use PDF, Markdown or TXT.")

    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        pages = [Page(number=i + 1, text=page.extract_text() or "") for i, page in enumerate(reader.pages)]
    else:
        pages = [Page(number=None, text=data.decode("utf-8", errors="replace"))]

    pages = [Page(p.number, clean_text(p.text)) for p in pages]
    if not any(p.text for p in pages):
        # A scanned PDF has images, not text. OCR (the ScanSense project) would fix this.
        raise EmptyDocumentError("No extractable text found. Is this a scanned PDF?")
    return pages


def clean_text(text: str) -> str:
    """Normalise whitespace that PDF extraction tends to mangle."""
    # drop control characters (PDF bullets often extract as \x7f or similar), keep newlines/tabs
    text = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    text = re.sub(r"-\n(\w)", r"\1", text)  # re-join words hyphenated across line breaks
    text = re.sub(r"[ \t]+", " ", text)  # collapse runs of spaces/tabs
    text = re.sub(r"\n{3,}", "\n\n", text)  # keep paragraph breaks, drop extra blank lines
    return text.strip()


def chunk_pages(pages: list[Page], chunk_size: int, chunk_overlap: int) -> list[TextChunk]:
    """Split each page into overlapping chunks.

    RecursiveCharacterTextSplitter tries to break on paragraph breaks first, then lines,
    then sentences, then words, so chunks rarely cut a sentence in half. The overlap keeps
    a little context from the previous chunk, which helps when an answer straddles a boundary.
    Chunking per page (instead of the whole document) guarantees each chunk has one page number.
    """
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks: list[TextChunk] = []
    for page in pages:
        for piece in splitter.split_text(page.text):
            piece = piece.strip()
            if len(piece) < 20:  # skip fragments like lone page numbers
                continue
            chunks.append(TextChunk(index=len(chunks), page=page.number, content=piece))
    if not chunks:
        raise EmptyDocumentError("The document produced no usable text chunks.")
    return chunks

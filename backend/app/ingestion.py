"""Turning an uploaded file into chunks ready for embedding.

Pipeline: bytes -> pages of text -> cleaned text -> overlapping chunks (with page numbers).
"""

import io
import re
import unicodedata
from dataclasses import dataclass

from langchain_text_splitters import RecursiveCharacterTextSplitter
from PIL import Image
from pypdf import PdfReader

from app import ocr
from app.config import get_settings

SUPPORTED_TYPES = {
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    # Photos/scans of documents: read with OCR
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}


class UnsupportedFileError(ValueError):
    pass


class EmptyDocumentError(ValueError):
    pass


@dataclass
class Page:
    number: int | None  # 1-based page number for PDFs, None for text files
    text: str
    ocr: bool = False  # text was read from an image by OCR


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
        raise UnsupportedFileError(
            f"Unsupported file type '{ext or filename}'. Use PDF, Markdown, TXT or an image (PNG/JPG)."
        )

    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        pages = [Page(number=i + 1, text=clean_text(page.extract_text() or "")) for i, page in enumerate(reader.pages)]
        pages = _ocr_scanned_pages(data, pages)
    elif ext in IMAGE_TYPES:
        pages = [Page(number=1, text=clean_text(_ocr_image(data)), ocr=True)]
    else:
        pages = [Page(number=None, text=clean_text(data.decode("utf-8", errors="replace")))]

    if not any(p.text for p in pages):
        raise EmptyDocumentError("No readable text found in this file (even with OCR).")
    return pages


def _ocr_scanned_pages(pdf_bytes: bytes, pages: list[Page]) -> list[Page]:
    """Re-read pages that have (almost) no text layer, i.e. scanned pages, with OCR."""
    s = get_settings()
    scanned = [i for i, p in enumerate(pages) if len(p.text) < s.ocr_min_chars]
    if not scanned or not s.ocr_enabled:
        return pages
    if len(scanned) > s.ocr_max_pages:
        raise EmptyDocumentError(
            f"This scan has {len(scanned)} pages without text; OCR is limited to {s.ocr_max_pages}."
        )
    try:
        for i in scanned:
            pages[i] = Page(pages[i].number, clean_text(ocr.read_pdf_page(pdf_bytes, i)), ocr=True)
    except ocr.OcrUnavailableError as e:
        if not any(p.text for p in pages):
            raise EmptyDocumentError(f"This looks like a scanned PDF. {e}") from e
    return pages


def _ocr_image(data: bytes) -> str:
    if not get_settings().ocr_enabled:
        raise EmptyDocumentError("Images need OCR, which is turned off (OCR_ENABLED=false).")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as e:
        raise EmptyDocumentError("This image could not be opened.") from e
    try:
        return ocr.read_image(image)
    except ocr.OcrUnavailableError as e:
        raise EmptyDocumentError(str(e)) from e


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

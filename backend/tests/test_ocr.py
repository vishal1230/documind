"""OCR: scanned PDFs (pages that are only pictures) and photos of documents become searchable text."""

import io

import pytest
from PIL import Image, ImageDraw, ImageFont

from app import ocr
from app.ingestion import extract_pages

pytestmark = pytest.mark.skipif(not ocr.available_languages(), reason="Tesseract OCR is not installed")

LINES = [
    "Northwind Travel Policy",
    "Hotel stays are capped at INR 6,000 per night.",
    "Taxi receipts must be submitted within 30 days.",
]


def page_image() -> Image.Image:
    """A white 'scanned' page with printed text (no text layer, just pixels)."""
    img = Image.new("RGB", (1700, 900), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=44)
    for i, line in enumerate(LINES):
        draw.text((80, 100 + i * 120), line, fill="black", font=font)
    return img


def as_bytes(img: Image.Image, fmt: str) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, resolution=200.0) if fmt == "PDF" else img.save(buf, format=fmt)
    return buf.getvalue()


def test_scanned_pdf_is_read_with_ocr():
    pages = extract_pages("scan.pdf", as_bytes(page_image(), "PDF"))
    assert pages[0].ocr and pages[0].number == 1
    text = pages[0].text.lower()
    assert "hotel stays" in text and "6,000" in text and "30 days" in text


def test_photo_of_a_document_is_read_with_ocr():
    pages = extract_pages("photo.jpg", as_bytes(page_image(), "JPEG"))
    assert pages[0].ocr and "taxi receipts" in pages[0].text.lower()


def test_upload_reports_ocr_pages(client):
    res = client.post("/documents", files={"file": ("scan.pdf", as_bytes(page_image(), "PDF"), "application/pdf")})
    assert res.status_code == 201
    assert res.json()["ocr_pages"] == 1 and res.json()["num_chunks"] >= 1
    hits = client.post("/search", json={"query": "hotel night cap", "mode": "keyword"}).json()
    assert hits and "6,000" in hits[0]["content"]

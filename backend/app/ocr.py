"""OCR (optical character recognition): read text from scanned PDFs and photos of documents.

Many real PDFs are scans: each page is just a picture, so there is no text to extract and
DocuMind used to reject them. Now, when a PDF page has (almost) no text layer, we render that
page to an image with pdfium (Chrome's PDF engine, via pypdfium2) and read it with Tesseract,
the open-source OCR engine. English and Hindi (Devanagari) are enabled by default.
Images (.png/.jpg) go straight to Tesseract.
"""

import logging
from functools import lru_cache

from PIL import Image, ImageOps

from app.config import get_settings

log = logging.getLogger("documind")


class OcrUnavailableError(RuntimeError):
    pass


@lru_cache
def available_languages() -> frozenset[str]:
    """Languages Tesseract can read here; empty if Tesseract isn't installed."""
    try:
        import pytesseract

        return frozenset(pytesseract.get_languages(config=""))
    except Exception:
        return frozenset()


def ocr_languages() -> str:
    """The configured languages that are actually installed, e.g. "eng+hin"."""
    have = available_languages()
    if not have:
        raise OcrUnavailableError("OCR is not available: Tesseract is not installed on the server.")
    wanted = [lang for lang in get_settings().ocr_languages.split("+") if lang in have]
    return "+".join(wanted or ["eng"])


def prepare(image: Image.Image) -> Image.Image:
    """Grayscale, upright (phone photos store rotation in EXIF) and not too small for Tesseract."""
    image = ImageOps.exif_transpose(image).convert("L")
    if min(image.size) < 1000:  # Tesseract reads small text badly; upscale low-resolution images
        factor = 1000 / min(image.size)
        image = image.resize((int(image.width * factor), int(image.height * factor)), Image.LANCZOS)
    return image


def read_image(image: Image.Image) -> str:
    import pytesseract

    # --psm 3: fully automatic page segmentation (columns, paragraphs, headings)
    return pytesseract.image_to_string(prepare(image), lang=ocr_languages(), config="--psm 3")


def read_pdf_page(pdf_bytes: bytes, page_index: int) -> str:
    """Render one PDF page to an image and OCR it."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        dpi = get_settings().ocr_dpi
        image = pdf[page_index].render(scale=dpi / 72).to_pil()  # PDF units are 1/72 inch
    finally:
        pdf.close()
    return read_image(image)

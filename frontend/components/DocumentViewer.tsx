"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, apiFetch, type Source } from "@/lib/api";
import { findRange, normalizeWithMap } from "@/lib/highlight";
import { IconButton } from "./ui/Button";
import { Icon } from "./ui/Icon";

type Props = { source: Source; onClose: () => void };

/**
 * Side panel that opens the original document at the cited place and highlights the passage.
 * PDFs are rendered with pdf.js (canvas + highlight boxes from the PDF's text layer);
 * Markdown/TXT files are shown as text with the passage marked.
 */
export default function DocumentViewer({ source, onClose }: Props) {
  const name = source.filename.toLowerCase();
  const isPdf = name.endsWith(".pdf");
  const isImage = /\.(png|jpe?g|webp)$/.test(name);
  const url = `${API_URL}/documents/${source.document_id}/file`;

  const closeRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Modal behaviour: focus moves into the panel, Escape closes, Tab stays inside, focus returns afterwards.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !panel.current) return;
      const els = Array.from(
        panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex='0']"),
      ).filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      if (e.shiftKey && document.activeElement === els[0]) {
        e.preventDefault();
        els[els.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === els[els.length - 1]) {
        e.preventDefault();
        els[0].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-ink/30" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        className="relative flex h-full w-full max-w-3xl animate-slide-in-right flex-col border-l border-line bg-surface shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="viewer-title"
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="flex h-5 min-w-5 items-center justify-center rounded-[4px] bg-accent-soft px-1 text-[11px] font-semibold tabular-nums text-accent">
            {source.number}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="viewer-title" className="truncate text-sm font-semibold" title={source.filename}>
              {source.filename}
            </h2>
            <p className="text-2xs text-muted">
              Source {source.number}
              {source.page ? ` · cited on page ${source.page}` : ""}
            </p>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <Icon name="external" size={15} />
            <span className="hidden sm:inline">Open file</span>
            <span className="sr-only sm:hidden">Open file in a new tab</span>
          </a>
          <IconButton ref={closeRef} icon="x" label="Close viewer" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-sunken">
          {isPdf ? (
            <PdfView url={url} source={source} />
          ) : isImage ? (
            <ImageView url={url} source={source} />
          ) : (
            <TextView url={url} source={source} />
          )}
        </div>
      </div>
    </div>
  );
}

function fileError(res: Response): string | null {
  if (res.ok) return null;
  return res.status === 404 ? "The original file isn't stored. Upload it again to view it here." : `${res.status} ${res.statusText}`;
}

function TextView({ url, source }: { url: string; source: Source }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mark = useRef<HTMLElement>(null);

  useEffect(() => {
    apiFetch(url)
      .then(async (res) => {
        const problem = fileError(res);
        if (problem) setError(problem);
        else setText(await res.text());
      })
      .catch((e) => setError((e as Error).message));
  }, [url]);

  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center" });
  }, [text]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (text === null) return <Loading label="Loading document" />;

  const range = findRange(text, source.content);
  return (
    <div className="mx-auto my-4 max-w-2xl rounded-lg border border-line bg-surface p-6 sm:my-6 sm:p-8">
      {!range && <p className="mb-4 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning">Couldn&apos;t locate the exact passage, so the whole file is shown.</p>}
      <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink-2">
        {range ? (
          <>
            {text.slice(0, range[0])}
            <mark ref={mark} tabIndex={-1} className="rounded-sm bg-mark px-0.5 text-ink shadow-[0_0_0_2px_var(--color-mark)]">
              {text.slice(range[0], range[1])}
            </mark>
            {text.slice(range[1])}
          </>
        ) : (
          text
        )}
      </pre>
    </div>
  );
}

type Box = { left: number; top: number; width: number; height: number };

function PdfView({ url, source }: { url: string; source: Source }) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(source.page ?? 1);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Load pdf.js only in the browser, and the document once.
  useEffect(() => {
    let cancelled = false;
    let loading: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const res = await apiFetch(url);
        const problem = fileError(res);
        if (problem) return setError(problem);
        // The "legacy" build includes polyfills for very new JavaScript features that pdf.js 6 uses
        // (e.g. Map.getOrInsertComputed), so it works in every current browser, not just the newest.
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        loading = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) });
        const loaded = await loading.promise;
        if (!cancelled) setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(`Could not open the PDF: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      loading?.destroy(); // frees the worker and the parsed document
    };
  }, [url]);

  // Render the current page to fit the panel width, then compute highlight boxes on the cited page.
  useEffect(() => {
    if (!doc || !canvas.current || !container.current) return;
    let task: import("pdfjs-dist").RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(2, (container.current!.clientWidth - 32) / base.width);
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      task = p.render({
        canvas: c,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      try {
        await task.promise;
      } catch {
        return; // cancelled because the page changed or the panel closed
      }
      if (cancelled) return;

      if (page !== source.page) return setBoxes([]);
      // Join the page's text items into one string, remembering which item each character came from.
      const content = await p.getTextContent();
      const items = content.items.filter((it): it is import("pdfjs-dist/types/src/display/api").TextItem => "str" in it);
      let pageText = "";
      const owner: number[] = [];
      items.forEach((it, idx) => {
        for (let k = 0; k < it.str.length; k++) owner.push(idx);
        pageText += it.str;
        owner.push(-1); // separator between items
        pageText += " ";
      });
      const range = findRange(pageText, source.content);
      if (!range) {
        setNotFound(true);
        return setBoxes([]);
      }
      setNotFound(false);
      const hit = new Set<number>();
      for (let i = range[0]; i < range[1]; i++) if (owner[i] >= 0) hit.add(owner[i]);
      const found: Box[] = [];
      for (const idx of hit) {
        const it = items[idx];
        if (!normalizeWithMap(it.str).norm) continue; // skip pure whitespace/punctuation items
        const [, , , d, e, f] = it.transform;
        const height = it.height || Math.abs(d);
        // PDF coordinates start bottom-left; convert both corners to canvas pixels.
        const [x1, y1] = viewport.convertToViewportPoint(e, f);
        const [x2, y2] = viewport.convertToViewportPoint(e + it.width, f + height);
        found.push({
          left: Math.min(x1, x2),
          top: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        });
      }
      setBoxes(found);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, source]);

  // Bring the first highlight into view.
  useEffect(() => {
    if (!boxes.length || !container.current) return;
    container.current.scrollTo({ top: Math.max(0, boxes[0].top - 120), behavior: "smooth" });
  }, [boxes]);

  if (error) return <Notice tone="error">{error}</Notice>;

  return (
    <div ref={container} className="h-full overflow-auto overscroll-contain">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-center gap-2 border-b border-line bg-surface px-3 py-2 text-[13px]">
        <button
          onClick={() => setPage((n) => Math.max(1, n - 1))}
          disabled={!doc || page <= 1}
          aria-label="Previous page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink disabled:opacity-40"
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="min-w-24 text-center tabular-nums text-ink-2" aria-live="polite">
          Page {page} {doc ? `of ${doc.numPages}` : ""}
        </span>
        <button
          onClick={() => setPage((n) => Math.min(doc?.numPages ?? n, n + 1))}
          disabled={!doc || page >= (doc?.numPages ?? 1)}
          aria-label="Next page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink disabled:opacity-40"
        >
          <Icon name="chevronRight" size={16} />
        </button>
        {source.page && page !== source.page && (
          <button onClick={() => setPage(source.page!)} className="ml-1 font-medium text-accent hover:text-accent-hover hover:underline">
            Back to cited page {source.page}
          </button>
        )}
      </div>
      {!doc && <Loading label="Loading PDF" />}
      {notFound && page === source.page && (
        <p className="mx-auto mt-3 max-w-xl rounded-md bg-warning-soft px-3 py-2 text-center text-[13px] text-warning">
          Couldn't locate the exact passage on this page (scanned or unusual PDF text); showing page {page}.
        </p>
      )}
      <div className="relative mx-auto my-4 w-fit bg-white shadow-card ring-1 ring-line">
        <canvas ref={canvas} />
        {boxes.map((b, i) => (
          <span
            key={i}
            className="pointer-events-none absolute rounded-[2px] bg-[#ffd84d]/45 mix-blend-multiply"
            style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
          />
        ))}
      </div>
    </div>
  );
}

/** Photos/scans: show the image; the passage itself was read by OCR, so show that text alongside. */
function ImageView({ url, source }: { url: string; source: Source }) {
  const [error, setError] = useState(false);
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <div className="rounded-lg border border-line bg-surface p-4 text-sm">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Cited text, read by OCR</p>
        <p className="whitespace-pre-wrap rounded-md bg-mark/60 p-3 leading-relaxed text-ink">{source.content}</p>
      </div>
      {error ? (
        <Notice tone="error">The original image isn&apos;t stored. Upload it again to view it here.</Notice>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- served by our API, not a static asset
        <img src={url} alt={source.filename} onError={() => setError(true)} className="mx-auto max-w-full rounded-md shadow-card ring-1 ring-line" />
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "error"; children: React.ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className="m-6 flex items-start gap-2.5 rounded-lg border border-[#fecdca] bg-danger-soft px-4 py-3 text-sm text-ink">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-danger" />
      <p>{children}</p>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none" aria-hidden />
      {label}
    </p>
  );
}

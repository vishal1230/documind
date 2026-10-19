"use client";

import { useCallback, useRef, useState } from "react";
import { uploadDocumentWithProgress, type DocumentInfo } from "./api";

export const ACCEPTED = ".pdf,.md,.txt,.png,.jpg,.jpeg,.webp";
const ACCEPTED_EXT = ACCEPTED.split(",");
export const MAX_UPLOAD_MB = 15; // the backend default (MAX_UPLOAD_MB); shown as a hint, the server enforces it

export type UploadStatus = "queued" | "uploading" | "indexing" | "done" | "duplicate" | "error";

export type UploadItem = {
  key: number;
  name: string;
  size: number;
  status: UploadStatus;
  progress: number; // real fraction of bytes sent, 0..1
  result?: DocumentInfo;
  error?: string;
};

type Callbacks = {
  onIndexed: () => void; // refresh the document list
  notify: (message: string, tone: "success" | "error" | "neutral") => void;
};

/**
 * Upload queue shared by the sidebar and the empty state. Files go one at a time, and every
 * status shown comes from the request itself: bytes sent, then "indexing" while the server works,
 * then the server's answer. Nothing is simulated.
 */
export function useUploads({ onIndexed, notify }: Callbacks) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const nextKey = useRef(1);
  const running = useRef(false);
  const queue = useRef<{ key: number; file: File }[]>([]);
  const cb = useRef({ onIndexed, notify });
  cb.current = { onIndexed, notify };

  const patch = (key: number, p: Partial<UploadItem>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...p } : it)));

  const dismiss = useCallback((key: number) => setItems((list) => list.filter((it) => it.key !== key)), []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const { key, file } = queue.current.shift()!;
      patch(key, { status: "uploading" });
      try {
        const doc = await uploadDocumentWithProgress(file, (fraction) =>
          patch(key, fraction >= 1 ? { progress: 1, status: "indexing" } : { progress: fraction }),
        );
        patch(key, { status: doc.duplicate ? "duplicate" : "done", progress: 1, result: doc });
        if (doc.duplicate) cb.current.notify(`${file.name} is already in your library.`, "neutral");
        else {
          const ocr = doc.ocr_pages ? `, ${doc.ocr_pages} page${doc.ocr_pages > 1 ? "s" : ""} read with OCR` : "";
          cb.current.notify(`Indexed ${file.name} (${doc.num_chunks} chunks${ocr}).`, "success");
        }
        cb.current.onIndexed();
        window.setTimeout(() => dismiss(key), 4000);
      } catch (e) {
        patch(key, { status: "error", error: (e as Error).message });
        cb.current.notify(`Couldn't upload ${file.name}: ${(e as Error).message}`, "error");
      }
    }
    running.current = false;
  }, [dismiss]);

  const upload = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const list = Array.from(files);
      if (!list.length) return;
      const added: UploadItem[] = [];
      for (const file of list) {
        const key = nextKey.current++;
        const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
        if (!ACCEPTED_EXT.includes(ext)) {
          added.push({ key, name: file.name, size: file.size, status: "error", progress: 0, error: "Unsupported file type. Use PDF, Markdown, TXT, PNG, JPG or WebP." });
          continue;
        }
        added.push({ key, name: file.name, size: file.size, status: "queued", progress: 0 });
        queue.current.push({ key, file });
      }
      setItems((prev) => [...prev, ...added]);
      pump();
    },
    [pump],
  );

  const busy = items.some((it) => it.status === "queued" || it.status === "uploading" || it.status === "indexing");
  return { items, upload, dismiss, busy };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

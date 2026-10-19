"use client";

import { useRef, useState } from "react";
import { API_URL, deleteDocument, type DocumentInfo } from "@/lib/api";
import { ACCEPTED, MAX_UPLOAD_MB, formatBytes, type UploadItem } from "@/lib/useUploads";
import { Button, IconButton } from "./ui/Button";
import { useConfirm, useToast } from "./ui/Feedback";
import { Icon, fileIcon, fileKind } from "./ui/Icon";
import { Menu } from "./ui/Menu";

type Uploads = { items: UploadItem[]; upload: (files: FileList | null) => void; dismiss: (key: number) => void; busy: boolean };

type Props = {
  documents: DocumentInfo[] | null; // null while the first load is in flight
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOnly: (id: string) => void;
  onChanged: () => void;
  uploads: Uploads;
};

/** Upload area, upload status, document search and the document list in the sidebar. */
export default function DocumentPanel({ documents, selected, onToggle, onOnly, onChanged, uploads }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const confirm = useConfirm();
  const toast = useToast();

  async function remove(doc: DocumentInfo) {
    const ok = await confirm({
      title: "Delete document?",
      body: (
        <>
          <span className="font-medium text-ink">{doc.filename}</span> and its search index will be removed. Saved chats
          keep their text, but its citations can no longer be opened.
        </>
      ),
      confirmLabel: "Delete document",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteDocument(doc.id);
      toast(`Deleted ${doc.filename}.`, "neutral");
      onChanged();
    } catch (e) {
      toast(`Couldn't delete ${doc.filename}: ${(e as Error).message}`, "error");
    }
  }

  const q = filter.trim().toLowerCase();
  const shown = documents?.filter((d) => d.filename.toLowerCase().includes(q)) ?? [];

  return (
    <section aria-labelledby="docs-heading" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between px-1">
        <h2 id="docs-heading" className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
          Documents{documents ? <span className="ml-1.5 font-medium tabular-nums text-subtle">{documents.length}</span> : null}
        </h2>
      </div>

      <Button variant="secondary" icon="upload" className="w-full" onClick={() => input.current?.click()}>
        Upload documents
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          uploads.upload(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="px-1 text-2xs text-subtle">PDF, Markdown, TXT or image, up to {MAX_UPLOAD_MB} MB. Or drop files here.</p>

      {uploads.items.length > 0 && (
        <ul className="space-y-1.5" aria-label="Uploads">
          {uploads.items.map((it) => (
            <UploadRow key={it.key} item={it} onDismiss={() => uploads.dismiss(it.key)} />
          ))}
        </ul>
      )}

      {documents && documents.length > 3 && (
        <label className="relative block">
          <span className="sr-only">Search documents</span>
          <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder="Filter documents"
            className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-2 text-[13px] text-ink placeholder:text-subtle transition-colors duration-150 hover:border-line-strong focus:border-accent focus:outline-none"
          />
        </label>
      )}

      {documents === null ? (
        <ul className="space-y-1" aria-label="Loading documents">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-2.5 px-2 py-2">
              <span className="h-7 w-7 animate-pulse rounded-md bg-sunken" />
              <span className="flex-1 space-y-1.5">
                <span className="block h-2.5 w-3/4 animate-pulse rounded bg-sunken" />
                <span className="block h-2 w-1/3 animate-pulse rounded bg-sunken" />
              </span>
            </li>
          ))}
        </ul>
      ) : documents.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-muted">
          No documents yet. Upload a file to start asking questions.
        </p>
      ) : (
        <>
          {selected.size > 0 && (
            <p className="px-1 text-2xs text-muted">
              Searching {selected.size} of {documents.length}. Tick documents to change the scope.
            </p>
          )}
          <ul className="-mx-1 space-y-px" aria-label="Your documents">
            {shown.map((d) => {
              const on = selected.has(d.id);
              return (
                <li
                  key={d.id}
                  className={`group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 ${
                    on ? "bg-accent-soft" : "hover:bg-sunken"
                  }`}
                >
                  <input
                    id={`doc-${d.id}`}
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggle(d.id)}
                    className="peer sr-only"
                  />
                  <label
                    htmlFor={`doc-${d.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
                  >
                    <span
                      className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                        on ? "border-accent-line bg-surface text-accent" : "border-line bg-surface text-muted"
                      }`}
                    >
                      <Icon name={fileIcon(d.filename)} size={15} />
                      {on && (
                        <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-white ring-2 ring-accent-soft">
                          <Icon name="check" size={9} strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[13px] font-medium ${on ? "text-accent" : "text-ink"}`} title={d.filename}>
                        {d.filename}
                      </span>
                      <span className="block truncate text-2xs text-muted">
                        {fileKind(d.filename)}
                        {d.num_pages > 1 ? ` · ${d.num_pages} pages` : ""} · {d.num_chunks} chunks
                      </span>
                      <span className="sr-only">{on ? ", included in search scope" : ""}</span>
                    </span>
                  </label>
                  <Menu
                    items={[
                      { label: "Search only this document", icon: "target", onSelect: () => onOnly(d.id) },
                      ...(d.has_file !== false
                        ? [
                            {
                              label: "Open original",
                              icon: "external" as const,
                              onSelect: () => window.open(`${API_URL}/documents/${d.id}/file`, "_blank", "noopener"),
                            },
                          ]
                        : []),
                      { separator: true },
                      { label: "Delete", icon: "trash", danger: true, onSelect: () => remove(d) },
                    ]}
                    trigger={(p) => (
                      <IconButton
                        {...p}
                        icon="more"
                        label={`Actions for ${d.filename}`}
                        size="sm"
                        className="opacity-100 hover:bg-surface aria-expanded:bg-surface aria-expanded:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      />
                    )}
                  />
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-2 py-2 text-[13px] text-muted">No documents match “{filter}”.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

function UploadRow({ item, onDismiss }: { item: UploadItem; onDismiss: () => void }) {
  const status =
    item.status === "queued"
      ? "Waiting"
      : item.status === "uploading"
        ? `Uploading ${Math.round(item.progress * 100)}%`
        : item.status === "indexing"
          ? "Extracting and indexing"
          : item.status === "done"
            ? `Indexed · ${item.result?.num_chunks ?? 0} chunks${item.result?.ocr_pages ? ` · OCR on ${item.result.ocr_pages} page${item.result.ocr_pages > 1 ? "s" : ""}` : ""}`
            : item.status === "duplicate"
              ? "Already in your library"
              : item.error;
  const failed = item.status === "error";
  const finished = item.status === "done" || item.status === "duplicate";
  return (
    <li
      className={`animate-rise-in rounded-md border px-2.5 py-2 ${failed ? "border-[#fecdca] bg-danger-soft" : "border-line bg-surface"}`}
    >
      <div className="flex items-center gap-2">
        <Icon
          name={failed ? "alert" : finished ? "check" : fileIcon(item.name)}
          size={15}
          className={failed ? "text-danger" : finished ? "text-success" : "text-muted"}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={item.name}>
          {item.name}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-subtle">{formatBytes(item.size)}</span>
        {(failed || finished) && <IconButton icon="x" label={`Dismiss ${item.name}`} size="sm" className="-my-1 -mr-1" onClick={onDismiss} />}
      </div>
      <p role={failed ? "alert" : "status"} className={`mt-0.5 text-2xs ${failed ? "text-danger" : "text-muted"}`}>
        {status}
      </p>
      {(item.status === "uploading" || item.status === "indexing") && (
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-label={`${item.name} ${item.status === "uploading" ? "upload" : "indexing"} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.status === "uploading" ? Math.round(item.progress * 100) : undefined}
        >
          {item.status === "uploading" ? (
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${item.progress * 100}%` }} />
          ) : (
            // The server doesn't report indexing progress, so this bar is indeterminate, not a fake percentage.
            <div className="h-full w-2/5 animate-indeterminate rounded-full bg-accent/70" />
          )}
        </div>
      )}
    </li>
  );
}

"use client";

import { useRef, useState } from "react";
import { deleteDocument, uploadDocument, type DocumentInfo } from "@/lib/api";

type Props = {
  documents: DocumentInfo[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onChanged: () => void;
};

export default function DocumentPanel({ documents, selected, onToggle, onChanged }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMessage(null);
    try {
      for (const file of Array.from(files)) {
        const doc = await uploadDocument(file);
        setMessage(doc.duplicate ? `${file.name} was already indexed` : `Indexed ${file.name} (${doc.num_chunks} chunks)`);
      }
      onChanged();
    } catch (e) {
      setMessage(`Upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function handleDelete(doc: DocumentInfo) {
    if (!window.confirm(`Delete ${doc.filename} and its index?`)) return;
    await deleteDocument(doc.id);
    onChanged();
  }

  return (
    <aside className="flex h-full flex-col gap-4 border-r border-gray-200 bg-white p-4">
      <div>
        <h1 className="text-xl font-semibold">DocuMind</h1>
        <p className="text-sm text-gray-500">Chat with your documents, with citations.</p>
      </div>

      <label
        className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-gray-300 p-4 text-center text-sm hover:border-accent"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
      >
        <span className="font-medium">{busy ? "Indexing…" : "Upload PDF, Markdown or TXT"}</span>
        <span className="text-gray-500">Click or drop files here</span>
        <input
          ref={input}
          type="file"
          accept=".pdf,.md,.txt"
          multiple
          className="hidden"
          disabled={busy}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </label>
      {message && <p className="text-sm text-gray-600">{message}</p>}

      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Documents ({documents.length})
        </h2>
        <p className="mb-2 text-xs text-gray-500">
          {selected.size ? `Searching ${selected.size} selected` : "Searching all documents"}
        </p>
        <ul className="flex-1 space-y-1 overflow-y-auto">
          {documents.map((d) => (
            <li key={d.id} className="group flex items-start gap-2 rounded-md p-2 hover:bg-gray-50">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(d.id)}
                onChange={() => onToggle(d.id)}
                aria-label={`Limit search to ${d.filename}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={d.filename}>
                  {d.filename}
                </p>
                <p className="text-xs text-gray-500">
                  {d.num_pages > 1 ? `${d.num_pages} pages · ` : ""}
                  {d.num_chunks} chunks
                </p>
              </div>
              <button
                onClick={() => handleDelete(d)}
                className="text-xs text-gray-400 opacity-0 hover:text-red-600 group-hover:opacity-100"
                aria-label={`Delete ${d.filename}`}
              >
                Delete
              </button>
            </li>
          ))}
          {!documents.length && <li className="text-sm text-gray-500">No documents yet.</li>}
        </ul>
      </div>
    </aside>
  );
}

"use client";

import { useState } from "react";
import type { Source } from "@/lib/api";

/** Renders answer text, turning [n] markers into clickable citation badges. */
export function AnswerText({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (!m) return <span key={i}>{part}</span>;
        const n = Number(m[1]);
        return (
          <button
            key={i}
            onClick={() => onCite(n)}
            className="mx-0.5 rounded bg-accent-soft px-1.5 text-xs font-semibold text-accent align-super hover:bg-accent hover:text-white"
            title={`Show source ${n}`}
          >
            {n}
          </button>
        );
      })}
    </p>
  );
}

export function SourceList({ sources, cited, highlight }: { sources: Source[]; cited: number[]; highlight: number | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open ?? highlight;
  if (!sources.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Sources</p>
      {sources.map((s) => (
        <div
          key={s.chunk_id}
          className={`rounded-md border text-sm ${shown === s.number ? "border-accent" : "border-gray-200"} bg-white`}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            onClick={() => setOpen(shown === s.number ? -1 : s.number)}
          >
            <span className="rounded bg-accent-soft px-1.5 text-xs font-semibold text-accent">{s.number}</span>
            <span className="truncate font-medium">{s.filename}</span>
            {s.page && <span className="text-gray-500">p. {s.page}</span>}
            {cited.includes(s.number) && <span className="ml-auto text-xs text-green-700">cited</span>}
          </button>
          {shown === s.number && (
            <p className="whitespace-pre-wrap border-t border-gray-100 px-3 py-2 text-gray-700">{s.content}</p>
          )}
        </div>
      ))}
    </div>
  );
}

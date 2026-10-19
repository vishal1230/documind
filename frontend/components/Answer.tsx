"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Source } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { Icon, fileIcon } from "./ui/Icon";

/** Inline [n] marker in an answer. Keyboard focusable; names the source it points to. */
export function CitationChip({
  n,
  source,
  active,
  onClick,
}: {
  n: number;
  source?: Source;
  active: boolean;
  onClick: () => void;
}) {
  if (!source) return <span className="text-subtle">[{n}]</span>; // marker without a matching source
  const where = `${source.filename}${source.page ? `, page ${source.page}` : ""}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Citation ${n}: ${where}`}
      title={where}
      className={`mx-[1px] inline-flex h-[1.15rem] min-w-[1.15rem] -translate-y-[1px] items-center justify-center rounded-[4px] border px-1 align-middle text-[11px] font-semibold tabular-nums leading-none transition-colors duration-150 ${
        active
          ? "border-accent bg-accent text-white"
          : "border-accent-line bg-accent-soft text-accent hover:border-accent hover:bg-accent hover:text-white"
      }`}
    >
      {n}
    </button>
  );
}

/** Answer body: Markdown with clickable citations and an optional streaming caret. */
export function AnswerText({
  text,
  sources,
  activeCitation,
  onCite,
  streaming,
}: {
  text: string;
  sources: Source[];
  activeCitation: number | null;
  onCite: (n: number) => void;
  streaming?: boolean;
}) {
  return (
    <Markdown
      text={text}
      trailing={streaming ? <span className="stream-caret" aria-hidden /> : null}
      renderCitation={(n) => (
        <CitationChip n={n} source={sources.find((s) => s.number === n)} active={activeCitation === n} onClick={() => onCite(n)} />
      )}
    />
  );
}

type SourceListProps = {
  sources: Source[];
  cited: number[];
  done: boolean; // answer finished, so `cited` is final
  focus: { n: number; tick: number } | null; // citation the user just clicked (tick lets the same one be clicked again)
  onOpen: (source: Source) => void; // open the original document at this passage
};

/**
 * Sources behind an answer. Cited passages are listed first; passages that were retrieved but not
 * cited sit behind a toggle so the evidence the answer actually used stays easy to scan.
 */
export function SourceList({ sources, cited, done, focus, onOpen }: SourceListProps) {
  const active = focus?.n ?? null;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const refs = useRef(new Map<number, HTMLLIElement>());

  const citedSet = new Set(cited);
  const primary = done ? sources.filter((s) => citedSet.has(s.number)) : sources;
  const others = done ? sources.filter((s) => !citedSet.has(s.number)) : [];

  // Clicking a [n] marker opens that source and brings it into view.
  useEffect(() => {
    if (active == null) return;
    if (!citedSet.has(active) && done) setShowAll(true);
    setExpanded((prev) => new Set(prev).add(active));
    requestAnimationFrame(() => {
      const el = refs.current.get(active);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  if (!sources.length) return null;

  const toggle = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const row = (s: Source) => {
    const open = expanded.has(s.number);
    const isActive = active === s.number;
    const panelId = `${listId}-${s.number}`;
    return (
      <li
        key={s.chunk_id}
        ref={(el) => {
          if (el) refs.current.set(s.number, el);
          else refs.current.delete(s.number);
        }}
        className={`rounded-lg border bg-surface transition-[border-color,box-shadow] duration-200 ${
          isActive ? "border-accent-line shadow-[0_0_0_3px_var(--color-accent-soft)]" : "border-line"
        }`}
      >
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => toggle(s.number)}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left"
          >
            <span className="flex h-5 min-w-5 items-center justify-center rounded-[4px] bg-accent-soft px-1 text-[11px] font-semibold tabular-nums text-accent">
              {s.number}
            </span>
            <Icon name={fileIcon(s.filename)} size={14} className="shrink-0 text-subtle" />
            <span className="min-w-0 truncate text-[13px] font-medium text-ink">{s.filename}</span>
            {s.page && <span className="shrink-0 text-[12px] tabular-nums text-muted">p. {s.page}</span>}
            <Icon
              name="chevronDown"
              size={15}
              className={`ml-auto shrink-0 text-subtle transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          </button>
        </div>
        {open && (
          <div id={panelId} className="animate-fade-in border-t border-line px-3 pb-3 pt-2.5">
            <p className="whitespace-pre-wrap border-l-2 border-accent-line pl-3 text-[13px] leading-relaxed text-ink-2">{s.content}</p>
            <button
              type="button"
              onClick={() => onOpen(s)}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-accent hover:text-accent-hover hover:underline"
            >
              <Icon name="eye" size={15} />
              Open in viewer{s.page ? ` at page ${s.page}` : ""}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="mt-5">
      <h3 className="mb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
        Sources
        <span className="font-medium normal-case tracking-normal text-subtle">
          {done ? `${primary.length} cited` : `${sources.length} retrieved`}
        </span>
      </h3>
      {primary.length > 0 && <ul className="space-y-1.5">{primary.map(row)}</ul>}
      {others.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className={`inline-flex items-center gap-1 rounded-md text-[13px] text-muted hover:text-ink ${primary.length ? "mt-2" : ""}`}
          >
            <Icon name="chevronRight" size={14} className={`transition-transform duration-200 ${showAll ? "rotate-90" : ""}`} />
            {showAll ? "Hide" : "Show"} {others.length} other retrieved passage{others.length === 1 ? "" : "s"}
          </button>
          {showAll && <ul className="mt-2 animate-fade-in space-y-1.5 opacity-90">{others.map(row)}</ul>}
        </>
      )}
    </div>
  );
}

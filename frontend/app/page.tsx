"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DocumentPanel from "@/components/DocumentPanel";
import { AnswerText, SourceList } from "@/components/Answer";
import { listDocuments, streamChat, type DocumentInfo, type Source, type Turn } from "@/lib/api";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  cited?: number[];
  streaming?: boolean;
  error?: string;
};

const EXAMPLES = [
  "How many days of annual leave do I get?",
  "What has to be true for a meter to pass SAT?",
  "How fast must a SEV-1 incident be handled?",
];

export default function Home() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [highlight, setHighlight] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDocuments(await listDocuments());
      setLoadError(null);
    } catch (e) {
      setLoadError(`Cannot reach the API: ${(e as Error).message}. Is the backend running?`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Update only the last (assistant) message while it streams.
  const patchLast = (patch: (m: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), patch(prev[prev.length - 1])]);

  async function ask(q: string) {
    if (!q.trim() || abort.current) return;
    const history: Turn[] = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "", streaming: true }]);
    setQuestion("");
    setHighlight(null);
    abort.current = new AbortController();
    try {
      await streamChat(
        { question: q, history, document_ids: selected.size ? [...selected] : undefined },
        {
          onSources: (sources) => patchLast((m) => ({ ...m, sources })),
          onToken: (text) => patchLast((m) => ({ ...m, content: m.content + text })),
          onDone: (cited) => patchLast((m) => ({ ...m, cited, streaming: false })),
          onError: (detail) => patchLast((m) => ({ ...m, error: detail, streaming: false })),
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") patchLast((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      abort.current = null;
    }
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const busy = messages.at(-1)?.streaming ?? false;

  return (
    <main className="grid h-screen grid-cols-1 md:grid-cols-[300px_1fr]">
      <div className="hidden md:block">
        <DocumentPanel documents={documents} selected={selected} onToggle={toggle} onChanged={refresh} />
      </div>

      <section className="flex h-full min-h-0 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {loadError && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{loadError}</p>}

            {!messages.length && (
              <div className="pt-16 text-center">
                <h2 className="text-2xl font-semibold">Ask your documents anything</h2>
                <p className="mt-2 text-gray-500">
                  Answers come only from your files, with numbered citations you can click.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => ask(ex)}
                      className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm hover:border-accent"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ml-auto max-w-[80%] rounded-2xl bg-accent px-4 py-2 text-white">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="rounded-2xl bg-white p-4 shadow-sm">
                  {m.content ? (
                    <div className={m.streaming ? "caret" : ""}>
                      <AnswerText text={m.content} onCite={setHighlight} />
                    </div>
                  ) : (
                    !m.error && <p className="caret text-gray-400">Searching your documents</p>
                  )}
                  {m.error && <p className="mt-2 text-sm text-red-600">{m.error}</p>}
                  {m.sources && (
                    <SourceList
                      sources={m.sources}
                      cited={m.cited ?? []}
                      highlight={i === messages.length - 1 ? highlight : null}
                    />
                  )}
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        <form
          className="border-t border-gray-200 bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
        >
          <div className="mx-auto flex max-w-3xl gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about your documents…"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-accent"
              maxLength={2000}
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abort.current?.abort()}
                className="rounded-lg border border-gray-300 px-4 py-2"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!question.trim()}
                className="rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
              >
                Ask
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}

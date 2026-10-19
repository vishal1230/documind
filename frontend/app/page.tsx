"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthScreen from "@/components/AuthScreen";
import ChatList from "@/components/ChatList";
import Composer from "@/components/Composer";
import DocumentPanel from "@/components/DocumentPanel";
import DocumentViewer from "@/components/DocumentViewer";
import Sidebar from "@/components/Sidebar";
import SpeakButton, { actionClass } from "@/components/SpeakButton";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { AnswerText, SourceList } from "@/components/Answer";
import { Button } from "@/components/ui/Button";
import { FeedbackProvider, useToast } from "@/components/ui/Feedback";
import { Icon } from "@/components/ui/Icon";
import { speak, speechSupported, stopSpeaking } from "@/lib/speech";
import { ACCEPTED, MAX_UPLOAD_MB, useUploads } from "@/lib/useUploads";
import {
  getConversation,
  getMe,
  logout,
  setUnauthorizedHandler,
  type User,
  listConversations,
  listDocuments,
  streamChat,
  type ConversationSummary,
  type DocumentInfo,
  type SavedMessage,
  type Source,
  type Turn,
  type VoiceLanguage,
} from "@/lib/api";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  searchQuery?: string;
  cited?: number[];
  streaming?: boolean;
  error?: string;
};

// Keep the open chat in the URL (?c=<id>) so a refresh or a shared link reopens it.
function setChatInUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id);
  else url.searchParams.delete("c");
  window.history.replaceState(null, "", url);
}

function fromSaved(m: SavedMessage): Message {
  return {
    role: m.role,
    content: m.content,
    sources: m.sources ?? undefined,
    cited: m.cited ?? undefined,
    searchQuery: m.search_query ?? undefined,
  };
}

// Questions that are known to work on the bundled sample documents.
const SAMPLE_QUESTIONS: { file: string; question: string }[] = [
  { file: "northwind_employee_handbook", question: "How many days of annual leave do I get?" },
  { file: "smart_meter_installation_sop", question: "What has to be true for a meter to pass SAT?" },
  { file: "acme_cloud_security_policy", question: "How fast must a SEV-1 incident be handled?" },
];

/** Example questions for the empty state: sample-doc questions when present, otherwise ones built from the user's own files. */
function exampleQuestions(docs: DocumentInfo[]): string[] {
  const names = docs.map((d) => d.filename.toLowerCase());
  const out = SAMPLE_QUESTIONS.filter((s) => names.some((n) => n.startsWith(s.file))).map((s) => s.question);
  for (const d of docs) {
    if (out.length >= 3) break;
    const name = d.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    const q = `What are the key points of ${name}?`;
    if (!SAMPLE_QUESTIONS.some((s) => d.filename.toLowerCase().startsWith(s.file))) out.push(q);
  }
  return out.slice(0, 3);
}

/** Shows the login screen until the user is logged in, then the chat app. */
export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null)); // session expired or logged out elsewhere
    getMe()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined)
    return (
      <div className="flex h-dvh items-center justify-center" role="status" aria-label="Loading">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none" />
      </div>
    );
  if (user === null) return <AuthScreen onLoggedIn={setUser} />;
  return (
    <FeedbackProvider>
      <ChatApp
        key={user.id}
        user={user}
        onLogout={async () => {
          await logout();
          setUser(null);
        }}
      />
    </FeedbackProvider>
  );
}

function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const toast = useToast();
  const [documents, setDocuments] = useState<DocumentInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [focus, setFocus] = useState<{ msg: number; n: number; tick: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoRead, setAutoRead] = useState(false);
  const [voiceLang, setVoiceLang] = useState<VoiceLanguage>("auto");
  const [canSpeak, setCanSpeak] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [viewing, setViewing] = useState<Source | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const docs = await listDocuments();
      setDocuments(docs);
      // forget selections of documents that no longer exist
      setSelected((prev) => new Set([...prev].filter((id) => docs.some((d) => d.id === id))));
      setLoadError(null);
    } catch (e) {
      setLoadError(`Can't reach the DocuMind API (${(e as Error).message}). Check that the backend is running.`);
      setDocuments((d) => d ?? []);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      setConversations((c) => c ?? []); // the documents call already reports API problems
    }
  }, []);

  // Upload status is shown in the sidebar; toasts only repeat it when the sidebar is out of view.
  const libraryVisible = useRef({ sidebarOpen: true, drawerOpen: false });
  libraryVisible.current = { sidebarOpen, drawerOpen };
  const uploads = useUploads({
    onIndexed: refresh,
    notify: (message, tone) => {
      const desktop = window.matchMedia("(min-width: 768px)").matches;
      const visible = desktop ? libraryVisible.current.sidebarOpen : libraryVisible.current.drawerOpen;
      if (!visible) toast(message, tone);
    },
  });

  const openConversation = useCallback(async (id: string) => {
    abort.current?.abort();
    stopSpeaking();
    setDrawerOpen(false);
    setOpening(true);
    try {
      const conv = await getConversation(id);
      setMessages(conv.messages.map(fromSaved));
      setConversationId(conv.id);
      setChatInUrl(conv.id);
      setFocus(null);
      stickToBottom.current = true;
    } catch {
      setChatInUrl(null); // deleted or unknown chat: start fresh
    } finally {
      setOpening(false);
    }
  }, []);

  const newChat = useCallback(() => {
    abort.current?.abort();
    stopSpeaking();
    setMessages([]);
    setConversationId(null);
    setChatInUrl(null);
    setFocus(null);
    setDrawerOpen(false);
    input.current?.focus();
  }, []);

  useEffect(() => {
    refresh();
    refreshChats();
    const saved = new URLSearchParams(window.location.search).get("c");
    if (saved) openConversation(saved);
    setCanSpeak(speechSupported());
    try {
      setAutoRead(localStorage.getItem("documind.autoRead") === "1");
      const lang = localStorage.getItem("documind.voiceLang");
      if (lang === "en" || lang === "hi" || lang === "auto") setVoiceLang(lang);
      if (localStorage.getItem("documind.sidebar") === "0") setSidebarOpen(false);
    } catch {
      /* storage blocked: keep defaults */
    }
  }, [refresh, refreshChats, openConversation]);

  function remember(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the setting lasts for this visit only */
    }
  }

  function toggleAutoRead(on: boolean) {
    setAutoRead(on);
    if (!on) stopSpeaking();
    remember("documind.autoRead", on ? "1" : "0");
  }

  function changeVoiceLang(lang: VoiceLanguage) {
    setVoiceLang(lang);
    remember("documind.voiceLang", lang);
  }

  function toggleSidebar() {
    setSidebarOpen((open) => {
      remember("documind.sidebar", open ? "0" : "1");
      return !open;
    });
  }

  // Voice input: put the recognised text in the box so it can be checked or edited, then sent.
  function onVoiceText(text: string) {
    setQuestion(text);
    input.current?.focus();
  }

  // Follow the streaming answer only while the reader is at the bottom; don't yank them back up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  // Update only the last (assistant) message while it streams.
  const patchLast = (patch: (m: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), patch(prev[prev.length - 1])]);

  async function ask(q: string, base: Message[] = messages) {
    if (!q.trim() || abort.current) return;
    const history: Turn[] = base.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages([...base, { role: "user", content: q }, { role: "assistant", content: "", streaming: true }]);
    setQuestion("");
    setFocus(null);
    stopSpeaking();
    stickToBottom.current = true;
    abort.current = new AbortController();
    let answer = "";
    try {
      await streamChat(
        {
          question: q,
          history,
          document_ids: selected.size ? [...selected] : undefined,
          conversation_id: conversationId,
        },
        {
          onConversation: ({ id }) => {
            setConversationId(id);
            setChatInUrl(id);
          },
          onQuery: (searchQuery) => patchLast((m) => ({ ...m, searchQuery })),
          onSources: (sources) => patchLast((m) => ({ ...m, sources })),
          onToken: (text) => {
            answer += text;
            patchLast((m) => ({ ...m, content: m.content + text }));
          },
          onDone: (cited) => {
            patchLast((m) => ({ ...m, cited, streaming: false }));
            if (autoRead) speak(answer);
          },
          onError: (detail) => patchLast((m) => ({ ...m, error: detail, streaming: false })),
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") patchLast((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      abort.current = null;
      refreshChats(); // new chat appears / moves to the top of the list
    }
  }

  // Ask the failed question again, replacing the failed exchange.
  function retryLast() {
    const q = messages.at(-2)?.content;
    if (q) ask(q, messages.slice(0, -2));
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Answer copied to the clipboard.", "success");
    } catch {
      toast("Couldn't copy: the browser blocked clipboard access.", "error");
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
  const docCount = documents?.length ?? 0;
  const scope =
    documents === null
      ? "Loading documents…"
      : docCount === 0
        ? "No documents yet"
        : selected.size
          ? `Searching ${selected.size} of ${docCount} document${docCount === 1 ? "" : "s"}`
          : docCount === 1
            ? "Searching your 1 document"
            : `Searching all ${docCount} documents`;
  const title = conversationId
    ? (conversations?.find((c) => c.id === conversationId)?.title ?? messages.find((m) => m.role === "user")?.content ?? "Chat")
    : messages.length
      ? (messages[0].content ?? "New chat")
      : "New chat";
  const examples = useMemo(() => exampleQuestions(documents ?? []), [documents]);

  const sidebarContent = (
    <>
      <DocumentPanel
        documents={documents}
        selected={selected}
        onToggle={toggle}
        onOnly={(id) => {
          setSelected(new Set([id]));
          setDrawerOpen(false);
        }}
        onChanged={refresh}
        uploads={uploads}
      />
      <ChatList
        conversations={conversations}
        activeId={conversationId}
        onSelect={openConversation}
        onNew={newChat}
        onChanged={refreshChats}
      />
    </>
  );

  // Drop files anywhere in the app to upload them.
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className="app-shell flex"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => isFileDrag(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        uploads.upload(e.dataTransfer.files);
      }}
    >
      <a
        href="#question"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to question box
      </a>

      {sidebarOpen && (
        <div className="hidden h-full shrink-0 md:block">
          <Sidebar variant="desktop" onClose={toggleSidebar}>
            {sidebarContent}
          </Sidebar>
        </div>
      )}
      {drawerOpen && (
        <Sidebar variant="drawer" onClose={() => setDrawerOpen(false)}>
          {sidebarContent}
        </Sidebar>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <WorkspaceHeader
          title={title}
          scope={scope}
          scoped={selected.size > 0}
          onClearScope={() => setSelected(new Set())}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onOpenDrawer={() => setDrawerOpen(true)}
          onNewChat={newChat}
          canStartNew={messages.length > 0 || conversationId !== null}
          user={user}
          onLogout={onLogout}
        />

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto w-full max-w-[760px] px-4 pb-10 pt-6 sm:px-6 sm:pt-10">
            {loadError && (
              <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg border border-[#fecdca] bg-danger-soft px-4 py-3 text-sm">
                <Icon name="alert" size={17} className="mt-px shrink-0 text-danger" />
                <p className="flex-1 text-ink">{loadError}</p>
                <button onClick={refresh} className="shrink-0 font-medium text-danger hover:underline">
                  Retry
                </button>
              </div>
            )}

            {opening && !messages.length && (
              <div className="space-y-3 pt-4" role="status" aria-label="Opening chat">
                <span className="ml-auto block h-9 w-2/5 animate-pulse rounded-lg bg-sunken" />
                <span className="block h-3 w-full animate-pulse rounded bg-sunken" />
                <span className="block h-3 w-5/6 animate-pulse rounded bg-sunken" />
              </div>
            )}

            {!messages.length && !opening && documents !== null && docCount === 0 && !loadError && (
              <section className="animate-rise-in pt-10 text-center sm:pt-20" aria-labelledby="empty-title">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-muted shadow-xs">
                  <Icon name="upload" size={20} />
                </span>
                <h2 id="empty-title" className="mt-5 text-xl font-semibold tracking-[-0.015em]">
                  Add your first document
                </h2>
                <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted">
                  DocuMind answers only from the files you upload, and every answer links back to the exact passage it used.
                </p>
                <div className="mt-6 flex flex-col items-center gap-2">
                  <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>
                    Upload documents
                  </Button>
                  <p className="text-[13px] text-subtle">
                    PDF, Markdown, TXT, PNG, JPG or WebP · up to {MAX_UPLOAD_MB} MB · or drag files anywhere
                  </p>
                </div>
                <input
                  ref={fileInput}
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
                {uploads.busy && (
                  <p role="status" className="mt-4 text-[13px] text-muted">
                    Uploading… progress is shown in the sidebar.
                  </p>
                )}
              </section>
            )}

            {!messages.length && !opening && docCount > 0 && (
              <section className="animate-rise-in pt-8 sm:pt-16" aria-labelledby="start-title">
                <h2 id="start-title" className="text-xl font-semibold tracking-[-0.015em] sm:text-2xl">
                  What would you like to know?
                </h2>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">
                  {selected.size
                    ? `Answers will come from the ${selected.size} selected document${selected.size === 1 ? "" : "s"}, with citations to the exact passages.`
                    : `Answers come from your ${docCount} document${docCount === 1 ? "" : "s"}, with citations to the exact passages.`}{" "}
                  You can ask in English, Hindi or Hinglish.
                </p>
                {examples.length > 0 && (
                  <div className="mt-8">
                    <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">Try asking</h3>
                    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                      {examples.map((ex) => (
                        <li key={ex}>
                          <button
                            onClick={() => ask(ex)}
                            className="group flex w-full items-center gap-3 px-4 py-3 text-left text-[14px] text-ink-2 transition-colors duration-150 hover:bg-canvas hover:text-ink"
                          >
                            <span className="flex-1">{ex}</span>
                            <Icon
                              name="chevronRight"
                              size={16}
                              className="shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            <div className="space-y-8" aria-live="off">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-sunken px-3.5 py-2 text-[15px] leading-relaxed text-ink">
                      <span className="sr-only">You asked: </span>
                      {m.content}
                    </p>
                  </div>
                ) : (
                  <article key={i} className="animate-fade-in" aria-label="Answer" aria-busy={m.streaming}>
                    {m.searchQuery && (
                      <p className="mb-2 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                        <Icon name="search" size={13} className="shrink-0" />
                        <span className="truncate">
                          Searched for <span className="text-ink-2">“{m.searchQuery}”</span>
                        </span>
                      </p>
                    )}
                    {m.content ? (
                      <AnswerText
                        text={m.content}
                        sources={m.sources ?? []}
                        streaming={m.streaming}
                        activeCitation={focus?.msg === i ? focus.n : null}
                        onCite={(n) => setFocus((f) => ({ msg: i, n, tick: (f?.tick ?? 0) + 1 }))}
                      />
                    ) : (
                      !m.error &&
                      m.streaming && (
                        <p className="flex items-center gap-2 text-[14px] text-muted" role="status">
                          <span className="inline-flex gap-1" aria-hidden>
                            {[0, 1, 2].map((d) => (
                              <span
                                key={d}
                                className="h-1.5 w-1.5 animate-dots rounded-full bg-muted"
                                style={{ animationDelay: `${d * 160}ms` }}
                              />
                            ))}
                          </span>
                          {m.sources ? `Reading ${m.sources.length} passages` : "Searching your documents"}
                        </p>
                      )
                    )}
                    {m.error && (
                      <div role="alert" className="mt-3 flex items-start gap-2.5 rounded-lg border border-[#fecdca] bg-danger-soft px-3.5 py-2.5 text-sm">
                        <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-danger" />
                        <p className="flex-1 text-ink">{m.error}</p>
                        {i === messages.length - 1 && !busy && (
                          <button onClick={retryLast} className="inline-flex shrink-0 items-center gap-1 font-medium text-danger hover:underline">
                            <Icon name="retry" size={14} />
                            Try again
                          </button>
                        )}
                      </div>
                    )}
                    {!m.streaming && !m.error && m.content && (
                      <div className="-ml-2 mt-2 flex items-center gap-0.5">
                        <SpeakButton text={m.content} />
                        <button type="button" className={actionClass} onClick={() => copy(m.content)}>
                          <Icon name="copy" size={14} />
                          Copy
                        </button>
                      </div>
                    )}
                    {m.sources && (
                      <SourceList
                        sources={m.sources}
                        cited={m.cited ?? []}
                        done={!m.streaming && m.cited !== undefined}
                        focus={focus?.msg === i ? { n: focus.n, tick: focus.tick } : null}
                        onOpen={setViewing}
                      />
                    )}
                  </article>
                ),
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-line bg-canvas pt-3">
          <Composer
            ref={input}
            value={question}
            onChange={setQuestion}
            onSubmit={() => ask(question)}
            onStop={() => abort.current?.abort()}
            busy={busy}
            hasDocuments={docCount > 0}
            scopeLabel={scope}
            voiceLang={voiceLang}
            onVoiceLang={changeVoiceLang}
            onVoiceText={onVoiceText}
            canSpeak={canSpeak}
            autoRead={autoRead}
            onAutoRead={toggleAutoRead}
          />
        </div>
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-canvas/85 p-6">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-accent-line bg-surface px-10 py-8 text-center shadow-pop">
            <Icon name="upload" size={22} className="text-accent" />
            <p className="text-[15px] font-medium">Drop files to upload</p>
            <p className="text-[13px] text-muted">PDF, Markdown, TXT, PNG, JPG or WebP</p>
          </div>
        </div>
      )}

      {viewing && <DocumentViewer source={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

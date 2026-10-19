// Typed client for the DocuMind FastAPI backend.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

export type DocumentInfo = {
  id: string;
  filename: string;
  content_type: string;
  num_pages: number;
  num_chunks: number;
  created_at: string;
  duplicate: boolean;
  has_file?: boolean;
  ocr_pages?: number; // pages read with OCR during this upload (scanned PDF or photo)
};

export type Source = {
  number: number;
  chunk_id: number;
  document_id: string;
  filename: string;
  page: number | null;
  chunk_index: number;
  content: string;
  score: number;
};

export type Turn = { role: "user" | "assistant"; content: string };

/** Thrown on 401 so the page can show the login screen. */
export class NotLoggedInError extends Error {
  constructor() {
    super("Please log in");
    this.name = "NotLoggedInError";
  }
}

// Called whenever the API says "not logged in" (e.g. the session expired); the page listens to it.
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

/** fetch() that sends the httpOnly login cookie with every API call. */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" });
}

async function check(res: Response): Promise<Response> {
  if (res.status === 401) {
    onUnauthorized();
    throw new NotLoggedInError();
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* body was not JSON */
    }
    throw new Error(detail);
  }
  return res;
}

export async function listDocuments(): Promise<DocumentInfo[]> {
  return (await check(await apiFetch(`${API_URL}/documents`, { cache: "no-store" }))).json();
}

export async function uploadDocument(file: File): Promise<DocumentInfo> {
  const form = new FormData();
  form.append("file", file);
  return (await check(await apiFetch(`${API_URL}/documents`, { method: "POST", body: form }))).json();
}

/**
 * Same request as uploadDocument (POST /documents, multipart "file"), sent with XMLHttpRequest
 * because fetch() cannot report upload progress. `onProgress` gets the real fraction of bytes
 * sent (0..1); once it reaches 1 the server is extracting, chunking and embedding the file.
 */
export function uploadDocumentWithProgress(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<DocumentInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/documents`);
    xhr.withCredentials = true; // send the login cookie, like apiFetch
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      if (xhr.status === 401) {
        onUnauthorized();
        return reject(new NotLoggedInError());
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as DocumentInfo);
      const detail = xhr.response?.detail;
      reject(new Error(typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : `${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error("Network error: could not reach the API"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await check(await apiFetch(`${API_URL}/documents/${id}`, { method: "DELETE" }));
}

type StreamHandlers = {
  onConversation?: (conversation: { id: string; title: string }) => void;
  onQuery?: (searchQuery: string) => void;
  onSources: (sources: Source[]) => void;
  onToken: (text: string) => void;
  onDone: (cited: number[]) => void;
  onError: (message: string) => void;
};

/**
 * POST /chat/stream and parse its Server-Sent Events.
 * EventSource only supports GET, so we read the response body stream ourselves:
 * events are separated by a blank line, each has an `event:` and a `data:` line.
 */
export async function streamChat(
  body: { question: string; history: Turn[]; document_ids?: string[]; conversation_id?: string | null },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await check(
    await apiFetch(`${API_URL}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (!event || data === undefined) continue;
      const payload = JSON.parse(data);
      if (event === "conversation") handlers.onConversation?.(payload);
      else if (event === "query") handlers.onQuery?.(payload.text);
      else if (event === "sources") handlers.onSources(payload);
      else if (event === "token") handlers.onToken(payload.text);
      else if (event === "done") handlers.onDone(payload.cited);
      else if (event === "error") handlers.onError(payload.detail);
    }
  }
}

export type Transcript = { text: string; language: string; duration_s: number };

/** Speech-to-text: send a recorded audio clip, get the spoken question back as text. */
export type VoiceLanguage = "auto" | "en" | "hi";

export async function transcribeAudio(audio: Blob, language: VoiceLanguage = "auto"): Promise<Transcript> {
  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("audio", audio, `question.${ext}`);
  form.append("language", language);
  return (await check(await apiFetch(`${API_URL}/transcribe`, { method: "POST", body: form }))).json();
}

// ---- Saved chats -----------------------------------------------------------------

export type ConversationSummary = { id: string; title: string; updated_at: string; message_count: number };

export type SavedMessage = {
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
  cited: number[] | null;
  search_query: string | null;
  created_at: string;
};

export async function listConversations(): Promise<ConversationSummary[]> {
  return (await check(await apiFetch(`${API_URL}/conversations`, { cache: "no-store" }))).json();
}

export async function getConversation(id: string): Promise<{ id: string; title: string; messages: SavedMessage[] }> {
  return (await check(await apiFetch(`${API_URL}/conversations/${id}`, { cache: "no-store" }))).json();
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await check(
    await apiFetch(`${API_URL}/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteConversation(id: string): Promise<void> {
  await check(await apiFetch(`${API_URL}/conversations/${id}`, { method: "DELETE" }));
}

// ---- Accounts ---------------------------------------------------------------------

export type User = { id: string; email: string; name: string };

/** The logged-in user, or null when not logged in. */
export async function getMe(): Promise<User | null> {
  const res = await apiFetch(`${API_URL}/auth/me`, { cache: "no-store" });
  if (res.status === 401) return null;
  return (await check(res)).json();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return apiFetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Login/register errors are shown on the form, so they don't trigger the global "logged out" handler. */
async function authResult(res: Response): Promise<User> {
  if (res.ok) return res.json();
  let detail = "Something went wrong";
  try {
    const body = await res.json();
    if (typeof body.detail === "string") detail = body.detail;
    else if (Array.isArray(body.detail)) {
      const field = body.detail[0]?.loc?.at(-1);
      detail =
        field === "password"
          ? "Password must be 8 to 72 characters"
          : field === "email"
            ? "Enter a valid email address"
            : body.detail[0]?.msg ?? detail;
    }
  } catch {
    /* not JSON */
  }
  throw new Error(detail);
}

export async function login(email: string, password: string): Promise<User> {
  return authResult(await postJson("/auth/login", { email, password }));
}

export async function register(email: string, password: string, name: string): Promise<User> {
  return authResult(await postJson("/auth/register", { email, password, name }));
}

export async function logout(): Promise<void> {
  await postJson("/auth/logout", {});
}

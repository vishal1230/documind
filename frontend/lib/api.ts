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

async function check(res: Response): Promise<Response> {
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
  return (await check(await fetch(`${API_URL}/documents`, { cache: "no-store" }))).json();
}

export async function uploadDocument(file: File): Promise<DocumentInfo> {
  const form = new FormData();
  form.append("file", file);
  return (await check(await fetch(`${API_URL}/documents`, { method: "POST", body: form }))).json();
}

export async function deleteDocument(id: string): Promise<void> {
  await check(await fetch(`${API_URL}/documents/${id}`, { method: "DELETE" }));
}

type StreamHandlers = {
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
  body: { question: string; history: Turn[]; document_ids?: string[] },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await check(
    await fetch(`${API_URL}/chat/stream`, {
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
      if (event === "sources") handlers.onSources(payload);
      else if (event === "token") handlers.onToken(payload.text);
      else if (event === "done") handlers.onDone(payload.cited);
      else if (event === "error") handlers.onError(payload.detail);
    }
  }
}

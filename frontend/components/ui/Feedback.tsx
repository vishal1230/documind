"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";

/* ---------------------------------------------------------------- toasts */

type Tone = "neutral" | "success" | "error";
type Toast = { id: number; tone: Tone; message: string };
type ToastFn = (message: string, tone?: Tone) => void;

/* ------------------------------------------------------- confirm dialog */

type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
};
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const FeedbackContext = createContext<{ toast: ToastFn; confirm: ConfirmFn } | null>(null);

export function useToast(): ToastFn {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useToast must be used inside <FeedbackProvider>");
  return ctx.toast;
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useConfirm must be used inside <FeedbackProvider>");
  return ctx.confirm;
}

/** Provides toast notifications and an accessible confirmation dialog to the whole app. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastFn>(
    (message, tone = "neutral") => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4000);
    },
    [dismiss],
  );

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 text-sm shadow-pop"
          >
            <Icon
              name={t.tone === "success" ? "check" : t.tone === "error" ? "alert" : "info"}
              size={17}
              className={`mt-px shrink-0 ${t.tone === "success" ? "text-success" : t.tone === "error" ? "text-danger" : "text-muted"}`}
            />
            <p className="min-w-0 flex-1 break-words text-ink">{t.message}</p>
            <IconButton icon="x" label="Dismiss notification" size="sm" className="-my-1 -mr-1.5" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
      {pending && (
        <ConfirmDialog
          {...pending}
          onClose={(ok) => {
            pending.resolve(ok);
            setPending(null);
          }}
        />
      )}
    </FeedbackContext.Provider>
  );
}

/**
 * Uses the native <dialog> element: it traps focus, closes on Escape, makes the page behind it
 * inert, and returns focus to whatever opened it.
 */
function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  destructive,
  onClose,
}: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    cancelRef.current?.focus(); // the safe choice has focus first
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby={body ? "confirm-body" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose(false);
      }}
      onClick={(e) => e.target === ref.current && onClose(false)} // click on the backdrop
      className="m-auto w-[calc(100%-2rem)] max-w-md animate-pop-in rounded-xl border border-line bg-surface p-0 text-ink shadow-panel"
    >
      <div className="p-5">
        <h2 id="confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        {body && (
          <div id="confirm-body" className="mt-1.5 text-sm leading-relaxed text-muted">
            {body}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line bg-canvas/60 px-5 py-3">
        <Button ref={cancelRef} onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={() => onClose(true)}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

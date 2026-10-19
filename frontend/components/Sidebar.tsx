"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./ui/Button";

type Props = {
  variant: "desktop" | "drawer";
  onClose: () => void; // collapse on desktop, close the drawer on mobile
  children: ReactNode;
};

/** Brand + sidebar content. On small screens it is a modal drawer with its own focus handling. */
export default function Sidebar({ variant, onClose, children }: Props) {
  const panel = useRef<HTMLElement>(null);
  const drawer = variant === "drawer";

  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button, [href], input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
      if (e.key !== "Tab" || !panel.current) return;
      // keep Tab inside the drawer while it is open
      const els = Array.from(
        panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not([tabindex='-1']), [tabindex='0']"),
      ).filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [drawer, onClose]);

  const body = (
    <aside
      ref={panel}
      aria-label="Library"
      {...(drawer ? { role: "dialog", "aria-modal": true } : {})}
      className={`flex h-full flex-col border-r border-line bg-canvas ${
        drawer ? "w-[min(320px,88vw)] animate-slide-in-left shadow-panel" : "w-[272px] lg:w-[292px]"
      }`}
    >
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-[13px] font-semibold text-white">
          D
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[15px] font-semibold tracking-[-0.01em]">DocuMind</p>
          <p className="truncate text-2xs text-muted">Personal workspace</p>
        </div>
        <IconButton
          icon={drawer ? "x" : "sidebar"}
          label={drawer ? "Close sidebar" : "Collapse sidebar"}
          onClick={onClose}
          className="-mr-1.5"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 pb-6 pt-2">{children}</div>
    </aside>
  );

  if (!drawer) return body;
  return (
    <div className="fixed inset-0 z-40 flex md:hidden">
      <div className="absolute inset-0 animate-fade-in bg-ink/30" onClick={onClose} aria-hidden />
      <div className="relative h-full">{body}</div>
    </div>
  );
}

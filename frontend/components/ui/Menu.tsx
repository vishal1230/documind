"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type MenuItem =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { separator: true };

type Props = {
  items: MenuItem[];
  /** Renders the trigger; spread the given props onto a <button>. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
  }) => ReactNode;
  header?: ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  className?: string;
};

/** Accessible dropdown menu: arrow keys move, Enter/Space select, Escape closes and returns focus. */
export function Menu({ items, trigger, header, align = "end", side = "bottom", className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const focusable = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);

  function openMenu(focus: "first" | "last" = "first") {
    setOpen(true);
    requestAnimationFrame(() => {
      const els = focusable();
      (focus === "first" ? els[0] : els.at(-1))?.focus();
    });
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    const els = focusable();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      els.at(-1)?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  return (
    <div ref={wrapper} className={`relative ${className}`}>
      {trigger({
        ref: triggerRef,
        onClick: () => (open ? close(false) : openMenu()),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu("first");
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openMenu("last");
          }
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
      })}
      {open && (
        <div
          ref={listRef}
          id={id}
          role="menu"
          onKeyDown={onListKey}
          className={`absolute z-50 min-w-48 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-pop ${
            align === "end" ? "right-0" : "left-0"
          } ${side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}
        >
          {header && <div className="border-b border-line px-2.5 pb-2 pt-1.5">{header}</div>}
          {items.map((item, i) =>
            "separator" in item ? (
              <div key={i} role="separator" className="my-1 h-px bg-line" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors duration-100 focus-visible:outline-none disabled:opacity-45 ${
                  item.danger
                    ? "text-danger hover:bg-danger-soft focus:bg-danger-soft"
                    : "text-ink hover:bg-sunken focus:bg-sunken"
                }`}
              >
                {item.icon && <Icon name={item.icon} size={15} className={item.danger ? "" : "text-muted"} />}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

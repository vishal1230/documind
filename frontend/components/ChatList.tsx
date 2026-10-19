"use client";

import { useState } from "react";
import { deleteConversation, renameConversation, type ConversationSummary } from "@/lib/api";
import { IconButton } from "./ui/Button";
import { useConfirm, useToast } from "./ui/Feedback";
import { Menu } from "./ui/Menu";

type Props = {
  conversations: ConversationSummary[] | null; // null while loading
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
};

/** Saved chats in the sidebar: reopen, rename or delete an old one. */
export default function ChatList({ conversations, activeId, onSelect, onNew, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const confirm = useConfirm();
  const toast = useToast();

  async function saveTitle(id: string, original: string) {
    const title = draft.trim();
    setEditing(null);
    if (!title || title === original) return;
    try {
      await renameConversation(id, title);
      onChanged();
    } catch (e) {
      toast(`Couldn't rename the chat: ${(e as Error).message}`, "error");
    }
  }

  async function remove(c: ConversationSummary) {
    const ok = await confirm({
      title: "Delete chat?",
      body: (
        <>
          <span className="font-medium text-ink">{c.title}</span> and its {c.message_count} message
          {c.message_count === 1 ? "" : "s"} will be permanently deleted. Your documents are not affected.
        </>
      ),
      confirmLabel: "Delete chat",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteConversation(c.id);
      if (c.id === activeId) onNew();
      onChanged();
      toast("Chat deleted.", "neutral");
    } catch (e) {
      toast(`Couldn't delete the chat: ${(e as Error).message}`, "error");
    }
  }

  return (
    <section aria-labelledby="chats-heading" className="flex flex-col gap-1.5">
      <h2 id="chats-heading" className="px-1 text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
        Recent chats
      </h2>
      {conversations === null ? (
        <div className="space-y-2 px-2 py-1" aria-label="Loading chats">
          <span className="block h-2.5 w-4/5 animate-pulse rounded bg-sunken" />
          <span className="block h-2.5 w-3/5 animate-pulse rounded bg-sunken" />
        </div>
      ) : conversations.length === 0 ? (
        <p className="px-1 text-[13px] text-muted">Your conversations are saved here.</p>
      ) : (
        <ul className="-mx-1 space-y-px">
          {conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <li
                key={c.id}
                className={`group relative flex items-center rounded-md transition-colors duration-150 ${
                  active ? "bg-surface shadow-xs ring-1 ring-line" : "hover:bg-sunken"
                }`}
              >
                {editing === c.id ? (
                  <input
                    autoFocus
                    aria-label="Chat title"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => saveTitle(c.id, c.title)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTitle(c.id, c.title);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onFocus={(e) => e.target.select()}
                    className="m-0.5 h-7 min-w-0 flex-1 rounded-sm border border-accent bg-surface px-1.5 text-[13px] text-ink focus:outline-none"
                    maxLength={200}
                  />
                ) : (
                  <button
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? "page" : undefined}
                    className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px] ${
                      active ? "font-medium text-ink" : "text-ink-2"
                    }`}
                    title={c.title}
                  >
                    {c.title}
                  </button>
                )}
                {editing !== c.id && (
                  <Menu
                    items={[
                      {
                        label: "Rename",
                        icon: "pencil",
                        onSelect: () => {
                          setEditing(c.id);
                          setDraft(c.title);
                        },
                      },
                      { separator: true },
                      { label: "Delete", icon: "trash", danger: true, onSelect: () => remove(c) },
                    ]}
                    trigger={(p) => (
                      <IconButton
                        {...p}
                        icon="more"
                        label={`Actions for chat ${c.title}`}
                        size="sm"
                        className="mr-0.5 opacity-100 aria-expanded:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      />
                    )}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

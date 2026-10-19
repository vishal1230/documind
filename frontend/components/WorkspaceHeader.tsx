"use client";

import type { User } from "@/lib/api";
import { Button, IconButton } from "./ui/Button";
import { Menu } from "./ui/Menu";

type Props = {
  title: string;
  scope: string;
  scoped: boolean; // limited to selected documents
  onClearScope: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenDrawer: () => void;
  onNewChat: () => void;
  canStartNew: boolean;
  user: User;
  onLogout: () => void;
};

function initials(user: User) {
  const source = user.name?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (user.name?.trim() ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** Top bar of the workspace: conversation title, what is being searched, new chat, account. */
export default function WorkspaceHeader(props: Props) {
  const { user } = props;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-canvas/95 px-3 sm:px-4">
      {/* mobile: open the drawer; desktop: re-open a collapsed sidebar */}
      <IconButton icon="menu" label="Open library" className="md:hidden" onClick={props.onOpenDrawer} />
      {!props.sidebarOpen && (
        <span className="hidden md:contents">
          <IconButton icon="sidebar" label="Expand sidebar" onClick={props.onToggleSidebar} />
        </span>
      )}

      <div className="min-w-0 flex-1 px-1">
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]" title={props.title}>
          {props.title}
        </h1>
        <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
          <span className="truncate">{props.scope}</span>
          {props.scoped && (
            <button onClick={props.onClearScope} className="shrink-0 font-medium text-accent hover:text-accent-hover hover:underline">
              Search all
            </button>
          )}
        </p>
      </div>

      <span className="hidden sm:contents">
        <Button size="sm" icon="plus" onClick={props.onNewChat} disabled={!props.canStartNew}>
          New chat
        </Button>
      </span>
      <IconButton icon="plus" label="New chat" onClick={props.onNewChat} disabled={!props.canStartNew} className="sm:hidden" />

      <Menu
        header={
          <div className="min-w-0">
            {user.name && <p className="truncate text-sm font-medium">{user.name}</p>}
            <p className="truncate text-[12px] text-muted">{user.email}</p>
          </div>
        }
        items={[{ label: "Log out", icon: "logout", onSelect: props.onLogout }]}
        trigger={(p) => (
          <button
            {...p}
            aria-label={`Account: ${user.name || user.email}`}
            title={user.email}
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-[12px] font-semibold text-ink-2 transition-colors duration-150 hover:border-line-strong aria-expanded:border-accent-line"
          >
            {initials(user)}
          </button>
        )}
      />
    </header>
  );
}

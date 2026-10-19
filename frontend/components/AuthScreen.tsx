"use client";

import { useState } from "react";
import { login, register, type User } from "@/lib/api";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";

const field =
  "mt-1.5 block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-[15px] text-ink shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-subtle hover:border-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] focus:outline-none";

/** Log in / create account. Each account only ever sees its own documents and chats. */
export default function AuthScreen({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(mode === "login" ? await login(email, password) : await register(email, password, name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === "login";
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px] animate-rise-in">
        <div className="mb-8 flex items-center gap-2.5">
          <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-md bg-ink text-sm font-semibold text-white">
            D
          </span>
          <span className="text-lg font-semibold tracking-[-0.01em]">DocuMind</span>
        </div>

        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{isLogin ? "Log in" : "Create your account"}</h1>
        <p className="mt-1.5 text-[15px] text-muted">
          {isLogin ? "Ask questions about your documents and get cited answers." : "Your documents and chats stay private to your account."}
        </p>

        <form onSubmit={submit} className="mt-7 space-y-4" noValidate={false}>
          {!isLogin && (
            <label className="block text-sm font-medium text-ink-2">
              Name <span className="font-normal text-subtle">(optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} className={field} />
            </label>
          )}
          <label className="block text-sm font-medium text-ink-2">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              className={field}
            />
          </label>
          <label className="block text-sm font-medium text-ink-2">
            Password
            <input
              type="password"
              required
              minLength={isLogin ? 1 : 8}
              maxLength={72}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? "current-password" : "new-password"}
              aria-describedby={!isLogin ? "pw-hint" : undefined}
              className={field}
            />
            {!isLogin && (
              <span id="pw-hint" className="mt-1.5 block text-[12px] font-normal text-muted">
                At least 8 characters.
              </span>
            )}
          </label>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-[#fecdca] bg-danger-soft px-3 py-2.5 text-sm text-ink">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-danger" />
              <p>{error}</p>
            </div>
          )}

          <Button type="submit" variant="primary" disabled={busy} className="h-10 w-full text-[15px]">
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" aria-hidden />}
            {busy ? "Please wait…" : isLogin ? "Log in" : "Create account"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted">
          {isLogin ? "New to DocuMind? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => {
              setMode(isLogin ? "register" : "login");
              setError(null);
            }}
            className="font-medium text-accent hover:text-accent-hover hover:underline"
          >
            {isLogin ? "Create an account" : "Log in"}
          </button>
        </p>
      </div>
    </main>
  );
}

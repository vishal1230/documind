"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { VoiceLanguage } from "@/lib/api";
import MicButton from "./MicButton";
import { Icon } from "./ui/Icon";

const MAX_LENGTH = 2000; // the API's question limit

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean; // an answer is streaming
  hasDocuments: boolean;
  scopeLabel: string;
  voiceLang: VoiceLanguage;
  onVoiceLang: (lang: VoiceLanguage) => void;
  onVoiceText: (text: string) => void;
  canSpeak: boolean;
  autoRead: boolean;
  onAutoRead: (on: boolean) => void;
};

/**
 * Question box. Enter sends, Shift+Enter adds a line, the box grows with the text up to a limit.
 * Voice input, its language, and automatic read-aloud live in the toolbar under the text.
 */
const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(props, ref) {
  const { value, onChange, onSubmit, onStop, busy, hasDocuments, scopeLabel } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => area.current!);

  // Grow with the content (up to the CSS max-height, then scroll).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const canSend = !!value.trim() && !busy;
  const nearLimit = value.length > MAX_LENGTH * 0.85;

  return (
    <form
      className="mx-auto w-full max-w-[760px] px-3 pb-3 sm:px-6 sm:pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      <div className="rounded-xl border border-line-strong bg-surface shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
        <label htmlFor="question" className="sr-only">
          Ask a question about your documents
        </label>
        <textarea
          id="question"
          ref={area}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line; never send in the middle of IME composition.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
          placeholder={hasDocuments ? "Ask a question about your documents…" : "Upload a document, then ask about it…"}
          aria-describedby="composer-hint"
          className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed text-ink placeholder:text-subtle focus:outline-none focus-visible:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <MicButton onText={props.onVoiceText} language={props.voiceLang} disabled={busy} />

          <label className="relative inline-flex h-9 items-center" title="Language you will speak in">
            <span className="sr-only">Voice language</span>
            <select
              value={props.voiceLang}
              onChange={(e) => props.onVoiceLang(e.target.value as VoiceLanguage)}
              className="h-8 cursor-pointer appearance-none rounded-md bg-transparent pl-2 pr-6 text-[13px] text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="auto">Auto language</option>
              <option value="en">English</option>
              <option value="hi">Hindi / Hinglish</option>
            </select>
            <Icon name="chevronDown" size={13} className="pointer-events-none absolute right-1.5 text-subtle" />
          </label>

          {props.canSpeak && (
            <button
              type="button"
              onClick={() => props.onAutoRead(!props.autoRead)}
              aria-pressed={props.autoRead}
              title="Read new answers aloud automatically"
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors duration-150 ${
                props.autoRead ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken hover:text-ink"
              }`}
            >
              <Icon name={props.autoRead ? "volume" : "volumeOff"} size={15} />
              <span className="hidden sm:inline">Read aloud</span>
              <span className="sr-only sm:hidden">Read answers aloud</span>
            </button>
          )}

          <span className="flex-1" />
          {nearLimit && (
            <span className={`mr-1 text-2xs tabular-nums ${value.length >= MAX_LENGTH ? "text-danger" : "text-subtle"}`}>
              {value.length}/{MAX_LENGTH}
            </span>
          )}

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium text-ink shadow-xs transition-colors duration-150 hover:bg-canvas"
            >
              <Icon name="stop" size={12} />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send question"
              title="Send (Enter)"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent text-white shadow-xs transition-colors duration-150 hover:bg-accent-hover disabled:bg-line-strong disabled:text-white disabled:shadow-none"
            >
              <Icon name="send" size={17} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      <p id="composer-hint" className="mt-1.5 hidden text-center text-2xs text-subtle sm:block">
        {scopeLabel} · Enter to send, Shift + Enter for a new line
      </p>
    </form>
  );
});

export default Composer;

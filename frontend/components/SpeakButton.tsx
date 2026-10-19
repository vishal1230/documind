"use client";

import { useEffect, useState } from "react";
import { speak, speechSupported, stopSpeaking } from "@/lib/speech";
import { Icon } from "./ui/Icon";

export const actionClass =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink";

/** "Listen" action under an answer: reads it aloud, click again to stop. */
export default function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => setSupported(speechSupported()), []);
  useEffect(() => () => stopSpeaking(), []);

  if (!supported || !text) return null;

  async function toggle() {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    await speak(text);
    setSpeaking(false);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={speaking}
      className={`${actionClass} ${speaking ? "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent" : ""}`}
    >
      <Icon name={speaking ? "pause" : "volume"} size={14} />
      {speaking ? "Stop reading" : "Listen"}
    </button>
  );
}

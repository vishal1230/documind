"use client";

import { useEffect, useRef, useState } from "react";
import { transcribeAudio, type VoiceLanguage } from "@/lib/api";
import { watchForSilence } from "@/lib/vad";
import { Icon } from "./ui/Icon";

const MAX_SECONDS = 60;

type Props = { onText: (text: string) => void; language: VoiceLanguage; disabled?: boolean };

/**
 * Click to start recording. Recording stops by itself when you stop talking (about 1.5 s of
 * silence), or you can click again to stop early. The clip is sent to the backend's /transcribe
 * endpoint (local Whisper) and the recognised text is handed to the parent.
 * The browser only allows microphone access on https:// or localhost.
 */
export default function MicButton({ onText, language, disabled }: Props) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  const discard = useRef(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && "MediaRecorder" in window);
    return () => {
      if (timer.current) clearInterval(timer.current);
      stopWatching.current?.();
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Voice errors are transient hints; clear them after a few seconds.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);

  async function start() {
    setError(null);
    setState("starting");
    let stream: MediaStream;
    try {
      // Browser-side noise suppression and echo cancellation make silence detection more reliable.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setState("idle");
      const name = (e as DOMException).name;
      setError(
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone found. Connect one and try again."
          : name === "NotReadableError"
            ? "The microphone is in use by another app."
            : "Microphone blocked. Allow mic access in the browser's address bar.",
      );
      return;
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    discard.current = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); // turn the mic light off
      stopWatching.current?.();
      if (timer.current) clearInterval(timer.current);
      setLevel(0);
      if (discard.current) {
        setState("idle");
        setError("Didn't hear anything. Click the mic and speak your question.");
        return;
      }
      setState("transcribing");
      try {
        const { text } = await transcribeAudio(new Blob(chunks, { type: rec.mimeType }), language);
        onText(text);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setState("idle");
      }
    };
    recorder.current = rec;
    rec.start();
    setState("recording");
    setSeconds(0);

    // Stop automatically when the user stops talking.
    stopWatching.current = watchForSilence(stream, {
      onSilence: () => rec.state === "recording" && rec.stop(),
      onNoSpeech: () => {
        discard.current = true;
        if (rec.state === "recording") rec.stop();
      },
      onLevel: setLevel,
    });

    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) rec.state === "recording" && rec.stop();
        return s + 1;
      });
    }, 1000);
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  if (!supported) return null;

  const recording = state === "recording";
  const label = recording
    ? `Stop recording (${seconds}s). Recording also stops when you pause`
    : state === "transcribing"
      ? "Transcribing your question"
      : state === "starting"
        ? "Starting microphone"
        : "Ask by voice";

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled || state === "transcribing" || state === "starting"}
        title={label}
        aria-label={label}
        aria-pressed={recording}
        className={`relative inline-flex h-9 items-center justify-center gap-1.5 rounded-md transition-[background-color,color,width] duration-200 disabled:pointer-events-none ${
          recording
            ? "bg-danger-soft px-2.5 text-danger"
            : state === "transcribing" || state === "starting"
              ? "w-9 text-accent"
              : "w-9 text-muted hover:bg-sunken hover:text-ink disabled:opacity-45"
        }`}
      >
        {recording && (
          // Ring that follows your voice level, so you can see the mic is hearing you.
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-danger/50 transition-opacity duration-75"
            style={{ opacity: 0.15 + level * 0.85 }}
          />
        )}
        {state === "transcribing" || state === "starting" ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/25 border-t-accent motion-reduce:animate-none" aria-hidden />
        ) : recording ? (
          <Icon name="stop" size={14} />
        ) : (
          <Icon name="mic" size={18} />
        )}
        {recording && (
          <span className="text-[13px] font-medium tabular-nums">
            0:{String(seconds).padStart(2, "0")}
          </span>
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {recording ? "Listening" : state === "transcribing" ? "Transcribing" : ""}
      </span>
      {recording && <span className="ml-2 hidden text-[13px] text-muted sm:inline">Listening… pause to finish</span>}
      {state === "transcribing" && <span className="ml-2 hidden text-[13px] text-muted sm:inline">Transcribing…</span>}
      {error && (
        <div
          role="alert"
          className="absolute bottom-full left-0 z-20 mb-2 flex w-72 animate-pop-in items-start gap-2 rounded-lg border border-[#fecdca] bg-surface p-2.5 text-[13px] text-ink shadow-pop"
        >
          <Icon name="alert" size={16} className="mt-px shrink-0 text-danger" />
          <p className="flex-1">{error}</p>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="text-subtle hover:text-ink">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

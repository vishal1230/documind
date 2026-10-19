// Text-to-speech with the browser's built-in voices (Web Speech API). Free, instant, works offline
// with the voices installed on Windows/macOS.

/** Remove things that sound bad when read aloud: citation markers and markdown symbols. */
export function toSpeakable(text: string): string {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/[*_#`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickVoice(text: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  // Hindi in Devanagari needs a Hindi voice; Hinglish (Latin letters) sounds best with an Indian English voice.
  const prefer = /[\u0900-\u097F]/.test(text) ? ["hi-IN"] : ["en-IN", "en-GB", "en-US"];
  for (const lang of prefer) {
    const v = voices.find((voice) => voice.lang === lang);
    if (v) return v;
  }
  return voices.find((voice) => voice.lang.startsWith(prefer[0].slice(0, 2)));
}

export const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

/**
 * Speak text sentence by sentence. Chrome silently stops long single utterances (~15 s),
 * so queueing short ones is more reliable. Returns a promise that resolves when done or stopped.
 */
export function speak(text: string): Promise<void> {
  const synth = window.speechSynthesis;
  synth.cancel();
  const clean = toSpeakable(text);
  const sentences = clean.match(/[^.!?।]+[.!?।]*/g) ?? [];
  const voice = pickVoice(clean);
  return new Promise((resolve) => {
    if (!sentences.length) return resolve();
    sentences.forEach((sentence, i) => {
      const u = new SpeechSynthesisUtterance(sentence.trim());
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = 1;
      if (i === sentences.length - 1) {
        u.onend = () => resolve();
        u.onerror = () => resolve();
      }
      synth.speak(u);
    });
  });
}

export function stopSpeaking() {
  if (speechSupported()) window.speechSynthesis.cancel();
}

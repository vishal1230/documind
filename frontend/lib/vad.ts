// Voice activity detection (VAD) in the browser: notices when the user stops talking.
//
// The Web Audio API's AnalyserNode gives us the raw microphone samples. Every 50 ms we compute
// their loudness (RMS, root mean square). The first moments set a "noise floor" for the room;
// anything clearly louder counts as speech. Once the user has spoken, a quiet stretch of
// SILENCE_MS means they've finished. If they never speak, we give up after NO_SPEECH_MS.

export const SILENCE_MS = 1500; // pause length that ends the question
export const NO_SPEECH_MS = 7000; // nothing said at all: stop and don't upload
const CALIBRATE_MS = 300; // measure background noise first
const MIN_SPEECH_MS = 200; // ignore clicks and short bumps
const TICK_MS = 50;

type Handlers = {
  onSilence: () => void; // user spoke, then paused: finish the recording
  onNoSpeech: () => void; // never spoke: cancel
  onLevel?: (level: number) => void; // 0..1 loudness, for the mic animation
};

/** Starts watching the microphone stream. Returns a function that stops watching. */
export function watchForSilence(stream: MediaStream, { onSilence, onNoSpeech, onLevel }: Handlers): () => void {
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let elapsed = 0;
  let floorSum = 0;
  let floorTicks = 0;
  let threshold = 0.02;
  let loudMs = 0;
  let quietMs = 0;
  let spoke = false;
  let done = false;

  const finish = (cb: () => void) => {
    if (done) return;
    done = true;
    cleanup();
    cb();
  };

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    elapsed += TICK_MS;
    onLevel?.(Math.min(1, rms / Math.max(threshold * 3, 0.05)));

    if (elapsed <= CALIBRATE_MS) {
      floorSum += rms;
      floorTicks += 1;
      // Speech must be well above the room's background noise, within sensible bounds.
      threshold = Math.min(0.06, Math.max(0.012, (floorSum / floorTicks) * 2.5));
      return;
    }

    if (rms > threshold) {
      loudMs += TICK_MS;
      quietMs = 0;
      if (loudMs >= MIN_SPEECH_MS) spoke = true;
    } else {
      quietMs += TICK_MS;
      if (!spoke) loudMs = 0;
    }

    if (spoke && quietMs >= SILENCE_MS) finish(onSilence);
    else if (!spoke && elapsed >= NO_SPEECH_MS) finish(onNoSpeech);
  }, TICK_MS);

  function cleanup() {
    clearInterval(timer);
    ctx.close().catch(() => undefined);
  }

  return () => {
    done = true;
    cleanup();
  };
}

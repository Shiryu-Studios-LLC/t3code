import * as Effect from "effect/Effect";
import { getClientSettings } from "~/hooks/useSettings";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { prepareTextForSpeech, splitSpeechText } from "./speechText";

const OPENAI_DEFAULT_VOICE = "alloy";
const OMNIROUTE_DEFAULT_VOICE = "Aiden";
const KOKORO_DEFAULT_VOICE = "am_michael";
const OPENAI_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);
let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let activeDesktopSystemSpeech = false;
let generation = 0;
const unsettledAssistantMessages = new Set<string>();

export type TextToSpeechPlaybackStatus = "idle" | "playing" | "paused";
export interface TextToSpeechPlaybackState {
  readonly status: TextToSpeechPlaybackStatus;
  readonly messageId: string | null;
}

let playbackState: TextToSpeechPlaybackState = { status: "idle", messageId: null };
const playbackListeners = new Set<() => void>();

function setPlaybackState(next: TextToSpeechPlaybackState): void {
  if (playbackState.status === next.status && playbackState.messageId === next.messageId) return;
  playbackState = next;
  for (const listener of playbackListeners) listener();
}

export function getTextToSpeechPlaybackState(): TextToSpeechPlaybackState {
  return playbackState;
}

export function subscribeTextToSpeechPlayback(listener: () => void): () => void {
  playbackListeners.add(listener);
  return () => playbackListeners.delete(listener);
}

function revokeActiveObjectUrl() {
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
}

export function stopTextToSpeech(): void {
  generation += 1;
  if (activeDesktopSystemSpeech && typeof window !== "undefined") {
    activeDesktopSystemSpeech = false;
    void window.desktopBridge?.systemSpeech?.({ action: "stop" }).catch((error) => {
      console.error("[TTS] failed to stop desktop system speech", error);
    });
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  revokeActiveObjectUrl();
  setPlaybackState({ status: "idle", messageId: null });
}

export function pauseTextToSpeech(): void {
  if (activeDesktopSystemSpeech && typeof window !== "undefined") {
    void window.desktopBridge?.systemSpeech?.({ action: "pause" }).catch((error) => {
      console.error("[TTS] failed to pause desktop system speech", error);
    });
    setPlaybackState({ status: "paused", messageId: playbackState.messageId });
    return;
  }
  if (activeAudio && !activeAudio.paused) {
    activeAudio.pause();
    setPlaybackState({ status: "paused", messageId: playbackState.messageId });
    return;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.pause();
    setPlaybackState({ status: "paused", messageId: playbackState.messageId });
  }
}

export function resumeTextToSpeech(): void {
  if (activeDesktopSystemSpeech && typeof window !== "undefined") {
    void window.desktopBridge?.systemSpeech?.({ action: "resume" }).catch((error) => {
      console.error("[TTS] failed to resume desktop system speech", error);
    });
    setPlaybackState({ status: "playing", messageId: playbackState.messageId });
    return;
  }
  if (activeAudio?.paused) {
    void activeAudio.play();
    setPlaybackState({ status: "playing", messageId: playbackState.messageId });
    return;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.resume();
    setPlaybackState({ status: "playing", messageId: playbackState.messageId });
  }
}

async function speakWithSystemVoice(text: string, token: number): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("System text-to-speech is not available in this browser.");
  }

  const settings = getClientSettings();
  const browserVoices = "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
  if (browserVoices.length === 0 && window.desktopBridge?.systemSpeech) {
    activeDesktopSystemSpeech = true;
    try {
      for (const chunk of splitSpeechText(text)) {
        if (token !== generation) return;
        await window.desktopBridge.systemSpeech({
          action: "speak",
          text: chunk,
          rate: settings.textToSpeechRate,
        });
      }
    } finally {
      if (token === generation) activeDesktopSystemSpeech = false;
    }
    return;
  }

  if (!("speechSynthesis" in window)) {
    throw new Error("System text-to-speech is not available in this browser.");
  }

  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.textToSpeechRate;
    const selectedVoice = browserVoices.find((voice) => voice.name === settings.textToSpeechVoice);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.onend = () => resolve();
    utterance.onerror = (event) =>
      reject(new Error(event.error || "System text-to-speech failed."));
    if (token !== generation) {
      resolve();
      return;
    }
    window.speechSynthesis.speak(utterance);
  });
}

function decodeBase64Audio(audioBase64: string): Uint8Array {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function playAudioBytes(
  bytes: Uint8Array,
  token: number,
  mimeType = "audio/mpeg",
): Promise<void> {
  if (token !== generation) return;
  revokeActiveObjectUrl();
  const audioBytes = new Uint8Array(bytes.byteLength);
  audioBytes.set(bytes);
  activeObjectUrl = URL.createObjectURL(new Blob([audioBytes.buffer], { type: mimeType }));
  const audio = new Audio(activeObjectUrl);
  activeAudio = audio;
  await new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Generated speech audio could not be played."));
    void audio.play().catch(reject);
  });
  if (activeAudio === audio) activeAudio = null;
  revokeActiveObjectUrl();
}

async function speakWithKokoro(text: string, token: number): Promise<void> {
  if (typeof window === "undefined" || !window.desktopBridge?.systemSpeech) {
    throw new Error("Kokoro local text-to-speech is only available in the T3 desktop app.");
  }
  const settings = getClientSettings();
  const voice = settings.textToSpeechVoice.trim() || KOKORO_DEFAULT_VOICE;
  activeDesktopSystemSpeech = true;
  try {
    for (const chunk of splitSpeechText(text, 30_000)) {
      if (token !== generation) return;
      await window.desktopBridge.systemSpeech({
        action: "speak",
        engine: "kokoro",
        text: chunk,
        voice,
        rate: settings.textToSpeechRate,
      });
    }
  } finally {
    if (token === generation) activeDesktopSystemSpeech = false;
  }
}

async function speakWithOmniRoute(text: string, token: number): Promise<void> {
  const settings = getClientSettings();
  const voice = settings.textToSpeechVoice.trim() || OMNIROUTE_DEFAULT_VOICE;
  for (const chunk of splitSpeechText(text)) {
    if (token !== generation) return;
    const response = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.textToSpeech.synthesize({
            payload: {
              text: chunk,
              voice,
              rate: settings.textToSpeechRate,
              provider: "omniroute",
            },
            headers: {},
          }),
        ),
      ),
    );
    if (token !== generation) return;
    await playAudioBytes(decodeBase64Audio(response.audioBase64), token, response.mimeType);
  }
}

async function speakWithOpenAI(text: string, token: number): Promise<void> {
  const bridge = window.desktopBridge;
  const settings = getClientSettings();
  const voice = OPENAI_VOICES.has(settings.textToSpeechVoice)
    ? settings.textToSpeechVoice
    : OPENAI_DEFAULT_VOICE;
  for (const chunk of splitSpeechText(text)) {
    if (token !== generation) return;
    const bytes = bridge?.synthesizeSpeech
      ? await bridge.synthesizeSpeech({ text: chunk, voice, rate: settings.textToSpeechRate })
      : decodeBase64Audio(
          (
            await runPrimaryHttp(
              PrimaryEnvironmentHttpClient.pipe(
                Effect.flatMap((client) =>
                  client.textToSpeech.synthesize({
                    payload: {
                      text: chunk,
                      voice,
                      rate: settings.textToSpeechRate,
                      provider: "openai",
                    },
                    headers: {},
                  }),
                ),
              ),
            )
          ).audioBase64,
        );
    if (token !== generation) return;
    await playAudioBytes(bytes, token);
  }
}

export async function playTextToSpeech(
  markdown: string,
  messageId: string | null = null,
): Promise<void> {
  const speechText = prepareTextForSpeech(markdown);
  if (!speechText) return;
  stopTextToSpeech();
  const token = generation;
  setPlaybackState({ status: "playing", messageId });
  const settings = getClientSettings();
  try {
    if (settings.textToSpeechProvider === "omniroute") {
      try {
        await speakWithOmniRoute(speechText, token);
      } catch (error) {
        if (token !== generation) return;
        console.warn("[TTS] OmniRoute speech failed; falling back to system speech", error);
        await speakWithSystemVoice(speechText, token);
      }
    } else if (settings.textToSpeechProvider === "openai") {
      await speakWithOpenAI(speechText, token);
    } else if (settings.textToSpeechProvider === "kokoro") {
      await speakWithKokoro(speechText, token);
    } else {
      await speakWithSystemVoice(speechText, token);
    }
  } finally {
    if (token === generation) {
      setPlaybackState({ status: "idle", messageId: null });
    }
  }
}

export function shouldAutoReadAssistantMessage(messageId: string, settled: boolean): boolean {
  // Drive automatic playback from the assistant row becoming terminal rather
  // than from the raw `streaming` flag. Providers can emit the final text and
  // the streaming=false marker in the same event batch, which React may render
  // only once. The timeline's settled state remains false until the turn itself
  // completes, giving us a reliable false -> true transition without replaying
  // historical messages when a thread is opened.
  if (!settled) {
    unsettledAssistantMessages.add(messageId);
    return false;
  }
  if (!unsettledAssistantMessages.delete(messageId)) return false;
  const settings = getClientSettings();
  return settings.textToSpeechEnabled && settings.textToSpeechAutoRead;
}

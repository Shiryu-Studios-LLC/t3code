import * as Effect from "effect/Effect";
import { getClientSettings } from "~/hooks/useSettings";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { prepareTextForSpeech, splitSpeechText } from "./speechText";

const OPENAI_DEFAULT_VOICE = "alloy";
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
let generation = 0;
const streamingAssistantMessages = new Set<string>();

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

function speakWithSystemVoice(text: string, token: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      reject(new Error("System text-to-speech is not available in this browser."));
      return;
    }
    const settings = getClientSettings();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.textToSpeechRate;
    const selectedVoice = window.speechSynthesis
      .getVoices()
      .find((voice) => voice.name === settings.textToSpeechVoice);
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

async function playAudioBytes(bytes: Uint8Array, token: number): Promise<void> {
  if (token !== generation) return;
  revokeActiveObjectUrl();
  const audioBytes = new Uint8Array(bytes.byteLength);
  audioBytes.set(bytes);
  activeObjectUrl = URL.createObjectURL(new Blob([audioBytes.buffer], { type: "audio/mpeg" }));
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
                    payload: { text: chunk, voice, rate: settings.textToSpeechRate },
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
    if (settings.textToSpeechProvider === "openai") await speakWithOpenAI(speechText, token);
    else await speakWithSystemVoice(speechText, token);
  } finally {
    if (token === generation) {
      setPlaybackState({ status: "idle", messageId: null });
    }
  }
}

export function shouldAutoReadAssistantMessage(messageId: string, streaming: boolean): boolean {
  if (streaming) {
    streamingAssistantMessages.add(messageId);
    return false;
  }
  if (!streamingAssistantMessages.delete(messageId)) return false;
  const settings = getClientSettings();
  return settings.textToSpeechEnabled && settings.textToSpeechAutoRead;
}

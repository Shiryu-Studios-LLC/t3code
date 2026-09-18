import type {
  ChatAttachment,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { create } from "zustand";

export type QueuedTurnStatus = "queued" | "sending" | "failed";

export interface QueuedTurnSubmission {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
  readonly status: QueuedTurnStatus;
  readonly error: string | null;
}

interface QueuedTurnStoreState {
  readonly byThreadKey: Readonly<Record<string, ReadonlyArray<QueuedTurnSubmission>>>;
  enqueue: (threadKey: string, submission: QueuedTurnSubmission) => void;
  markSending: (threadKey: string, id: string) => void;
  markQueued: (threadKey: string, id: string) => void;
  markFailed: (threadKey: string, id: string, error: string) => void;
  remove: (threadKey: string, id: string) => void;
  clearThread: (threadKey: string) => void;
}

export const EMPTY_QUEUED_TURNS: ReadonlyArray<QueuedTurnSubmission> = [];

function updateEntry(
  entries: ReadonlyArray<QueuedTurnSubmission>,
  id: string,
  update: (entry: QueuedTurnSubmission) => QueuedTurnSubmission,
): ReadonlyArray<QueuedTurnSubmission> {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return update(entry);
  });
  return changed ? next : entries;
}

export const useQueuedTurnStore = create<QueuedTurnStoreState>()((set) => ({
  byThreadKey: {},
  enqueue: (threadKey, submission) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: [...(state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS), submission],
      },
    })),
  markSending: (threadKey, id) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: updateEntry(
          state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS,
          id,
          (entry) => ({
            ...entry,
            status: "sending",
            error: null,
          }),
        ),
      },
    })),
  markQueued: (threadKey, id) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: updateEntry(
          state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS,
          id,
          (entry) => ({
            ...entry,
            status: "queued",
            error: null,
          }),
        ),
      },
    })),
  markFailed: (threadKey, id, error) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: updateEntry(
          state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS,
          id,
          (entry) => ({
            ...entry,
            status: "failed",
            error,
          }),
        ),
      },
    })),
  remove: (threadKey, id) =>
    set((state) => {
      const existing = state.byThreadKey[threadKey] ?? EMPTY_QUEUED_TURNS;
      const nextEntries = existing.filter((entry) => entry.id !== id);
      if (nextEntries.length === existing.length) return state;
      const nextByThreadKey = { ...state.byThreadKey };
      if (nextEntries.length === 0) {
        delete nextByThreadKey[threadKey];
      } else {
        nextByThreadKey[threadKey] = nextEntries;
      }
      return { byThreadKey: nextByThreadKey };
    }),
  clearThread: (threadKey) =>
    set((state) => {
      if (!(threadKey in state.byThreadKey)) return state;
      const nextByThreadKey = { ...state.byThreadKey };
      delete nextByThreadKey[threadKey];
      return { byThreadKey: nextByThreadKey };
    }),
}));

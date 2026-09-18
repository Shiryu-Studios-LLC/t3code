import { create } from "zustand";

export interface LocalImageActivity {
  label: string;
  startedAt: string;
}

interface LocalImageActivityState {
  byThreadKey: Record<string, LocalImageActivity>;
  start: (threadKey: string, label: string) => void;
  finish: (threadKey: string) => void;
}

export const useLocalImageActivityStore = create<LocalImageActivityState>()((set) => ({
  byThreadKey: {},
  start: (threadKey, label) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: { label, startedAt: new Date().toISOString() },
      },
    })),
  finish: (threadKey) =>
    set((state) => {
      if (!(threadKey in state.byThreadKey)) return state;
      const next = { ...state.byThreadKey };
      delete next[threadKey];
      return { byThreadKey: next };
    }),
}));

import { create } from 'zustand';
import type { TerminalSession, PaneInfo } from '@/lib/terminalApi';

export interface TerminalChunk {
  id: number;
  data: string;
}

interface PaneState {
  index: number;
  buffer: string;
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  info: PaneInfo | null;
}

interface TerminalSessionState {
  directory: string;
  terminalSessionId: string | null;
  isConnecting: boolean;
  // Legacy single-pane buffer (for backward compat)
  buffer: string;
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  updatedAt: number;
  // Multi-pane support
  panes: PaneState[];
  activePaneIndex: number;
}

interface TerminalStore {
  sessions: Map<string, TerminalSessionState>;
  nextChunkId: number;

  getTerminalSession: (directory: string) => TerminalSessionState | undefined;
  setTerminalSession: (directory: string, terminalSession: TerminalSession) => void;
  setConnecting: (directory: string, isConnecting: boolean) => void;
  appendToBuffer: (directory: string, chunk: string, paneIndex?: number) => void;
  clearTerminalSession: (directory: string) => void;
  clearBuffer: (directory: string, paneIndex?: number) => void;
  removeTerminalSession: (directory: string) => void;
  clearAllTerminalSessions: () => void;
  // Multi-pane support
  setActivePaneIndex: (directory: string, paneIndex: number) => void;
  addPane: (directory: string, paneInfo: PaneInfo) => void;
  removePane: (directory: string, paneIndex: number) => void;
  updatePanes: (directory: string, panes: PaneInfo[]) => void;
}

const TERMINAL_BUFFER_LIMIT = 256_000;

function normalizeDirectory(dir: string): string {
  let normalized = dir.trim();
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

const createEmptyPaneState = (index: number): PaneState => ({
  index,
  buffer: '',
  bufferChunks: [],
  bufferLength: 0,
  info: null,
});

const createEmptySessionState = (directory: string): TerminalSessionState => ({
  directory,
  terminalSessionId: null,
  isConnecting: false,
  buffer: '',
  bufferChunks: [],
  bufferLength: 0,
  updatedAt: Date.now(),
  panes: [createEmptyPaneState(0)],
  activePaneIndex: 0,
});

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: new Map(),
  nextChunkId: 1,

  getTerminalSession: (directory: string) => {
    const key = normalizeDirectory(directory);
    return get().sessions.get(key);
  },

  setTerminalSession: (directory: string, terminalSession: TerminalSession) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      const shouldResetBuffer =
        !existing ||
        existing.terminalSessionId !== terminalSession.sessionId;

      const baseState = shouldResetBuffer
        ? createEmptySessionState(key)
        : existing ?? createEmptySessionState(key);

      newSessions.set(key, {
        ...baseState,
        terminalSessionId: terminalSession.sessionId,
        directory: key,
        isConnecting: false,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions };
    });
  },

  setConnecting: (directory: string, isConnecting: boolean) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key) ?? createEmptySessionState(key);
      newSessions.set(key, {
        ...existing,
        isConnecting,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  appendToBuffer: (directory: string, chunk: string, paneIndex?: number) => {
    if (!chunk) {
      return;
    }

    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key) ?? createEmptySessionState(key);

      const chunkId = state.nextChunkId;
      const chunkEntry: TerminalChunk = { id: chunkId, data: chunk };

      // Update legacy buffer (for active pane or pane 0)
      const targetPaneIndex = paneIndex ?? existing.activePaneIndex;
      
      // Update main buffer (legacy)
      const bufferChunks = [...existing.bufferChunks, chunkEntry];
      let bufferLength = existing.bufferLength + chunk.length;

      while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
        const removed = bufferChunks.shift();
        if (!removed) {
          break;
        }
        bufferLength -= removed.data.length;
      }

      const buffer = bufferChunks.map((entry) => entry.data).join('');

      // Update pane-specific buffer
      const panes = [...existing.panes];
      const paneState = panes[targetPaneIndex] ?? createEmptyPaneState(targetPaneIndex);
      const paneChunks = [...paneState.bufferChunks, chunkEntry];
      let paneBufferLength = paneState.bufferLength + chunk.length;

      while (paneBufferLength > TERMINAL_BUFFER_LIMIT && paneChunks.length > 1) {
        const removed = paneChunks.shift();
        if (removed) paneBufferLength -= removed.data.length;
      }

      panes[targetPaneIndex] = {
        ...paneState,
        buffer: paneChunks.map((e) => e.data).join(''),
        bufferChunks: paneChunks,
        bufferLength: paneBufferLength,
      };

      newSessions.set(key, {
        ...existing,
        buffer,
        bufferChunks,
        bufferLength,
        panes,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions, nextChunkId: chunkId + 1 };
    });
  },

  clearTerminalSession: (directory: string) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (existing) {
        newSessions.set(key, {
          ...existing,
          terminalSessionId: null,
          isConnecting: false,
          updatedAt: Date.now(),
        });
      }
      return { sessions: newSessions };
    });
  },

  clearBuffer: (directory: string, paneIndex?: number) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (!existing) {
        return state;
      }

      const targetPaneIndex = paneIndex ?? existing.activePaneIndex;
      const panes = [...existing.panes];
      if (panes[targetPaneIndex]) {
        panes[targetPaneIndex] = {
          ...panes[targetPaneIndex],
          buffer: '',
          bufferChunks: [],
          bufferLength: 0,
        };
      }

      newSessions.set(key, {
        ...existing,
        buffer: '',
        bufferChunks: [],
        bufferLength: 0,
        panes,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  removeTerminalSession: (directory: string) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(key);
      return { sessions: newSessions };
    });
  },

  clearAllTerminalSessions: () => {
    set({ sessions: new Map(), nextChunkId: 1 });
  },

  setActivePaneIndex: (directory: string, paneIndex: number) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (!existing) return state;

      // Sync legacy buffer with the newly active pane's buffer
      const pane = existing.panes[paneIndex];
      newSessions.set(key, {
        ...existing,
        activePaneIndex: paneIndex,
        buffer: pane?.buffer ?? '',
        bufferChunks: pane?.bufferChunks ?? [],
        bufferLength: pane?.bufferLength ?? 0,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  addPane: (directory: string, paneInfo: PaneInfo) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (!existing) return state;

      const panes = [...existing.panes];
      const newPane: PaneState = {
        index: paneInfo.index,
        buffer: '',
        bufferChunks: [],
        bufferLength: 0,
        info: paneInfo,
      };
      panes[paneInfo.index] = newPane;

      newSessions.set(key, {
        ...existing,
        panes,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  removePane: (directory: string, paneIndex: number) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (!existing) return state;

      const panes = existing.panes.filter((p) => p.index !== paneIndex);
      // Reindex panes
      panes.forEach((p, i) => { p.index = i; });

      // Adjust active pane if needed
      let activePaneIndex = existing.activePaneIndex;
      if (activePaneIndex >= panes.length) {
        activePaneIndex = Math.max(0, panes.length - 1);
      }

      const activePane = panes[activePaneIndex];
      newSessions.set(key, {
        ...existing,
        panes,
        activePaneIndex,
        buffer: activePane?.buffer ?? '',
        bufferChunks: activePane?.bufferChunks ?? [],
        bufferLength: activePane?.bufferLength ?? 0,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  updatePanes: (directory: string, paneInfos: PaneInfo[]) => {
    const key = normalizeDirectory(directory);
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(key);
      if (!existing) return state;

      // Preserve existing pane buffers, update info
      const panes = paneInfos.map((info) => {
        const existingPane = existing.panes.find((p) => p.index === info.index);
        return existingPane
          ? { ...existingPane, info }
          : { ...createEmptyPaneState(info.index), info };
      });

      newSessions.set(key, {
        ...existing,
        panes,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },
}));

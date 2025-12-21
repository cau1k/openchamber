import {
  connectTerminalStream,
  createTerminalSession,
  createTerminalPane,
  listTerminalPanes,
  killTerminalPane,
  resizeTerminal,
  sendTerminalInput,
  closeTerminal,
  restartTerminalSession,
  forceKillTerminal,
} from '@openchamber/ui/lib/terminalApi';
import type {
  TerminalAPI,
  TerminalHandlers,
  TerminalStreamOptions,
  CreateTerminalOptions,
  ResizeTerminalPayload,
  TerminalSession,
  ForceKillOptions,
  CreatePaneResult,
  ListPanesResult,
  KillPaneResult,
} from '@openchamber/ui/lib/api/types';

const getRetryPolicy = (options?: TerminalStreamOptions) => {
  const retry = options?.retry;
  return {
    maxRetries: retry?.maxRetries ?? 3,
    initialRetryDelay: retry?.initialDelayMs ?? 1000,
    maxRetryDelay: retry?.maxDelayMs ?? 8000,
    connectionTimeout: options?.connectionTimeoutMs ?? 10000,
  };
};

export const createWebTerminalAPI = (): TerminalAPI => ({
  async createSession(options: CreateTerminalOptions): Promise<TerminalSession> {
    return createTerminalSession(options);
  },

  connect(sessionId: string, handlers: TerminalHandlers, options?: TerminalStreamOptions, paneIndex?: number) {
    const unsubscribe = connectTerminalStream(
      sessionId,
      handlers.onEvent,
      handlers.onError,
      getRetryPolicy(options),
      paneIndex ?? 0
    );

    return {
      close: () => unsubscribe(),
    };
  },

  async sendInput(sessionId: string, input: string, paneIndex?: number): Promise<void> {
    await sendTerminalInput(sessionId, input, paneIndex ?? 0);
  },

  async resize(payload: ResizeTerminalPayload): Promise<void> {
    await resizeTerminal(payload.sessionId, payload.cols, payload.rows, payload.paneIndex ?? 0);
  },

  async close(sessionId: string): Promise<void> {
    await closeTerminal(sessionId);
  },

  async restartSession(
    currentSessionId: string,
    options: CreateTerminalOptions
  ): Promise<TerminalSession> {
    return restartTerminalSession(currentSessionId, {
      cwd: options.cwd ?? '',
      cols: options.cols,
      rows: options.rows,
    });
  },

  async forceKill(options: ForceKillOptions): Promise<void> {
    await forceKillTerminal(options);
  },

  async createPane(sessionId: string, cwd?: string): Promise<CreatePaneResult> {
    return createTerminalPane(sessionId, cwd);
  },

  async listPanes(sessionId: string): Promise<ListPanesResult> {
    return listTerminalPanes(sessionId);
  },

  async killPane(sessionId: string, paneIndex: number): Promise<KillPaneResult> {
    return killTerminalPane(sessionId, paneIndex);
  },
});

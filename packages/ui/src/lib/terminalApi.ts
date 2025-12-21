export interface PaneInfo {
  index: number;
  active: boolean;
  pid: number;
  currentCommand: string;
  title: string;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  workspace?: string;
  panes?: PaneInfo[];
  activePaneIndex?: number;
  isNew?: boolean;
  persistent?: boolean;
}

export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;
  pane?: number;
  initial?: boolean;
}

export interface CreateTerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface ConnectStreamOptions {
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  connectionTimeout?: number;
}

export async function createTerminalSession(
  options: CreateTerminalOptions
): Promise<TerminalSession> {
  const response = await fetch('/api/terminal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: options.cwd,
      cols: options.cols || 80,
      rows: options.rows || 24,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create terminal' }));
    throw new Error(error.error || 'Failed to create terminal session');
  }

  return response.json();
}

export async function createTerminalPane(
  sessionId: string,
  cwd?: string
): Promise<{ sessionId: string; paneIndex: number; panes: PaneInfo[] }> {
  const response = await fetch('/api/terminal/pane/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cwd }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create pane' }));
    throw new Error(error.error || 'Failed to create terminal pane');
  }

  return response.json();
}

export async function listTerminalPanes(
  sessionId: string
): Promise<{ sessionId: string; panes: PaneInfo[] }> {
  const response = await fetch(`/api/terminal/panes/${sessionId}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list panes' }));
    throw new Error(error.error || 'Failed to list terminal panes');
  }

  return response.json();
}

export async function killTerminalPane(
  sessionId: string,
  paneIndex: number
): Promise<{ panes?: PaneInfo[]; sessionKilled?: boolean }> {
  const response = await fetch(`/api/terminal/pane/${sessionId}/${paneIndex}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to kill pane' }));
    throw new Error(error.error || 'Failed to kill terminal pane');
  }

  return response.json();
}

export function connectTerminalStream(
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {},
  paneIndex: number = 0
): () => void {
  const {
    maxRetries = 3,
    initialRetryDelay = 1000,
    maxRetryDelay = 8000,
    connectionTimeout = 10000,
  } = options;

  let eventSource: EventSource | null = null;
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;
  let hasDispatchedOpen = false;
  let terminalExited = false;

  const clearTimeouts = () => {
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
  };

  const cleanup = () => {
    isClosed = true;
    clearTimeouts();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const connect = () => {
    if (isClosed || terminalExited) {
      return;
    }

    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
      console.warn('Attempted to create duplicate EventSource, skipping');
      return;
    }

    hasDispatchedOpen = false;
    eventSource = new EventSource(`/api/terminal/stream/${sessionId}/${paneIndex}`);

    connectionTimeoutId = setTimeout(() => {
      if (!hasDispatchedOpen && eventSource?.readyState !== EventSource.OPEN) {
        console.error('Terminal connection timeout');
        eventSource?.close();
        handleError(new Error('Connection timeout'), false);
      }
    }, connectionTimeout);

    eventSource.onopen = () => {
      if (hasDispatchedOpen) {
        return;
      }
      hasDispatchedOpen = true;
      retryCount = 0;
      clearTimeouts();

      onEvent({ type: 'connected' });
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TerminalStreamEvent;

        if (data.type === 'exit') {
          terminalExited = true;
          cleanup();
        }

        onEvent(data);
      } catch (error) {
        console.error('Failed to parse terminal event:', error);
        onError?.(error as Error, false);
      }
    };

    eventSource.onerror = (error) => {
      console.error('Terminal stream error:', error, 'readyState:', eventSource?.readyState);
      clearTimeouts();

      const isFatalError = terminalExited || eventSource?.readyState === EventSource.CLOSED;

      eventSource?.close();
      eventSource = null;

      if (!terminalExited) {
        handleError(new Error('Terminal stream connection error'), isFatalError);
      }
    };
  };

  const handleError = (error: Error, isFatal: boolean) => {
    if (isClosed || terminalExited) {
      return;
    }

    if (retryCount < maxRetries && !isFatal) {
      retryCount++;
      const delay = Math.min(initialRetryDelay * Math.pow(2, retryCount - 1), maxRetryDelay);

      console.log(`Reconnecting to terminal stream (attempt ${retryCount}/${maxRetries}) in ${delay}ms`);

      onEvent({
        type: 'reconnecting',
        attempt: retryCount,
        maxAttempts: maxRetries,
      });

      retryTimeout = setTimeout(() => {
        if (!isClosed && !terminalExited) {
          connect();
        }
      }, delay);
    } else {

      console.error(`Terminal connection failed after ${retryCount} attempts`);
      onError?.(error, true);
      cleanup();
    }
  };

  connect();

  return cleanup;
}

export async function sendTerminalInput(
  sessionId: string,
  data: string,
  paneIndex: number = 0
): Promise<void> {
  const response = await fetch(`/api/terminal/write/${sessionId}/${paneIndex}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to send input' }));
    throw new Error(error.error || 'Failed to send terminal input');
  }
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  paneIndex: number = 0
): Promise<void> {
  const response = await fetch(`/api/terminal/resize/${sessionId}/${paneIndex}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }
}

export async function closeTerminal(sessionId: string): Promise<void> {
  const response = await fetch(`/api/terminal/session/${sessionId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to close terminal' }));
    throw new Error(error.error || 'Failed to close terminal');
  }
}

export async function restartTerminalSession(
  _currentSessionId: string,
  options: { cwd: string; cols?: number; rows?: number }
): Promise<TerminalSession> {
  // Reset creates a fresh session for the workspace
  const response = await fetch('/api/terminal/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to restart terminal' }));
    throw new Error(error.error || 'Failed to restart terminal');
  }

  return response.json();
}

export async function forceKillTerminal(options: {
  sessionId?: string;
  cwd?: string;
}): Promise<void> {
  // Reset the terminal for the workspace
  const response = await fetch('/api/terminal/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: options.cwd }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to force kill terminal' }));
    throw new Error(error.error || 'Failed to force kill terminal');
  }
}

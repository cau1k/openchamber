/**
 * Terminal routes using bun-pty for real PTY sessions
 * 
 * Architecture:
 * - Each terminal session is a real PTY process
 * - Sessions are managed in-memory with output buffering for reconnection
 * - Multiple sessions per workspace supported
 */

import { Hono } from 'hono'
import { spawn } from '@skitee3000/bun-pty'
import { createHash } from 'crypto'
import { getOpenCodeWorkingDirectory } from '../lib/opencode'

// PTY session state
interface PtySession {
  id: string
  pty: ReturnType<typeof spawn>
  workspace: string
  cols: number
  rows: number
  createdAt: number
  lastActivity: number
  outputBuffer: string[] // Ring buffer for reconnection
  dataDisposable: { dispose(): void } | null
  exitDisposable: { dispose(): void } | null
  exitCode: number | null
  exitSignal: number | null
}

// SSE subscriber
interface Subscriber {
  id: string
  writer: WritableStreamDefaultWriter
  sessionId: string
}

// Session storage
const sessions = new Map<string, PtySession>()
const subscribers = new Map<string, Subscriber>()

// Config
const MAX_BUFFER_LINES = 1000
const BATCH_INTERVAL_MS = 16 // ~60fps

// Pending data for batching
const pendingData = new Map<string, string>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function generateSessionId(workspace: string): string {
  const hash = createHash('md5').update(workspace).digest('hex').slice(0, 8)
  const random = Math.random().toString(36).slice(2, 6)
  return `openchamber-${hash}-${random}`
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return Bun.env.COMSPEC || 'cmd.exe'
  }
  return Bun.env.SHELL || '/bin/bash'
}

// Flush pending data to subscribers
function flushData(sessionId: string): void {
  const data = pendingData.get(sessionId)
  if (!data || data.length === 0) return
  
  pendingData.set(sessionId, '')
  flushTimers.delete(sessionId)

  // Add to buffer for reconnection
  const session = sessions.get(sessionId)
  if (session) {
    session.outputBuffer.push(data)
    // Trim buffer if too large
    while (session.outputBuffer.length > MAX_BUFFER_LINES) {
      session.outputBuffer.shift()
    }
  }

  // Send to all subscribers of this session
  for (const [subId, sub] of subscribers) {
    if (sub.sessionId === sessionId) {
      sub.writer.write(`data: ${JSON.stringify({ data, sessionId })}\n\n`).catch(() => {
        subscribers.delete(subId)
      })
    }
  }
}

// Schedule flush with batching
function scheduleFlush(sessionId: string): void {
  const existingTimer = flushTimers.get(sessionId)
  if (existingTimer) return // Already scheduled
  
  flushTimers.set(sessionId, setTimeout(() => flushData(sessionId), BATCH_INTERVAL_MS))
}

// Create a new PTY session
function createSession(id: string, workspace: string, cols: number, rows: number): PtySession {
  const shell = getDefaultShell()
  
  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const session: PtySession = {
    id,
    pty,
    workspace,
    cols,
    rows,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    outputBuffer: [],
    dataDisposable: null,
    exitDisposable: null,
    exitCode: null,
    exitSignal: null,
  }

  // Handle output
  session.dataDisposable = pty.onData((data: string) => {
    session.lastActivity = Date.now()
    const pending = (pendingData.get(id) || '') + data
    pendingData.set(id, pending)
    scheduleFlush(id)
  })

  // Handle exit
  session.exitDisposable = pty.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode ?? null
    session.exitSignal = typeof signal === 'number' ? signal : null
    console.log(`[terminal] Session ${id} exited with code ${exitCode}, signal ${signal}`)
    
    // Notify subscribers
    for (const [subId, sub] of subscribers) {
      if (sub.sessionId === id) {
        sub.writer.write(`data: ${JSON.stringify({ exit: true, exitCode, signal, sessionId: id })}\n\n`).catch(() => {})
        sub.writer.close().catch(() => {})
        subscribers.delete(subId)
      }
    }
    
    // Cleanup
    destroySession(id)
  })

  sessions.set(id, session)
  console.log(`[terminal] Created PTY session ${id} in ${workspace}`)
  
  return session
}

// Destroy a session
function destroySession(id: string): void {
  const session = sessions.get(id)
  if (!session) return

  // Cancel flush timer
  const timer = flushTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    flushTimers.delete(id)
  }
  
  // Flush any remaining data
  flushData(id)
  pendingData.delete(id)

  // Dispose listeners
  session.dataDisposable?.dispose()
  session.exitDisposable?.dispose()

  // Kill PTY if still alive
  if (session.exitCode === null) {
    try {
      session.pty.kill('SIGTERM')
    } catch {
      // Already dead
    }
  }

  sessions.delete(id)
  console.log(`[terminal] Destroyed session ${id}`)
}

// Get session for workspace (creates if needed)
function getOrCreateSessionForWorkspace(workspace: string, cols: number, rows: number): { session: PtySession; isNew: boolean } {
  // Find existing session for this workspace
  for (const session of sessions.values()) {
    if (session.workspace === workspace && session.exitCode === null) {
      return { session, isNew: false }
    }
  }
  
  // Create new
  const id = generateSessionId(workspace)
  const session = createSession(id, workspace, cols, rows)
  return { session, isNew: true }
}

export function createTerminalRoutes() {
  const terminal = new Hono()

  // Create or get terminal session
  terminal.post('/create', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workspace = cwd || getOpenCodeWorkingDirectory()

    try {
      const { session, isNew } = getOrCreateSessionForWorkspace(workspace, cols, rows)
      
      return c.json({
        sessionId: session.id,
        workspace: session.workspace,
        cols: session.cols,
        rows: session.rows,
        isNew,
        createdAt: session.createdAt,
      })
    } catch (error) {
      console.error('[terminal/create]', error)
      return c.json({ error: 'Failed to create terminal' }, 500)
    }
  })

  // List all sessions
  terminal.get('/sessions', async (c) => {
    const sessionList = Array.from(sessions.values()).map(s => ({
      id: s.id,
      workspace: s.workspace,
      cols: s.cols,
      rows: s.rows,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      isAlive: s.exitCode === null,
    }))
    return c.json({ sessions: sessionList })
  })

  // Get session info
  terminal.get('/session/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)
    
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    return c.json({
      id: session.id,
      workspace: session.workspace,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      isAlive: session.exitCode === null,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    })
  })

  // Stream output (SSE)
  terminal.get('/stream/:sessionId/:paneIndex', async (c) => {
    const sessionId = c.req.param('sessionId')
    // paneIndex ignored - we use single-pane sessions now
    
    const session = sessions.get(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const subscriberId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    subscribers.set(subscriberId, { id: subscriberId, writer, sessionId })

    // Send buffered output for reconnection
    if (session.outputBuffer.length > 0) {
      const initialData = session.outputBuffer.join('')
      await writer.write(`data: ${JSON.stringify({ data: initialData, sessionId, initial: true })}\n\n`)
    }

    // Send connected event
    await writer.write(`data: ${JSON.stringify({ connected: true, sessionId })}\n\n`)

    // Cleanup on disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      subscribers.delete(subscriberId)
      writer.close().catch(() => {})
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  // Write input
  terminal.post('/write/:sessionId/:paneIndex', async (c) => {
    const sessionId = c.req.param('sessionId')
    // paneIndex ignored
    
    const session = sessions.get(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    if (session.exitCode !== null) {
      return c.json({ error: 'Session has exited' }, 400)
    }

    try {
      const { data } = await c.req.json()
      if (data) {
        session.pty.write(data)
        session.lastActivity = Date.now()
      }
      return c.json({ success: true })
    } catch (error) {
      console.error('[terminal/write]', error)
      return c.json({ error: 'Failed to write to terminal' }, 500)
    }
  })

  // Resize
  terminal.post('/resize/:sessionId/:paneIndex', async (c) => {
    const sessionId = c.req.param('sessionId')
    // paneIndex ignored
    
    const session = sessions.get(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    try {
      const { cols, rows } = await c.req.json()
      if (cols && rows) {
        session.pty.resize(cols, rows)
        session.cols = cols
        session.rows = rows
        session.lastActivity = Date.now()
      }
      return c.json({ success: true })
    } catch (error) {
      console.error('[terminal/resize]', error)
      return c.json({ error: 'Failed to resize terminal' }, 500)
    }
  })

  // Kill session
  terminal.delete('/session/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    
    const session = sessions.get(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    destroySession(sessionId)
    return c.json({ success: true })
  })

  // Legacy: Kill pane (just kills session since we're single-pane now)
  terminal.delete('/pane/:sessionId/:paneIndex', async (c) => {
    const sessionId = c.req.param('sessionId')
    destroySession(sessionId)
    return c.json({ success: true })
  })

  // Reset - kill all sessions for workspace and create fresh
  terminal.post('/reset', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workspace = cwd || getOpenCodeWorkingDirectory()

    // Kill existing sessions for this workspace
    for (const [id, session] of sessions) {
      if (session.workspace === workspace) {
        destroySession(id)
      }
    }

    // Create fresh
    const newId = generateSessionId(workspace)
    const session = createSession(newId, workspace, cols, rows)

    return c.json({
      sessionId: session.id,
      workspace: session.workspace,
      cols: session.cols,
      rows: session.rows,
      isNew: true,
    })
  })

  // Legacy compatibility - /stream/:id without paneIndex
  terminal.get('/stream/:id', async (c) => {
    const id = c.req.param('id')
    // Reuse the main stream handler
    const url = new URL(c.req.url)
    url.pathname = `/api/terminal/stream/${id}/0`
    return c.redirect(url.pathname)
  })

  // Legacy - /write/:id without paneIndex  
  terminal.post('/write/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    try {
      const { data } = await c.req.json()
      if (data) {
        session.pty.write(data)
        session.lastActivity = Date.now()
      }
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: 'Failed to write' }, 500)
    }
  })

  return terminal
}

/**
 * Terminal routes using bun-pty
 * 
 * Optimizations:
 * - Batched output (debounced every 16ms for 60fps)
 * - Filtered terminal query responses that cause visual noise
 */

import { Hono } from 'hono'
import { spawn } from 'bun-pty'

type PtyProcess = ReturnType<typeof spawn>

interface TerminalSession {
  id: string
  process: PtyProcess
  buffer: string[]
  pendingData: string
  flushTimer: ReturnType<typeof setTimeout> | null
  subscribers: Set<WritableStreamDefaultWriter>
  createdAt: number
}

const sessions = new Map<string, TerminalSession>()

// Batch interval in ms (16ms = ~60fps)
const BATCH_INTERVAL_MS = 16

// Regex to filter out terminal query responses that cause visual noise
// These are responses to DA1, DA2, XTVERSION, and color queries
const TERMINAL_NOISE_PATTERNS = [
  /\x1b\[\?[\d;]*c/g,           // DA1 response (Primary Device Attributes)
  /\x1b\[>[\d;]*c/g,            // DA2 response (Secondary Device Attributes)
  /\x1b\]10;[^\x07\x1b]*[\x07\x1b\\]/g,  // OSC 10 (foreground color response)
  /\x1b\]11;[^\x07\x1b]*[\x07\x1b\\]/g,  // OSC 11 (background color response)
  /\x1b\]12;[^\x07\x1b]*[\x07\x1b\\]/g,  // OSC 12 (cursor color response)
  /\x1bP>[^\x1b]*\x1b\\/g,      // DCS responses
  /\x1b\[[\d;]*n/g,             // DSR responses
]

function filterTerminalNoise(data: string): string {
  let filtered = data
  for (const pattern of TERMINAL_NOISE_PATTERNS) {
    filtered = filtered.replace(pattern, '')
  }
  return filtered
}

function generateId(): string {
  return `term_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return Bun.env.COMSPEC || 'cmd.exe'
  }
  return Bun.env.SHELL || '/bin/bash'
}

function flushSession(session: TerminalSession): void {
  if (session.pendingData.length === 0) return
  
  const data = session.pendingData
  session.pendingData = ''
  session.flushTimer = null
  
  // Keep last 1000 chunks in buffer for replay
  session.buffer.push(data)
  if (session.buffer.length > 1000) {
    session.buffer.shift()
  }

  // Send batched data to all subscribers
  for (const writer of session.subscribers) {
    writer.write(`data: ${JSON.stringify({ data })}\n\n`).catch(() => {
      session.subscribers.delete(writer)
    })
  }
}

export function createTerminalRoutes() {
  const terminal = new Hono()

  // Create new terminal session
  terminal.post('/create', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workdir = cwd || process.cwd()

    try {
      const id = generateId()
      const shell = getDefaultShell()
      
      const ptyProcess = spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: workdir,
        env: {
          ...Bun.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as Record<string, string>,
      })

      const session: TerminalSession = {
        id,
        process: ptyProcess,
        buffer: [],
        pendingData: '',
        flushTimer: null,
        subscribers: new Set(),
        createdAt: Date.now(),
      }

      // Batched output - collect data and flush every 16ms
      ptyProcess.onData((data: string) => {
        // Filter out terminal query responses that cause visual noise
        const filtered = filterTerminalNoise(data)
        if (filtered.length === 0) return
        
        session.pendingData += filtered
        
        // Debounce: only flush after BATCH_INTERVAL_MS of no new data
        if (session.flushTimer) {
          clearTimeout(session.flushTimer)
        }
        session.flushTimer = setTimeout(() => flushSession(session), BATCH_INTERVAL_MS)
      })

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        // Flush any remaining data
        if (session.flushTimer) {
          clearTimeout(session.flushTimer)
          session.flushTimer = null
        }
        if (session.pendingData.length > 0) {
          flushSession(session)
        }
        
        // Notify subscribers of exit
        for (const writer of session.subscribers) {
          writer.write(`data: ${JSON.stringify({ exit: exitCode })}\n\n`).catch(() => {})
          writer.close().catch(() => {})
        }
        sessions.delete(id)
      })

      sessions.set(id, session)

      return c.json({ id, shell, cwd: workdir })
    } catch (error) {
      console.error('[terminal/create]', error)
      return c.json({ error: 'Failed to create terminal' }, 500)
    }
  })

  // Stream terminal output (SSE)
  terminal.get('/stream/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    // Add to subscribers
    session.subscribers.add(writer)

    // Send buffered output
    if (session.buffer.length > 0) {
      const buffered = session.buffer.join('')
      await writer.write(`data: ${JSON.stringify({ data: buffered })}\n\n`)
    }

    // Clean up on close
    c.req.raw.signal.addEventListener('abort', () => {
      session.subscribers.delete(writer)
      writer.close().catch(() => {})
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  })

  // Write to terminal
  terminal.post('/write/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { data } = await c.req.json()
    if (data) {
      session.process.write(data)
    }

    return c.json({ success: true })
  })

  // Resize terminal
  terminal.post('/resize/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { cols, rows } = await c.req.json()
    if (cols && rows) {
      session.process.resize(cols, rows)
    }

    return c.json({ success: true })
  })

  // Kill terminal
  terminal.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    session.process.kill()
    sessions.delete(id)

    return c.json({ success: true })
  })

  // List active sessions
  terminal.get('/sessions', (c) => {
    const list = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      createdAt: session.createdAt,
      subscriberCount: session.subscribers.size,
    }))

    return c.json({ sessions: list })
  })

  return terminal
}

/**
 * Terminal routes using bun-pty
 */

import { Hono } from 'hono'
import { spawn } from 'bun-pty'

type PtyProcess = ReturnType<typeof spawn>

interface TerminalSession {
  id: string
  process: PtyProcess
  buffer: string[]
  subscribers: Set<WritableStreamDefaultWriter>
  createdAt: number
}

const sessions = new Map<string, TerminalSession>()

function generateId(): string {
  return `term_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return Bun.env.COMSPEC || 'cmd.exe'
  }
  return Bun.env.SHELL || '/bin/bash'
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
        subscribers: new Set(),
        createdAt: Date.now(),
      }

      // Buffer output and send to subscribers
      ptyProcess.onData((data: string) => {
        // Keep last 1000 lines in buffer
        session.buffer.push(data)
        if (session.buffer.length > 1000) {
          session.buffer.shift()
        }

        // Send to all subscribers
        for (const writer of session.subscribers) {
          writer.write(`data: ${JSON.stringify({ data })}\n\n`).catch(() => {
            session.subscribers.delete(writer)
          })
        }
      })

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        // Notify subscribers
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

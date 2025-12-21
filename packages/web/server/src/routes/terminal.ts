/**
 * Terminal routes using tmux for persistence
 * 
 * Sessions persist across:
 * - Page refresh
 * - Server restart
 * - Reconnections
 * 
 * Naming: openchamber-<id>-<workspace-hash>
 */

import { Hono } from 'hono'
import { $ } from 'bun'
import { createHash } from 'crypto'

interface TmuxSession {
  id: string
  tmuxName: string
  workspace: string
  subscribers: Set<WritableStreamDefaultWriter>
  streamProc: ReturnType<typeof Bun.spawn> | null
  createdAt: number
}

// Active streaming connections (not the tmux sessions themselves)
const activeStreams = new Map<string, TmuxSession>()

// Batch interval for output (16ms = ~60fps)
const BATCH_INTERVAL_MS = 16

// Hash workspace path to create short, filesystem-safe identifier
function hashWorkspace(workspace: string): string {
  return createHash('md5').update(workspace).digest('hex').slice(0, 8)
}

function generateSessionName(workspace: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const hash = hashWorkspace(workspace)
  return `openchamber-${id}-${hash}`
}

function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return Bun.env.COMSPEC || 'cmd.exe'
  }
  return Bun.env.SHELL || '/bin/bash'
}

// Check if tmux session exists
async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await $`tmux has-session -t ${name}`.quiet()
    return true
  } catch {
    return false
  }
}

// List all openchamber tmux sessions for a workspace
async function listWorkspaceSessions(workspace: string): Promise<string[]> {
  const hash = hashWorkspace(workspace)
  
  try {
    const output = await $`tmux list-sessions -F "#{session_name}"`.text()
    return output
      .split('\n')
      .filter(Boolean)
      .filter(name => name.startsWith('openchamber-') && name.endsWith(`-${hash}`))
  } catch {
    return []
  }
}

// Create tmux session
async function createTmuxSession(name: string, workspace: string, cols: number, rows: number): Promise<void> {
  const shell = getDefaultShell()
  
  // Create detached tmux session with specified size
  await $`tmux new-session -d -s ${name} -x ${cols} -y ${rows} -c ${workspace} ${shell}`.quiet()
}

// Kill tmux session
async function killTmuxSession(name: string): Promise<void> {
  try {
    await $`tmux kill-session -t ${name}`.quiet()
  } catch {
    // Session might already be dead
  }
}

// Resize tmux session
async function resizeTmuxSession(name: string, cols: number, rows: number): Promise<void> {
  try {
    // Resize the window/pane
    await $`tmux resize-window -t ${name} -x ${cols} -y ${rows}`.quiet()
  } catch {
    // Fallback: try resizing pane directly
    try {
      await $`tmux resize-pane -t ${name} -x ${cols} -y ${rows}`.quiet()
    } catch {
      // Ignore resize errors
    }
  }
}

// Send input to tmux session
async function sendToTmux(name: string, data: string): Promise<void> {
  // Use send-keys with literal flag for raw input
  // For special keys, we need to handle them
  await $`tmux send-keys -t ${name} -l ${data}`.quiet()
}

// Capture tmux pane content (for initial buffer on reconnect)
async function captureTmuxPane(name: string, lines: number = 500): Promise<string> {
  try {
    const output = await $`tmux capture-pane -t ${name} -p -S -${lines}`.text()
    return output
  } catch {
    return ''
  }
}

export function createTerminalRoutes() {
  const terminal = new Hono()

  // Create new terminal session
  terminal.post('/create', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workspace = cwd || process.cwd()

    try {
      const tmuxName = generateSessionName(workspace)
      
      // Create the tmux session
      await createTmuxSession(tmuxName, workspace, cols, rows)
      
      console.log(`[terminal] Created tmux session: ${tmuxName} in ${workspace}`)

      return c.json({ 
        id: tmuxName, 
        tmuxName,
        shell: getDefaultShell(), 
        cwd: workspace,
        persistent: true
      })
    } catch (error) {
      console.error('[terminal/create]', error)
      return c.json({ error: 'Failed to create terminal' }, 500)
    }
  })

  // List sessions for workspace
  terminal.get('/list', async (c) => {
    const workspace = c.req.query('workspace') || process.cwd()
    
    try {
      const sessions = await listWorkspaceSessions(workspace)
      return c.json({ sessions, workspace })
    } catch (error) {
      console.error('[terminal/list]', error)
      return c.json({ error: 'Failed to list sessions' }, 500)
    }
  })

  // Reconnect to existing session (or verify it exists)
  terminal.get('/reconnect/:id', async (c) => {
    const tmuxName = c.req.param('id')
    
    try {
      const exists = await tmuxSessionExists(tmuxName)
      if (!exists) {
        return c.json({ error: 'Session not found', exists: false }, 404)
      }
      
      // Capture current pane content for replay
      const buffer = await captureTmuxPane(tmuxName)
      
      return c.json({ 
        id: tmuxName, 
        exists: true, 
        buffer,
        persistent: true
      })
    } catch (error) {
      console.error('[terminal/reconnect]', error)
      return c.json({ error: 'Failed to reconnect' }, 500)
    }
  })

  // Stream terminal output (SSE)
  terminal.get('/stream/:id', async (c) => {
    const tmuxName = c.req.param('id')
    
    // Check session exists
    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    // Get or create stream tracker
    let session = activeStreams.get(tmuxName)
    if (!session) {
      session = {
        id: tmuxName,
        tmuxName,
        workspace: '',
        subscribers: new Set(),
        streamProc: null,
        createdAt: Date.now(),
      }
      activeStreams.set(tmuxName, session)
    }
    
    session.subscribers.add(writer)

    // Send initial buffer (captured pane content)
    const initialBuffer = await captureTmuxPane(tmuxName)
    if (initialBuffer) {
      await writer.write(`data: ${JSON.stringify({ data: initialBuffer })}\n\n`)
    }

    // Start streaming if not already
    if (!session.streamProc) {
      // Use tmux pipe-pane to stream output
      // We spawn a process that reads from tmux
      const streamProc = Bun.spawn(['tmux', 'pipe-pane', '-t', tmuxName, '-O', 'cat'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      
      session.streamProc = streamProc

      // Buffer for batching
      let pendingData = ''
      let flushTimer: ReturnType<typeof setTimeout> | null = null

      const flush = () => {
        if (pendingData.length === 0) return
        const data = pendingData
        pendingData = ''
        flushTimer = null

        for (const w of session!.subscribers) {
          w.write(`data: ${JSON.stringify({ data })}\n\n`).catch(() => {
            session!.subscribers.delete(w)
          })
        }
      }

      // Read stdout
      const reader = (streamProc.stdout as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()

      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            pendingData += decoder.decode(value)
            
            if (flushTimer) clearTimeout(flushTimer)
            flushTimer = setTimeout(flush, BATCH_INTERVAL_MS)
          }
        } catch {
          // Stream ended
        }

        // Cleanup
        if (flushTimer) {
          clearTimeout(flushTimer)
          flush()
        }
        session!.streamProc = null
      }

      readLoop()
    }

    // Cleanup on disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      session!.subscribers.delete(writer)
      writer.close().catch(() => {})
      
      // Stop streaming if no more subscribers
      if (session!.subscribers.size === 0 && session!.streamProc) {
        session!.streamProc.kill()
        session!.streamProc = null
        activeStreams.delete(tmuxName)
      }
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
    const tmuxName = c.req.param('id')
    
    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { data } = await c.req.json()
    if (data) {
      await sendToTmux(tmuxName, data)
    }

    return c.json({ success: true })
  })

  // Resize terminal
  terminal.post('/resize/:id', async (c) => {
    const tmuxName = c.req.param('id')
    
    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { cols, rows } = await c.req.json()
    if (cols && rows) {
      await resizeTmuxSession(tmuxName, cols, rows)
    }

    return c.json({ success: true })
  })

  // Kill terminal
  terminal.delete('/:id', async (c) => {
    const tmuxName = c.req.param('id')
    
    // Clean up streaming
    const session = activeStreams.get(tmuxName)
    if (session) {
      if (session.streamProc) {
        session.streamProc.kill()
      }
      for (const writer of session.subscribers) {
        writer.close().catch(() => {})
      }
      activeStreams.delete(tmuxName)
    }

    // Kill tmux session
    await killTmuxSession(tmuxName)
    
    console.log(`[terminal] Killed tmux session: ${tmuxName}`)

    return c.json({ success: true })
  })

  // List all active sessions (for debugging/admin)
  terminal.get('/sessions', async (c) => {
    try {
      const output = await $`tmux list-sessions -F "#{session_name}:#{session_created}"`.text()
      const sessions = output
        .split('\n')
        .filter(Boolean)
        .filter(line => line.startsWith('openchamber-'))
        .map(line => {
          const [name, created] = line.split(':')
          return { 
            name, 
            createdAt: parseInt(created) * 1000,
            hasActiveStream: activeStreams.has(name)
          }
        })

      return c.json({ sessions })
    } catch {
      return c.json({ sessions: [] })
    }
  })

  return terminal
}

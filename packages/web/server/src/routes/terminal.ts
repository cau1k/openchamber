/**
 * Terminal routes using tmux for persistence
 * 
 * Architecture:
 * - One tmux SESSION per workspace (directory)
 * - Multiple PANES within each session (user can create new terminals)
 * - Sessions persist across page refresh, server restart
 * 
 * Naming: openchamber-<workspace-hash>
 * Panes: Referenced by index within session
 */

import { Hono } from 'hono'
import { $ } from 'bun'
import { createHash } from 'crypto'
import { getOpenCodeWorkingDirectory } from '../lib/opencode'

interface StreamSubscriber {
  writer: WritableStreamDefaultWriter
  paneIndex: number
}

interface TmuxSessionTracker {
  tmuxName: string
  workspace: string
  subscribers: Map<string, StreamSubscriber> // subscriberId -> subscriber
  streamProcs: Map<number, ReturnType<typeof Bun.spawn>> // paneIndex -> proc
  pendingData: Map<number, string> // paneIndex -> pending data
  flushTimers: Map<number, ReturnType<typeof setTimeout>> // paneIndex -> timer
}

// Active streaming connections
const activeStreams = new Map<string, TmuxSessionTracker>()

// Batch interval for output (16ms = ~60fps)
const BATCH_INTERVAL_MS = 16

// Hash workspace path to create short, filesystem-safe identifier
function hashWorkspace(workspace: string): string {
  return createHash('md5').update(workspace).digest('hex').slice(0, 8)
}

function getTmuxSessionName(workspace: string): string {
  const hash = hashWorkspace(workspace)
  return `openchamber-${hash}`
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

// Get pane count in session
async function getPaneCount(tmuxName: string): Promise<number> {
  try {
    const output = await $`tmux list-panes -t ${tmuxName} -F "#{pane_index}"`.text()
    return output.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

// Get pane info
interface PaneInfo {
  index: number
  active: boolean
  pid: number
  currentCommand: string
  title: string
}

async function listPanes(tmuxName: string): Promise<PaneInfo[]> {
  try {
    const output = await $`tmux list-panes -t ${tmuxName} -F "#{pane_index}:#{pane_active}:#{pane_pid}:#{pane_current_command}:#{pane_title}"`.text()
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [index, active, pid, cmd, title] = line.split(':')
        return {
          index: parseInt(index),
          active: active === '1',
          pid: parseInt(pid),
          currentCommand: cmd || 'shell',
          title: title || `Terminal ${parseInt(index) + 1}`
        }
      })
  } catch {
    return []
  }
}

// Create tmux session (first pane)
async function createTmuxSession(name: string, workspace: string, cols: number, rows: number): Promise<void> {
  const shell = getDefaultShell()
  await $`tmux new-session -d -s ${name} -x ${cols} -y ${rows} -c ${workspace} ${shell}`.quiet()
}

// Create new pane in existing session
async function createPane(tmuxName: string, workspace: string): Promise<number> {
  const shell = getDefaultShell()
  // Split horizontally (creates new pane below), then get its index
  await $`tmux split-window -t ${tmuxName} -v -c ${workspace} ${shell}`.quiet()
  // Get the index of the newly created pane (it becomes active)
  const output = await $`tmux display-message -t ${tmuxName} -p "#{pane_index}"`.text()
  return parseInt(output.trim())
}

// Kill specific pane
async function killPane(tmuxName: string, paneIndex: number): Promise<void> {
  try {
    await $`tmux kill-pane -t ${tmuxName}:0.${paneIndex}`.quiet()
  } catch {
    // Pane might already be dead
  }
}

// Kill entire tmux session
async function killTmuxSession(name: string): Promise<void> {
  try {
    await $`tmux kill-session -t ${name}`.quiet()
  } catch {
    // Session might already be dead
  }
}

// Resize pane
async function resizePane(tmuxName: string, paneIndex: number, cols: number, rows: number): Promise<void> {
  try {
    await $`tmux resize-pane -t ${tmuxName}:0.${paneIndex} -x ${cols} -y ${rows}`.quiet()
  } catch {
    // Ignore resize errors
  }
}

// Send input to specific pane
async function sendToPane(tmuxName: string, paneIndex: number, data: string): Promise<void> {
  try {
    await $`tmux send-keys -t ${tmuxName}:0.${paneIndex} -l ${data}`.quiet()
  } catch (error) {
    // Check if session/pane exists before throwing
    const exists = await tmuxSessionExists(tmuxName)
    if (!exists) {
      throw new Error(`Session ${tmuxName} not found`)
    }
    const panes = await listPanes(tmuxName)
    if (!panes.find(p => p.index === paneIndex)) {
      throw new Error(`Pane ${paneIndex} not found in session ${tmuxName}`)
    }
    throw error
  }
}

// Capture pane content
async function capturePane(tmuxName: string, paneIndex: number, lines: number = 500): Promise<string> {
  try {
    const output = await $`tmux capture-pane -t ${tmuxName}:0.${paneIndex} -p -S -${lines}`.text()
    return output
  } catch {
    return ''
  }
}

// Get or create session tracker
function getOrCreateTracker(tmuxName: string, workspace: string): TmuxSessionTracker {
  let tracker = activeStreams.get(tmuxName)
  if (!tracker) {
    tracker = {
      tmuxName,
      workspace,
      subscribers: new Map(),
      streamProcs: new Map(),
      pendingData: new Map(),
      flushTimers: new Map(),
    }
    activeStreams.set(tmuxName, tracker)
  }
  return tracker
}

// Flush pending data for a pane
function flushPaneData(tracker: TmuxSessionTracker, paneIndex: number): void {
  const data = tracker.pendingData.get(paneIndex)
  if (!data || data.length === 0) return
  
  tracker.pendingData.set(paneIndex, '')
  tracker.flushTimers.delete(paneIndex)

  // Send to subscribers watching this pane
  for (const [subId, sub] of tracker.subscribers) {
    if (sub.paneIndex === paneIndex) {
      sub.writer.write(`data: ${JSON.stringify({ data, pane: paneIndex })}\n\n`).catch(() => {
        tracker.subscribers.delete(subId)
      })
    }
  }
}

// Start streaming for a specific pane
function startPaneStream(tracker: TmuxSessionTracker, paneIndex: number): void {
  if (tracker.streamProcs.has(paneIndex)) return

  // Use script to capture PTY output properly
  const streamProc = Bun.spawn([
    'bash', '-c',
    `tmux pipe-pane -t "${tracker.tmuxName}:0.${paneIndex}" -O "cat" && sleep infinity`
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  tracker.streamProcs.set(paneIndex, streamProc)
  tracker.pendingData.set(paneIndex, '')

  const reader = (streamProc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  const readLoop = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const pending = (tracker.pendingData.get(paneIndex) || '') + text
        tracker.pendingData.set(paneIndex, pending)

        // Debounce flush
        const existingTimer = tracker.flushTimers.get(paneIndex)
        if (existingTimer) clearTimeout(existingTimer)
        tracker.flushTimers.set(paneIndex, setTimeout(() => flushPaneData(tracker, paneIndex), BATCH_INTERVAL_MS))
      }
    } catch {
      // Stream ended
    }

    // Cleanup
    const timer = tracker.flushTimers.get(paneIndex)
    if (timer) {
      clearTimeout(timer)
      flushPaneData(tracker, paneIndex)
    }
    tracker.streamProcs.delete(paneIndex)
  }

  readLoop()
}

export function createTerminalRoutes() {
  const terminal = new Hono()

  // Create or get terminal session for workspace
  // Returns existing session if one exists, or creates new one
  terminal.post('/create', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workspace = cwd || getOpenCodeWorkingDirectory()
    const tmuxName = getTmuxSessionName(workspace)

    try {
      const exists = await tmuxSessionExists(tmuxName)
      
      if (exists) {
        // Session exists, return info about it
        const panes = await listPanes(tmuxName)
        console.log(`[terminal] Reconnecting to existing tmux session: ${tmuxName}`)
        return c.json({
          sessionId: tmuxName,
          workspace,
          panes,
          activePaneIndex: panes.find(p => p.active)?.index ?? 0,
          isNew: false,
          persistent: true
        })
      }

      // Create new session
      await createTmuxSession(tmuxName, workspace, cols, rows)
      const panes = await listPanes(tmuxName)
      
      console.log(`[terminal] Created tmux session: ${tmuxName} in ${workspace}`)

      return c.json({
        sessionId: tmuxName,
        workspace,
        panes,
        activePaneIndex: 0,
        isNew: true,
        persistent: true
      })
    } catch (error) {
      console.error('[terminal/create]', error)
      return c.json({ error: 'Failed to create terminal' }, 500)
    }
  })

  // Create new pane in existing session
  terminal.post('/pane/create', async (c) => {
    const { sessionId, cwd } = await c.req.json()
    const workspace = cwd || getOpenCodeWorkingDirectory()
    const tmuxName = sessionId || getTmuxSessionName(workspace)

    try {
      if (!await tmuxSessionExists(tmuxName)) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const paneIndex = await createPane(tmuxName, workspace)
      const panes = await listPanes(tmuxName)

      console.log(`[terminal] Created new pane ${paneIndex} in ${tmuxName}`)

      return c.json({
        sessionId: tmuxName,
        paneIndex,
        panes,
        success: true
      })
    } catch (error) {
      console.error('[terminal/pane/create]', error)
      return c.json({ error: 'Failed to create pane' }, 500)
    }
  })

  // Kill specific pane (but keep session if other panes exist)
  terminal.delete('/pane/:sessionId/:paneIndex', async (c) => {
    const tmuxName = c.req.param('sessionId')
    const paneIndex = parseInt(c.req.param('paneIndex'))

    try {
      const paneCount = await getPaneCount(tmuxName)
      
      if (paneCount <= 1) {
        // Last pane - kill entire session
        await killTmuxSession(tmuxName)
        activeStreams.delete(tmuxName)
        return c.json({ sessionKilled: true, success: true })
      }

      // Kill just this pane
      await killPane(tmuxName, paneIndex)
      
      // Cleanup streaming for this pane
      const tracker = activeStreams.get(tmuxName)
      if (tracker) {
        const proc = tracker.streamProcs.get(paneIndex)
        if (proc) proc.kill()
        tracker.streamProcs.delete(paneIndex)
        tracker.pendingData.delete(paneIndex)
        const timer = tracker.flushTimers.get(paneIndex)
        if (timer) clearTimeout(timer)
        tracker.flushTimers.delete(paneIndex)
      }

      const panes = await listPanes(tmuxName)
      return c.json({ panes, success: true })
    } catch (error) {
      console.error('[terminal/pane/kill]', error)
      return c.json({ error: 'Failed to kill pane' }, 500)
    }
  })

  // List panes in session
  terminal.get('/panes/:sessionId', async (c) => {
    const tmuxName = c.req.param('sessionId')

    try {
      if (!await tmuxSessionExists(tmuxName)) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const panes = await listPanes(tmuxName)
      return c.json({ sessionId: tmuxName, panes })
    } catch (error) {
      console.error('[terminal/panes]', error)
      return c.json({ error: 'Failed to list panes' }, 500)
    }
  })

  // Stream output from specific pane (SSE)
  terminal.get('/stream/:sessionId/:paneIndex', async (c) => {
    const tmuxName = c.req.param('sessionId')
    const paneIndex = parseInt(c.req.param('paneIndex'))

    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const subscriberId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Get workspace from session (extract from name or use cwd)
    const workspace = process.cwd()
    const tracker = getOrCreateTracker(tmuxName, workspace)
    
    tracker.subscribers.set(subscriberId, { writer, paneIndex })

    // Send initial buffer
    const initialBuffer = await capturePane(tmuxName, paneIndex)
    if (initialBuffer) {
      await writer.write(`data: ${JSON.stringify({ data: initialBuffer, pane: paneIndex, initial: true })}\n\n`)
    }

    // Start streaming for this pane
    startPaneStream(tracker, paneIndex)

    // Cleanup on disconnect
    c.req.raw.signal.addEventListener('abort', () => {
      tracker.subscribers.delete(subscriberId)
      writer.close().catch(() => {})

      // Check if anyone else is watching this pane
      const hasOtherSubscribers = Array.from(tracker.subscribers.values())
        .some(sub => sub.paneIndex === paneIndex)
      
      if (!hasOtherSubscribers) {
        const proc = tracker.streamProcs.get(paneIndex)
        if (proc) proc.kill()
        tracker.streamProcs.delete(paneIndex)
      }

      // Cleanup tracker if no subscribers at all
      if (tracker.subscribers.size === 0) {
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

  // Write to specific pane
  terminal.post('/write/:sessionId/:paneIndex', async (c) => {
    const tmuxName = c.req.param('sessionId')
    const paneIndex = parseInt(c.req.param('paneIndex'))

    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { data } = await c.req.json()
    if (data) {
      await sendToPane(tmuxName, paneIndex, data)
    }

    return c.json({ success: true })
  })

  // Resize specific pane
  terminal.post('/resize/:sessionId/:paneIndex', async (c) => {
    const tmuxName = c.req.param('sessionId')
    const paneIndex = parseInt(c.req.param('paneIndex'))

    if (!await tmuxSessionExists(tmuxName)) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const { cols, rows } = await c.req.json()
    if (cols && rows) {
      await resizePane(tmuxName, paneIndex, cols, rows)
    }

    return c.json({ success: true })
  })

  // Kill entire session (all panes)
  terminal.delete('/session/:sessionId', async (c) => {
    const tmuxName = c.req.param('sessionId')

    // Cleanup streaming
    const tracker = activeStreams.get(tmuxName)
    if (tracker) {
      for (const proc of tracker.streamProcs.values()) {
        proc.kill()
      }
      for (const timer of tracker.flushTimers.values()) {
        clearTimeout(timer)
      }
      for (const sub of tracker.subscribers.values()) {
        sub.writer.close().catch(() => {})
      }
      activeStreams.delete(tmuxName)
    }

    await killTmuxSession(tmuxName)
    console.log(`[terminal] Killed tmux session: ${tmuxName}`)

    return c.json({ success: true })
  })

  // Force kill all sessions for workspace and create fresh
  terminal.post('/reset', async (c) => {
    const { cwd, cols = 80, rows = 24 } = await c.req.json()
    const workspace = cwd || process.cwd()
    const tmuxName = getTmuxSessionName(workspace)

    try {
      // Kill existing
      const tracker = activeStreams.get(tmuxName)
      if (tracker) {
        for (const proc of tracker.streamProcs.values()) proc.kill()
        for (const timer of tracker.flushTimers.values()) clearTimeout(timer)
        for (const sub of tracker.subscribers.values()) sub.writer.close().catch(() => {})
        activeStreams.delete(tmuxName)
      }
      await killTmuxSession(tmuxName)

      // Create fresh
      await createTmuxSession(tmuxName, workspace, cols, rows)
      const panes = await listPanes(tmuxName)

      console.log(`[terminal] Reset tmux session: ${tmuxName}`)

      return c.json({
        sessionId: tmuxName,
        workspace,
        panes,
        activePaneIndex: 0,
        isNew: true,
        persistent: true
      })
    } catch (error) {
      console.error('[terminal/reset]', error)
      return c.json({ error: 'Failed to reset terminal' }, 500)
    }
  })

  // Legacy compatibility endpoints (redirect to new API)
  terminal.get('/stream/:id', async (c) => {
    const id = c.req.param('id')
    // Assume pane 0 for legacy
    return c.redirect(`/api/terminal/stream/${id}/0`)
  })

  terminal.post('/write/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json()
    // Forward to pane 0
    const resp = await fetch(`${c.req.url.replace(`/write/${id}`, `/write/${id}/0`)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return resp
  })

  return terminal
}

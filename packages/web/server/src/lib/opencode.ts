/**
 * OpenCode process management using Bun-native APIs
 * Uses globalThis to persist state across HMR reloads
 */

import { $ } from 'bun'
import { homedir } from 'os'

// State persisted across HMR via globalThis
type OpenCodeState = {
  port: number | null
  proc: ReturnType<typeof Bun.spawn> | null
  workdir: string
}

const globalState = globalThis as {
  __openCodeState?: OpenCodeState
}

// Initialize or reuse existing state (survives HMR)
const state: OpenCodeState = globalState.__openCodeState ?? {
  port: null,
  proc: null,
  workdir: homedir(),
}
globalState.__openCodeState = state

export function getOpenCodePort(): number | null {
  return state.port
}

export function setOpenCodePort(port: number): void {
  state.port = port
}

export function getOpenCodeWorkingDirectory(): string {
  return state.workdir
}

export function setOpenCodeWorkingDirectory(dir: string): void {
  state.workdir = dir
}

export async function ensureOpenCodeRunning(workdir: string): Promise<number> {
  // Check if port is provided via environment
  const envPort = Bun.env.OPENCODE_PORT
  if (envPort) {
    state.port = parseInt(envPort, 10)
    console.log(`[opencode] Using port from environment: ${state.port}`)
    return state.port
  }

  // If we already have a running process from before HMR, verify it's still alive
  if (state.proc && state.port) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/session`, {
        signal: AbortSignal.timeout(2000)
      }).catch(() => null)
      
      if (response?.ok) {
        console.log(`[opencode] Reusing existing instance on port ${state.port}`)
        return state.port
      }
    } catch {
      // Process died, will restart
    }
    // Process reference exists but not responding - clean up
    state.proc = null
    state.port = null
  }

  // Check if opencode is already running by looking for its port
  try {
    const existingPort = await detectExistingOpenCode(workdir)
    if (existingPort) {
      state.port = existingPort
      console.log(`[opencode] Found existing instance on port ${state.port}`)
      return state.port
    }
  } catch {
    // No existing instance, will start new one
  }

  // Start new OpenCode instance
  return startOpenCode(workdir)
}

async function detectExistingOpenCode(workdir: string): Promise<number | null> {
  // Try to find OpenCode config or socket
  const configPath = `${workdir}/.opencode/api.json`
  const file = Bun.file(configPath)
  
  if (await file.exists()) {
    try {
      const config = await file.json()
      if (config.port) {
        // Verify it's responding
        const response = await fetch(`http://127.0.0.1:${config.port}/session`, {
          signal: AbortSignal.timeout(2000)
        }).catch(() => null)
        
        if (response?.ok) {
          return config.port
        }
      }
    } catch {
      // Config exists but invalid/stale
    }
  }
  
  return null
}

async function startOpenCode(workdir: string): Promise<number> {
  console.log(`[opencode] Starting in ${workdir}...`)
  
  // Use dynamic port assignment
  state.proc = Bun.spawn(['opencode', 'serve', '--port', '0'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      TERM: 'xterm-256color',
    },
  })

  // Wait for port detection from stdout
  const port = await waitForPort(state.proc)
  state.port = port
  
  console.log(`[opencode] Started on port ${port}`)
  return port
}

async function waitForPort(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  const decoder = new TextDecoder()
  const portRegex = /listening on http:\/\/[\d.]+:(\d+)/i
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for OpenCode port'))
    }, 30000)
    
    const stdout = proc.stdout
    if (!stdout || typeof stdout === 'number') {
      clearTimeout(timeout)
      reject(new Error('No stdout stream available'))
      return
    }
    
    const reader = (stdout as ReadableStream<Uint8Array>).getReader()
    
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          
          const text = decoder.decode(value)
          console.log(`[opencode] ${text.trim()}`)
          
          const match = text.match(portRegex)
          if (match) {
            clearTimeout(timeout)
            resolve(parseInt(match[1], 10))
            return
          }
        }
        clearTimeout(timeout)
        reject(new Error('OpenCode process ended without providing port'))
      } catch (e) {
        clearTimeout(timeout)
        reject(e)
      }
    }
    
    read()
  })
}

export async function stopOpenCode(): Promise<void> {
  if (state.proc) {
    console.log(`[opencode] Stopping process...`)
    state.proc.kill()
    state.proc = null
    state.port = null
  }
}

/**
 * Restart OpenCode with a new working directory
 * Called when user switches directories in UI
 */
export async function restartOpenCode(newWorkdir: string): Promise<number> {
  console.log(`[opencode] Restarting with new directory: ${newWorkdir}`)
  
  // Check if directory actually changed and process is healthy
  if (state.workdir === newWorkdir && state.port && state.proc) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/session`, {
        signal: AbortSignal.timeout(2000)
      }).catch(() => null)
      
      if (response?.ok) {
        console.log(`[opencode] Directory unchanged and process healthy, skipping restart`)
        return state.port
      }
    } catch {
      // Process not responding, will restart
    }
  }
  
  // Stop existing process
  await stopOpenCode()
  
  // Update tracked directory
  state.workdir = newWorkdir
  
  // Start with new directory
  return startOpenCode(newWorkdir)
}

/**
 * Kill all orphaned opencode processes (dev cleanup)
 * Use sparingly - only for cleaning up after crashes/bugs
 */
export async function killOrphanedOpenCodeProcesses(): Promise<void> {
  try {
    // Only kill processes running with --port 0 (dynamically assigned)
    await $`pkill -f "opencode serve --port 0"`.quiet()
    console.log(`[opencode] Killed orphaned processes`)
  } catch {
    // No processes to kill or pkill failed - that's fine
  }
}

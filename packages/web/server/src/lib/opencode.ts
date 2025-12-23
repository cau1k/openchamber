/**
 * OpenCode process management with API prefix detection
 * Ported from Express server with full prefix detection logic
 */

import { homedir } from 'os'
import { serveTailscalePort, stopTailscalePort } from './tailscale'

// API prefix candidates to probe
const API_PREFIX_CANDIDATES = ['', '/api']

// State persisted across HMR via globalThis
type OpenCodeState = {
  port: number | null
  proc: ReturnType<typeof Bun.spawn> | null
  workdir: string
  apiPrefix: string
  apiPrefixDetected: boolean
  isReady: boolean
  isRestarting: boolean
  lastError: string | null
}

const globalState = globalThis as {
  __openCodeState?: OpenCodeState
}

// Initialize or reuse existing state (survives HMR)
const state: OpenCodeState = globalState.__openCodeState ?? {
  port: null,
  proc: null,
  workdir: homedir(),
  apiPrefix: '',
  apiPrefixDetected: false,
  isReady: false,
  isRestarting: false,
  lastError: null,
}
globalState.__openCodeState = state

// Getters
export function getOpenCodePort(): number | null {
  return state.port
}

export function getOpenCodeWorkingDirectory(): string {
  return state.workdir
}

export function getOpenCodeApiPrefix(): string {
  return state.apiPrefix
}

export function isOpenCodeApiPrefixDetected(): boolean {
  return state.apiPrefixDetected
}

export function isOpenCodeReady(): boolean {
  return state.isReady
}

export function isOpenCodeRestarting(): boolean {
  return state.isRestarting
}

export function getOpenCodeLastError(): string | null {
  return state.lastError
}

// Setters
export function setOpenCodePort(port: number): void {
  state.port = port
}

export function setOpenCodeWorkingDirectory(dir: string): void {
  state.workdir = dir
}

export function setOpenCodeApiPrefix(prefix: string): void {
  state.apiPrefix = normalizeApiPrefix(prefix)
  state.apiPrefixDetected = true
  console.log(`[opencode] API prefix detected: ${state.apiPrefix || '(root)'}`)
}

// Normalize API prefix (ensure leading slash, no trailing slash)
function normalizeApiPrefix(prefix: string): string {
  if (!prefix) return ''
  let normalized = prefix.trim()
  if (!normalized || normalized === '/') return ''
  if (!normalized.startsWith('/')) normalized = '/' + normalized
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

// Build URL to OpenCode API with proper prefix
export function buildOpenCodeUrl(path: string, prefixOverride?: string): string {
  if (!state.port) {
    throw new Error('OpenCode port is not available')
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const prefix = prefixOverride !== undefined 
    ? normalizeApiPrefix(prefixOverride) 
    : (state.apiPrefixDetected ? state.apiPrefix : '')
  return `http://127.0.0.1:${state.port}${prefix}${normalizedPath}`
}

// Detect API prefix by probing endpoints
async function detectApiPrefix(): Promise<boolean> {
  if (!state.port) return false
  if (state.apiPrefixDetected) return true

  console.log('[opencode] Detecting API prefix...')

  // Try each candidate prefix
  for (const candidate of API_PREFIX_CANDIDATES) {
    try {
      const url = `http://127.0.0.1:${state.port}${candidate}/config`
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })

      if (response.ok) {
        // Verify it returns JSON
        const data = await response.json().catch(() => null)
        if (data !== null) {
          setOpenCodeApiPrefix(candidate)
          return true
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback: try /doc endpoint to detect prefix from HTML
  for (const candidate of API_PREFIX_CANDIDATES) {
    try {
      const url = `http://127.0.0.1:${state.port}${candidate}/doc`
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: AbortSignal.timeout(3000),
      })

      if (response.ok) {
        const text = await response.text()
        // Look for __OPENCODE_API_BASE__ in the doc HTML
        const match = text.match(/__OPENCODE_API_BASE__\s*=\s*['"]([^'"]+)['"]/)
        if (match?.[1]) {
          setOpenCodeApiPrefix(match[1])
          return true
        }
        // If doc exists at this prefix, use it
        setOpenCodeApiPrefix(candidate)
        return true
      }
    } catch {
      // Try next candidate
    }
  }

  console.warn('[opencode] Could not detect API prefix, defaulting to root')
  state.apiPrefix = ''
  state.apiPrefixDetected = true
  return true
}

// Wait for OpenCode to be ready (health + config endpoints responding)
async function waitForReady(timeoutMs = 20000): Promise<void> {
  if (!state.port) {
    throw new Error('OpenCode port is not available')
  }

  const deadline = Date.now() + timeoutMs
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    // Detect prefix first
    const prefixDetected = await detectApiPrefix()
    if (!prefixDetected) {
      await sleep(400)
      continue
    }

    try {
      // Check config endpoint
      const configUrl = buildOpenCodeUrl('/config')
      const configResponse = await fetch(configUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })

      if (!configResponse.ok) {
        lastError = new Error(`Config endpoint returned ${configResponse.status}`)
        await sleep(400)
        continue
      }

      // Check session endpoint
      const sessionUrl = buildOpenCodeUrl('/session')
      const sessionResponse = await fetch(sessionUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })

      if (!sessionResponse.ok) {
        lastError = new Error(`Session endpoint returned ${sessionResponse.status}`)
        await sleep(400)
        continue
      }

      // All good
      state.isReady = true
      state.lastError = null
      console.log('[opencode] Ready')
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(400)
    }
  }

  state.lastError = lastError?.message || 'Timeout waiting for OpenCode'
  throw lastError || new Error('Timeout waiting for OpenCode to become ready')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Start OpenCode process
async function startProcess(workdir: string): Promise<number> {
  console.log(`[opencode] Starting in ${workdir}...`)
  
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
  state.workdir = workdir
  
  console.log(`[opencode] Started on port ${port}`)
  return port
}

async function waitForPort(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  const decoder = new TextDecoder()
  // Match various port announcement formats
  const portRegex = /(?:listening on|server running at|http:\/\/)[\s]*(?:http:\/\/)?[\d.]+:(\d+)/i
  
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

// Ensure OpenCode is running
export async function ensureOpenCodeRunning(workdir: string): Promise<number> {
  // Check if port is provided via environment
  const envPort = Bun.env.OPENCODE_PORT
  if (envPort) {
    state.port = parseInt(envPort, 10)
    state.workdir = workdir
    console.log(`[opencode] Using port from environment: ${state.port}`)
    
    // Still need to detect API prefix
    await detectApiPrefix()
    await waitForReady(10000).catch(() => {
      console.warn('[opencode] Readiness check failed but continuing with env port')
    })
    
    return state.port
  }

  // If we already have a running process, verify it's still alive
  if (state.proc && state.port) {
    try {
      const response = await fetch(buildOpenCodeUrl('/session'), {
        signal: AbortSignal.timeout(2000)
      }).catch(() => null)
      
      if (response?.ok) {
        console.log(`[opencode] Reusing existing instance on port ${state.port}`)
        return state.port
      }
    } catch {
      // Process died, will restart
    }
    state.proc = null
    state.port = null
    state.apiPrefixDetected = false
    state.isReady = false
  }

  // Start new OpenCode instance
  const port = await startProcess(workdir)
  
  // Forward port via tailscale if enabled
  await serveTailscalePort(port)
  
  // Wait for it to be ready
  try {
    await waitForReady()
  } catch (error) {
    console.warn('[opencode] Readiness check failed:', error)
    // Continue anyway - the proxy will retry
  }
  
  return port
}

// Stop OpenCode process
export async function stopOpenCode(): Promise<void> {
  if (state.proc) {
    console.log(`[opencode] Stopping process...`)
    
    // Stop tailscale serve for this port
    if (state.port) {
      await stopTailscalePort(state.port)
    }
    
    state.proc.kill()
    state.proc = null
    state.port = null
    state.apiPrefixDetected = false
    state.isReady = false
  }
}

// Restart OpenCode with a new working directory
export async function restartOpenCode(newWorkdir: string): Promise<number> {
  console.log(`[opencode] Restarting with new directory: ${newWorkdir}`)
  
  state.isRestarting = true
  state.isReady = false
  
  try {
    // Check if directory actually changed and process is healthy
    if (state.workdir === newWorkdir && state.port && state.proc) {
      try {
        const response = await fetch(buildOpenCodeUrl('/session'), {
          signal: AbortSignal.timeout(2000)
        }).catch(() => null)
        
        if (response?.ok) {
          console.log(`[opencode] Directory unchanged and process healthy, skipping restart`)
          state.isRestarting = false
          state.isReady = true
          return state.port
        }
      } catch {
        // Process not responding, will restart
      }
    }
    
    // Stop existing process (this also stops tailscale for old port)
    await stopOpenCode()
    
    // Reset detection state
    state.apiPrefixDetected = false
    state.apiPrefix = ''
    
    // Brief pause before restart
    await sleep(250)
    
    // Start with new directory
    const port = await startProcess(newWorkdir)
    
    // Forward new port via tailscale if enabled
    await serveTailscalePort(port)
    
    // Wait for it to be ready
    await waitForReady()
    
    return port
  } finally {
    state.isRestarting = false
  }
}

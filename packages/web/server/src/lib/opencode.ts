/**
 * OpenCode process management using Bun-native APIs
 */

import { $ } from 'bun'
import { homedir } from 'os'

let openCodePort: number | null = null
let openCodeProcess: ReturnType<typeof Bun.spawn> | null = null
// Global working directory state - tracks what directory OpenCode is running in
let openCodeWorkingDirectory: string = homedir()

export function getOpenCodePort(): number | null {
  return openCodePort
}

export function setOpenCodePort(port: number): void {
  openCodePort = port
}

export function getOpenCodeWorkingDirectory(): string {
  return openCodeWorkingDirectory
}

export function setOpenCodeWorkingDirectory(dir: string): void {
  openCodeWorkingDirectory = dir
}

export async function ensureOpenCodeRunning(workdir: string): Promise<number> {
  // Check if port is provided via environment
  const envPort = Bun.env.OPENCODE_PORT
  if (envPort) {
    openCodePort = parseInt(envPort, 10)
    console.log(`[opencode] Using port from environment: ${openCodePort}`)
    return openCodePort
  }

  // Check if opencode is already running by looking for its port
  try {
    const existingPort = await detectExistingOpenCode(workdir)
    if (existingPort) {
      openCodePort = existingPort
      console.log(`[opencode] Found existing instance on port ${openCodePort}`)
      return openCodePort
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
  openCodeProcess = Bun.spawn(['opencode', 'serve', '--port', '0'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...Bun.env,
      TERM: 'xterm-256color',
    },
  })

  // Wait for port detection from stdout
  const port = await waitForPort(openCodeProcess)
  openCodePort = port
  
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
  if (openCodeProcess) {
    openCodeProcess.kill()
    openCodeProcess = null
    openCodePort = null
  }
}

/**
 * Restart OpenCode with a new working directory
 * Called when user switches directories in UI
 */
export async function restartOpenCode(newWorkdir: string): Promise<number> {
  console.log(`[opencode] Restarting with new directory: ${newWorkdir}`)
  
  // Check if directory actually changed
  if (openCodeWorkingDirectory === newWorkdir && openCodePort) {
    console.log(`[opencode] Directory unchanged, skipping restart`)
    return openCodePort
  }
  
  // Stop existing process
  await stopOpenCode()
  
  // Update tracked directory
  openCodeWorkingDirectory = newWorkdir
  
  // Start with new directory
  return startOpenCode(newWorkdir)
}

/**
 * Tailscale serve manager for forwarding multiple ports
 * Tracks active serves and cleans up on shutdown
 */

type TailscaleState = {
  enabled: boolean
  activePorts: Set<number>
  hostname: string | null
}

const globalState = globalThis as {
  __tailscaleState?: TailscaleState
}

const state: TailscaleState = globalState.__tailscaleState ?? {
  enabled: false,
  activePorts: new Set(),
  hostname: null,
}
globalState.__tailscaleState = state

export function isTailscaleEnabled(): boolean {
  return state.enabled
}

export function enableTailscale(): void {
  state.enabled = true
}

export function disableTailscale(): void {
  state.enabled = false
}

export function getActiveTailscalePorts(): number[] {
  return Array.from(state.activePorts)
}

export function getTailscaleHostname(): string | null {
  return state.hostname
}

async function detectHostname(): Promise<string | null> {
  if (state.hostname) return state.hostname
  
  try {
    const result = await Bun.$`tailscale status --json`.quiet()
    if (result.exitCode === 0) {
      const status = JSON.parse(result.stdout.toString())
      const hostname = status.Self?.DNSName?.replace(/\.$/, '')
      if (hostname) {
        state.hostname = hostname
        return hostname
      }
    }
  } catch {
    // Ignore
  }
  return null
}

async function isTailscaleAvailable(): Promise<boolean> {
  try {
    const result = await Bun.$`which tailscale`.quiet()
    return result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Start tailscale serve for a port
 * Only runs if tailscale is enabled via enableTailscale()
 */
export async function serveTailscalePort(port: number): Promise<boolean> {
  if (!state.enabled) return false
  if (state.activePorts.has(port)) {
    console.log(`[tailscale] Port ${port} already being served`)
    return true
  }

  if (!(await isTailscaleAvailable())) {
    console.warn('[tailscale] tailscale not found in PATH, skipping serve')
    return false
  }

  try {
    // Use --http to expose as HTTP (not HTTPS) since we don't have SSL certs
    const result = await Bun.$`tailscale serve --bg --http ${port} http://127.0.0.1:${port}`.quiet()
    if (result.exitCode === 0) {
      state.activePorts.add(port)
      const hostname = await detectHostname()
      console.log(`[tailscale] Serving port ${port}`)
      if (hostname) {
        console.log(`[tailscale] URL: http://${hostname}:${port}`)
      }
      return true
    } else {
      console.warn(`[tailscale] Failed to serve port ${port}: ${result.stderr.toString()}`)
      return false
    }
  } catch (error) {
    console.warn(`[tailscale] Error serving port ${port}: ${error instanceof Error ? error.message : error}`)
    return false
  }
}

/**
 * Stop tailscale serve for a specific port
 */
export async function stopTailscalePort(port: number): Promise<void> {
  if (!state.activePorts.has(port)) return

  try {
    await Bun.$`tailscale serve --remove ${port}`.quiet()
    state.activePorts.delete(port)
    console.log(`[tailscale] Stopped serving port ${port}`)
  } catch {
    // Ignore errors on cleanup
    state.activePorts.delete(port)
  }
}

/**
 * Stop all tailscale serves and reset state
 */
export async function stopAllTailscale(): Promise<void> {
  if (state.activePorts.size === 0) return

  console.log(`[tailscale] Stopping all serves (${state.activePorts.size} ports)...`)
  
  try {
    // Reset clears all serves
    await Bun.$`tailscale serve reset`.quiet()
    state.activePorts.clear()
    console.log('[tailscale] All serves stopped')
  } catch {
    // Force clear state even if command fails
    state.activePorts.clear()
  }
}

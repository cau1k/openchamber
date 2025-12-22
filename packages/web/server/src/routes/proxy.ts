/**
 * OpenCode API proxy using native fetch()
 * Replaces http-proxy-middleware
 * 
 * Includes retry logic to handle port changes during OpenCode restarts
 */

import type { Context } from 'hono'
import { getOpenCodePort } from '../lib/opencode'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createApiProxy() {
  return async (c: Context) => {
    const path = c.req.path.replace('/api', '')
    
    let lastError: Error | null = null
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const port = getOpenCodePort()
      if (!port) {
        // No port yet - wait and retry
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        return c.json({ error: 'OpenCode not available' }, 503)
      }

      const url = `http://127.0.0.1:${port}${path}`
      
      try {
        // Clone headers, removing host
        const headers = new Headers()
        c.req.raw.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'host') {
            headers.set(key, value)
          }
        })

        const response = await fetch(url, {
          method: c.req.method,
          headers,
          body: c.req.method !== 'GET' && c.req.method !== 'HEAD' 
            ? c.req.raw.body 
            : undefined,
          // @ts-expect-error - Bun supports duplex
          duplex: 'half',
          signal: AbortSignal.timeout(30000),
        })

        // Stream the response back
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const errCode = (error as { code?: string })?.code
        
        // Retry on connection errors (process restarting)
        if (errCode === 'ECONNRESET' || errCode === 'ConnectionRefused' || errCode === 'ECONNREFUSED') {
          if (attempt < MAX_RETRIES - 1) {
            console.log(`[proxy] Connection failed to ${url}, retrying in ${RETRY_DELAY_MS}ms... (attempt ${attempt + 1}/${MAX_RETRIES})`)
            await sleep(RETRY_DELAY_MS)
            continue
          }
        }
        
        console.error(`[proxy] Error proxying to ${url}:`, error)
        break
      }
    }
    
    return c.json({ 
      error: 'Proxy error', 
      details: lastError?.message || 'Unknown error' 
    }, 502)
  }
}

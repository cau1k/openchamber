/**
 * OpenCode API proxy with proper prefix detection and SSE handling
 * Ported from Express http-proxy-middleware implementation
 */

import type { Context } from 'hono'
import { 
  getOpenCodePort, 
  getOpenCodeApiPrefix, 
  isOpenCodeApiPrefixDetected,
  isOpenCodeReady,
  isOpenCodeRestarting,
} from '../lib/opencode'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Rewrite path from client format to OpenCode format
 * Client sends: /api/session
 * If OpenCode prefix is '/api': forward to /api/session
 * If OpenCode prefix is '': forward to /session
 */
function rewritePath(clientPath: string): string {
  // Strip /api from client path
  const suffix = clientPath.startsWith('/api') ? clientPath.slice(4) : clientPath
  const normalizedSuffix = suffix || '/'
  
  // Apply detected prefix
  const prefix = isOpenCodeApiPrefixDetected() ? getOpenCodeApiPrefix() : ''
  return `${prefix}${normalizedSuffix}`
}

export function createApiProxy() {
  return async (c: Context) => {
    const clientPath = c.req.path
    const isSSE = c.req.header('accept')?.includes('text/event-stream')
    
    // Check if OpenCode is restarting - return 503 to trigger client retry
    if (isOpenCodeRestarting()) {
      return c.json({ error: 'OpenCode is restarting', restarting: true }, 503)
    }
    
    // Check ready state with grace period
    if (!isOpenCodeReady() && !isOpenCodeRestarting()) {
      // Allow requests during grace period
      const port = getOpenCodePort()
      if (!port) {
        return c.json({ error: 'OpenCode not available' }, 503)
      }
    }
    
    let lastError: Error | null = null
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const port = getOpenCodePort()
      if (!port) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        return c.json({ error: 'OpenCode not available' }, 503)
      }

      const rewrittenPath = rewritePath(clientPath)
      const url = `http://127.0.0.1:${port}${rewrittenPath}`
      
      // Preserve query string
      const queryString = c.req.url.split('?')[1]
      const fullUrl = queryString ? `${url}?${queryString}` : url
      
      console.log(`[proxy] ${c.req.method} ${clientPath} -> ${fullUrl}`)
      
      try {
        // Clone headers, removing host
        const headers = new Headers()
        c.req.raw.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'host') {
            headers.set(key, value)
          }
        })

        // For SSE requests, set proper headers
        if (isSSE) {
          headers.set('Accept', 'text/event-stream')
          headers.set('Cache-Control', 'no-cache')
          headers.set('Connection', 'keep-alive')
        }

        // Build fetch options - NO timeout for SSE
        const fetchOptions: RequestInit & { duplex?: string } = {
          method: c.req.method,
          headers,
          body: c.req.method !== 'GET' && c.req.method !== 'HEAD' 
            ? c.req.raw.body 
            : undefined,
          duplex: 'half',
        }
        
        // Only apply timeout for non-SSE requests
        if (!isSSE) {
          fetchOptions.signal = AbortSignal.timeout(30000)
        }

        const response = await fetch(fullUrl, fetchOptions)

        // Build response headers
        const responseHeaders = new Headers(response.headers)
        
        // For SSE, ensure proper headers
        if (isSSE || response.headers.get('content-type')?.includes('text/event-stream')) {
          responseHeaders.set('Content-Type', 'text/event-stream')
          responseHeaders.set('Cache-Control', 'no-cache')
          responseHeaders.set('Connection', 'keep-alive')
          responseHeaders.set('X-Accel-Buffering', 'no')
          responseHeaders.set('X-Content-Type-Options', 'nosniff')
        }

        // Stream the response back
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const errCode = (error as { code?: string })?.code
        const errMessage = lastError.message
        
        // Retry on connection errors (process restarting)
        const isConnectionError = 
          errCode === 'ECONNRESET' || 
          errCode === 'ECONNREFUSED' || 
          errCode === 'ConnectionRefused' ||
          errMessage.includes('ECONNREFUSED') ||
          errMessage.includes('connection refused')
        
        if (isConnectionError && attempt < MAX_RETRIES - 1) {
          console.log(`[proxy] Connection failed to ${fullUrl}, retrying in ${RETRY_DELAY_MS}ms... (attempt ${attempt + 1}/${MAX_RETRIES})`)
          await sleep(RETRY_DELAY_MS)
          continue
        }
        
        console.error(`[proxy] Error proxying to ${fullUrl}:`, error)
        break
      }
    }
    
    return c.json({ 
      error: 'Proxy error', 
      details: lastError?.message || 'Unknown error' 
    }, 502)
  }
}

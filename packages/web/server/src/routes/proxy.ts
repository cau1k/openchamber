/**
 * OpenCode API proxy using native fetch()
 * Replaces http-proxy-middleware
 */

import type { Context } from 'hono'
import { getOpenCodePort } from '../lib/opencode'

export function createApiProxy() {
  return async (c: Context) => {
    const port = getOpenCodePort()
    if (!port) {
      return c.json({ error: 'OpenCode not available' }, 503)
    }

    const path = c.req.path.replace('/api', '')
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
      })

      // Stream the response back
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      console.error(`[proxy] Error proxying to ${url}:`, error)
      return c.json({ 
        error: 'Proxy error', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      }, 502)
    }
  }
}

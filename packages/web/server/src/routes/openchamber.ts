/**
 * OpenChamber-specific routes (not proxied to OpenCode)
 * - models-metadata: proxy to models.dev with CORS
 * - update-check: check for updates
 * - pinned-directories: user's pinned directories
 */

import { Hono } from 'hono'
import { getDataDir, resolveDirectory } from '../lib/paths'
import { getOpenCodeWorkingDirectory, restartOpenCode } from '../lib/opencode'
import { isTailscaleEnabled, getActiveTailscalePorts, getTailscaleHostname } from '../lib/tailscale'
import path from 'path'

const MODELS_DEV_URL = 'https://models.dev/api.json'

export function createOpenchamberRoutes() {
  const router = new Hono()

  // Proxy models.dev to avoid CORS issues
  router.get('/models-metadata', async (c) => {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OpenChamber/1.0',
        },
      })

      if (!response.ok) {
        return c.json({ error: 'Failed to fetch models metadata' }, 502)
      }

      const data = await response.json()
      return c.json(data)
    } catch (error) {
      console.error('[openchamber] Failed to fetch models metadata:', error)
      return c.json({ error: 'Failed to fetch models metadata' }, 500)
    }
  })

  // Update check endpoint
  router.get('/update-check', async (c) => {
    try {
      // Read current version from package.json
      const pkgPath = path.join(import.meta.dir, '..', '..', '..', 'package.json')
      const pkgFile = Bun.file(pkgPath)
      const pkg = await pkgFile.json()
      const currentVersion = pkg.version || '0.0.0'

      // Check GitHub releases for latest version
      const response = await fetch('https://api.github.com/repos/openchamber/openchamber/releases/latest', {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'OpenChamber/1.0',
        },
      })

      if (!response.ok) {
        return c.json({
          currentVersion,
          latestVersion: currentVersion,
          updateAvailable: false,
        })
      }

      const release = await response.json()
      const latestVersion = release.tag_name?.replace(/^v/, '') || currentVersion

      return c.json({
        currentVersion,
        latestVersion,
        updateAvailable: latestVersion !== currentVersion,
        releaseUrl: release.html_url,
      })
    } catch (error) {
      console.error('[openchamber] Update check failed:', error)
      return c.json({ error: 'Update check failed' }, 500)
    }
  })

  // Pinned directories
  const getPinnedPath = () => path.join(getDataDir(), 'pinned-directories.json')

  router.get('/pinned-directories', async (c) => {
    try {
      const pinnedFile = Bun.file(getPinnedPath())
      if (await pinnedFile.exists()) {
        const data = await pinnedFile.json()
        return c.json(data)
      }
      return c.json({ directories: [] })
    } catch {
      return c.json({ directories: [] })
    }
  })

  router.post('/pinned-directories', async (c) => {
    try {
      const body = await c.req.json()
      await Bun.write(getPinnedPath(), JSON.stringify(body, null, 2))
      return c.json({ success: true })
    } catch (error) {
      console.error('[openchamber] Failed to save pinned directories:', error)
      return c.json({ error: 'Failed to save pinned directories' }, 500)
    }
  })

  // Directory management - update OpenCode working directory
  router.post('/directory', async (c) => {
    try {
      const body = await c.req.json()
      const requestedPath = typeof body?.path === 'string' ? body.path.trim() : ''

      if (!requestedPath) {
        return c.json({ error: 'Path is required' }, 400)
      }

      const { path: resolvedPath, error } = await resolveDirectory(requestedPath, {
        requireExists: true,
      })

      if (error || !resolvedPath) {
        const status = (error?.status ?? 400) as 400 | 403 | 500
        c.status(status)
        return c.json({ error: error?.message, ...error })
      }

      // Check if directory actually changed
      const currentDir = getOpenCodeWorkingDirectory()
      if (currentDir === resolvedPath) {
        return c.json({ success: true, restarted: false, path: resolvedPath })
      }

      // Restart OpenCode with new directory
      await restartOpenCode(resolvedPath)

      console.log(`[openchamber] Working directory changed to: ${resolvedPath}`)

      return c.json({
        success: true,
        restarted: true,
        path: resolvedPath,
      })
    } catch (error) {
      console.error('[openchamber] Failed to update working directory:', error)
      return c.json({ error: 'Failed to update working directory' }, 500)
    }
  })

  // Get current working directory
  router.get('/directory', (c) => {
    return c.json({ path: getOpenCodeWorkingDirectory() })
  })

  // Tailscale status endpoint
  router.get('/tailscale', (c) => {
    const enabled = isTailscaleEnabled()
    const ports = getActiveTailscalePorts()
    const hostname = getTailscaleHostname()
    
    return c.json({
      enabled,
      hostname,
      ports,
      urls: hostname ? ports.map(port => ({
        port,
        url: `http://${hostname}:${port}`
      })) : []
    })
  })

  return router
}

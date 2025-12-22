/**
 * OpenChamber-specific routes (not proxied to OpenCode)
 * - models-metadata: proxy to models.dev with CORS
 * - update-check: check for updates
 * - pinned-directories: user's pinned directories
 */

import { Hono } from 'hono'
import { getDataDir } from '../lib/paths'
import path from 'path'

const MODELS_DEV_URL = 'https://models.dev/api.json'

export function createOpenchamberRoutes() {
  const router = new Hono()

  // Proxy models.dev to avoid CORS issues
  router.get('/models-metadata', async (c) => {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        headers: {
          'Accept': 'application/json',
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
          'Accept': 'application/vnd.github.v3+json',
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

  return router
}

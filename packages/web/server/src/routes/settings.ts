/**
 * Settings routes using Bun.file() / Bun.write()
 */

import { Hono } from 'hono'
import { getSettingsPath, getDataDir } from '../lib/paths'
import { mkdir } from 'fs/promises'

interface Settings {
  theme?: 'light' | 'dark' | 'system'
  fontSize?: number
  [key: string]: unknown
}

async function ensureDataDir(): Promise<void> {
  const dir = getDataDir()
  await mkdir(dir, { recursive: true })
}

async function readSettings(): Promise<Settings> {
  const path = getSettingsPath()
  const file = Bun.file(path)
  
  if (!await file.exists()) {
    return {}
  }

  try {
    return await file.json()
  } catch {
    return {}
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await ensureDataDir()
  const path = getSettingsPath()
  await Bun.write(path, JSON.stringify(settings, null, 2))
}

export function createSettingsRoutes() {
  const settings = new Hono()

  // Get all settings
  settings.get('/', async (c) => {
    try {
      const data = await readSettings()
      return c.json(data)
    } catch (error) {
      console.error('[settings/get]', error)
      return c.json({ error: 'Failed to read settings' }, 500)
    }
  })

  // Get single setting
  settings.get('/:key', async (c) => {
    const key = c.req.param('key')
    
    try {
      const data = await readSettings()
      return c.json({ key, value: data[key] ?? null })
    } catch (error) {
      console.error('[settings/get]', error)
      return c.json({ error: 'Failed to read setting' }, 500)
    }
  })

  // Set settings (merge)
  settings.post('/', async (c) => {
    try {
      const updates = await c.req.json()
      const current = await readSettings()
      const merged = { ...current, ...updates }
      await writeSettings(merged)
      return c.json(merged)
    } catch (error) {
      console.error('[settings/post]', error)
      return c.json({ error: 'Failed to save settings' }, 500)
    }
  })

  // Set single setting
  settings.put('/:key', async (c) => {
    const key = c.req.param('key')
    
    try {
      const { value } = await c.req.json()
      const current = await readSettings()
      current[key] = value
      await writeSettings(current)
      return c.json({ key, value })
    } catch (error) {
      console.error('[settings/put]', error)
      return c.json({ error: 'Failed to save setting' }, 500)
    }
  })

  // Delete setting
  settings.delete('/:key', async (c) => {
    const key = c.req.param('key')
    
    try {
      const current = await readSettings()
      delete current[key]
      await writeSettings(current)
      return c.json({ success: true })
    } catch (error) {
      console.error('[settings/delete]', error)
      return c.json({ error: 'Failed to delete setting' }, 500)
    }
  })

  return settings
}

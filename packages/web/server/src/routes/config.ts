/**
 * Config routes (settings, agents, commands, git identities)
 * Matches original Express server's /api/config/* routes
 */

import { Hono } from 'hono'
import { getGitIdentitiesPath, getSettingsPath, getDataDir } from '../lib/paths'
import { mkdir } from 'fs/promises'
import { homedir } from 'os'

// Types
interface GitIdentity {
  id: string
  name: string
  email: string
  signingKey?: string
}

interface Settings {
  themeId?: string
  themeVariant?: 'light' | 'dark'
  useSystemTheme?: boolean
  lightThemeId?: string
  darkThemeId?: string
  lastDirectory?: string
  homeDirectory?: string
  approvedDirectories?: string[]
  securityScopedBookmarks?: string[]
  pinnedDirectories?: string[]
  uiFont?: string
  monoFont?: string
  markdownDisplayMode?: string
  showReasoningTraces?: boolean
  autoDeleteEnabled?: boolean
  autoDeleteAfterDays?: number
  typographySizes?: {
    markdown?: string
    code?: string
    uiHeader?: string
    uiLabel?: string
    meta?: string
    micro?: string
  }
  [key: string]: unknown
}

// Helpers
async function ensureDataDir(): Promise<void> {
  const dir = getDataDir()
  await mkdir(dir, { recursive: true })
}

async function readGitIdentities(): Promise<GitIdentity[]> {
  const path = getGitIdentitiesPath()
  const file = Bun.file(path)
  
  if (!await file.exists()) {
    return []
  }

  try {
    const data = await file.json()
    return data.identities || []
  } catch {
    return []
  }
}

async function writeGitIdentities(identities: GitIdentity[]): Promise<void> {
  await ensureDataDir()
  const path = getGitIdentitiesPath()
  await Bun.write(path, JSON.stringify({ identities }, null, 2))
}

async function readSettings(): Promise<Settings> {
  const path = getSettingsPath()
  const file = Bun.file(path)
  
  if (!await file.exists()) {
    return { homeDirectory: homedir() }
  }

  try {
    const data = await file.json()
    return { homeDirectory: homedir(), ...data }
  } catch {
    return { homeDirectory: homedir() }
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await ensureDataDir()
  const path = getSettingsPath()
  await Bun.write(path, JSON.stringify(settings, null, 2))
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((e): e is string => typeof e === 'string' && e.length > 0))]
}

function sanitizeSettingsUpdate(payload: unknown): Partial<Settings> {
  if (!payload || typeof payload !== 'object') return {}
  
  const candidate = payload as Record<string, unknown>
  const result: Partial<Settings> = {}

  // String fields
  const stringFields = ['themeId', 'lightThemeId', 'darkThemeId', 'lastDirectory', 'homeDirectory', 'uiFont', 'monoFont', 'markdownDisplayMode'] as const
  for (const field of stringFields) {
    if (typeof candidate[field] === 'string' && (candidate[field] as string).length > 0) {
      result[field] = candidate[field] as string
    }
  }

  // Theme variant
  if (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark') {
    result.themeVariant = candidate.themeVariant
  }

  // Boolean fields
  if (typeof candidate.useSystemTheme === 'boolean') result.useSystemTheme = candidate.useSystemTheme
  if (typeof candidate.showReasoningTraces === 'boolean') result.showReasoningTraces = candidate.showReasoningTraces
  if (typeof candidate.autoDeleteEnabled === 'boolean') result.autoDeleteEnabled = candidate.autoDeleteEnabled

  // Auto delete days
  if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
    result.autoDeleteAfterDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)))
  }

  // Array fields
  if (Array.isArray(candidate.approvedDirectories)) {
    result.approvedDirectories = normalizeStringArray(candidate.approvedDirectories)
  }
  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks)
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = normalizeStringArray(candidate.pinnedDirectories)
  }

  // Typography sizes
  if (candidate.typographySizes && typeof candidate.typographySizes === 'object') {
    const typo = candidate.typographySizes as Record<string, unknown>
    const sizes: Settings['typographySizes'] = {}
    const typoFields = ['markdown', 'code', 'uiHeader', 'uiLabel', 'meta', 'micro'] as const
    for (const field of typoFields) {
      if (typeof typo[field] === 'string' && (typo[field] as string).length > 0) {
        sizes[field] = typo[field] as string
      }
    }
    if (Object.keys(sizes).length > 0) {
      result.typographySizes = sizes
    }
  }

  return result
}

function mergeSettings(current: Settings, changes: Partial<Settings>): Settings {
  // Build approved directories list
  const baseApproved = Array.isArray(changes.approvedDirectories)
    ? changes.approvedDirectories
    : Array.isArray(current.approvedDirectories)
      ? current.approvedDirectories
      : []

  const additionalApproved: string[] = []
  if (changes.lastDirectory) additionalApproved.push(changes.lastDirectory)
  if (changes.homeDirectory) additionalApproved.push(changes.homeDirectory)

  // Merge typography sizes
  const typographySizes = changes.typographySizes
    ? { ...(current.typographySizes || {}), ...changes.typographySizes }
    : current.typographySizes

  return {
    ...current,
    ...changes,
    approvedDirectories: normalizeStringArray([...baseApproved, ...additionalApproved]),
    securityScopedBookmarks: normalizeStringArray(
      changes.securityScopedBookmarks ?? current.securityScopedBookmarks ?? []
    ),
    typographySizes,
  }
}

function formatSettingsResponse(settings: Settings): Settings {
  return {
    ...sanitizeSettingsUpdate(settings),
    approvedDirectories: normalizeStringArray(settings.approvedDirectories),
    securityScopedBookmarks: normalizeStringArray(settings.securityScopedBookmarks),
    pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
    showReasoningTraces: settings.showReasoningTraces ?? false,
    homeDirectory: settings.homeDirectory || homedir(),
  }
}

export function createConfigRoutes() {
  const config = new Hono()

  // Settings - GET /api/config/settings
  config.get('/settings', async (c) => {
    try {
      const settings = await readSettings()
      return c.json(formatSettingsResponse(settings))
    } catch (error) {
      console.error('[config/settings] GET error:', error)
      return c.json({ error: 'Failed to read settings' }, 500)
    }
  })

  // Settings - PUT /api/config/settings (merge update)
  config.put('/settings', async (c) => {
    try {
      const body = await c.req.json()
      const sanitized = sanitizeSettingsUpdate(body)
      const current = await readSettings()
      const merged = mergeSettings(current, sanitized)
      await writeSettings(merged)
      return c.json(formatSettingsResponse(merged))
    } catch (error) {
      console.error('[config/settings] PUT error:', error)
      return c.json({ error: 'Failed to save settings' }, 500)
    }
  })

  // Settings - POST (alias for PUT for client compatibility)
  config.post('/settings', async (c) => {
    try {
      const body = await c.req.json()
      const sanitized = sanitizeSettingsUpdate(body)
      const current = await readSettings()
      const merged = mergeSettings(current, sanitized)
      await writeSettings(merged)
      return c.json(formatSettingsResponse(merged))
    } catch (error) {
      console.error('[config/settings] POST error:', error)
      return c.json({ error: 'Failed to save settings' }, 500)
    }
  })

  // Git Identities
  config.get('/git-identities', async (c) => {
    try {
      const identities = await readGitIdentities()
      return c.json({ identities })
    } catch (error) {
      console.error('[config/git-identities]', error)
      return c.json({ error: 'Failed to read git identities' }, 500)
    }
  })

  config.post('/git-identities', async (c) => {
    try {
      const { name, email, signingKey } = await c.req.json()
      
      if (!name || !email) {
        return c.json({ error: 'name and email required' }, 400)
      }

      const identities = await readGitIdentities()
      const id = `id_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      
      identities.push({ id, name, email, signingKey })
      await writeGitIdentities(identities)

      return c.json({ id, name, email, signingKey })
    } catch (error) {
      console.error('[config/git-identities]', error)
      return c.json({ error: 'Failed to create git identity' }, 500)
    }
  })

  config.put('/git-identities/:id', async (c) => {
    const id = c.req.param('id')
    
    try {
      const updates = await c.req.json()
      const identities = await readGitIdentities()
      const index = identities.findIndex(i => i.id === id)
      
      if (index === -1) {
        return c.json({ error: 'Identity not found' }, 404)
      }

      identities[index] = { ...identities[index], ...updates }
      await writeGitIdentities(identities)

      return c.json(identities[index])
    } catch (error) {
      console.error('[config/git-identities]', error)
      return c.json({ error: 'Failed to update git identity' }, 500)
    }
  })

  config.delete('/git-identities/:id', async (c) => {
    const id = c.req.param('id')
    
    try {
      const identities = await readGitIdentities()
      const filtered = identities.filter(i => i.id !== id)
      
      if (filtered.length === identities.length) {
        return c.json({ error: 'Identity not found' }, 404)
      }

      await writeGitIdentities(filtered)
      return c.json({ success: true })
    } catch (error) {
      console.error('[config/git-identities]', error)
      return c.json({ error: 'Failed to delete git identity' }, 500)
    }
  })

  return config
}

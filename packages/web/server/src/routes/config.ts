/**
 * Config routes (agents, commands, git identities)
 * Uses Bun.file() for reading config files
 */

import { Hono } from 'hono'
import { getGitIdentitiesPath } from '../lib/paths'

interface GitIdentity {
  id: string
  name: string
  email: string
  signingKey?: string
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
  const path = getGitIdentitiesPath()
  await Bun.write(path, JSON.stringify({ identities }, null, 2))
}

export function createConfigRoutes() {
  const config = new Hono()

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

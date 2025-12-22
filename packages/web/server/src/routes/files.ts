/**
 * File system routes using Bun.file() / Bun.write()
 */

import { Hono } from 'hono'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { expandTilde, resolveDirectory } from '../lib/paths'

function resolveFilePath(rawPath: string): string {
  return resolve(expandTilde(rawPath))
}

export function createFileRoutes() {
  const files = new Hono()

  // Read file
  files.get('/read', async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) {
      return c.json({ error: 'path required' }, 400)
    }

    const resolvedPath = resolveFilePath(filePath)

    try {
      const file = Bun.file(resolvedPath)
      if (!await file.exists()) {
        return c.json({
          error: 'File not found',
          raw: filePath,
          resolved: resolvedPath,
        }, 404)
      }

      const content = await file.text()
      return c.json({ content, path: resolvedPath })
    } catch (error) {
      console.error('[files/read]', error)
      return c.json({
        error: 'Failed to read file',
        raw: filePath,
        resolved: resolvedPath,
      }, 500)
    }
  })

  // Write file
  files.post('/write', async (c) => {
    const { path: filePath, content } = await c.req.json()
    if (!filePath || content === undefined) {
      return c.json({ error: 'path and content required' }, 400)
    }

    const resolvedPath = resolveFilePath(filePath)

    try {
      await Bun.write(resolvedPath, content)
      return c.json({ success: true, path: resolvedPath })
    } catch (error) {
      console.error('[files/write]', error)
      return c.json({
        error: 'Failed to write file',
        raw: filePath,
        resolved: resolvedPath,
      }, 500)
    }
  })

  // Check if file/directory exists
  files.get('/exists', async (c) => {
    const filePath = c.req.query('path')
    if (!filePath) {
      return c.json({ error: 'path required' }, 400)
    }

    const resolvedPath = resolveFilePath(filePath)
    const file = Bun.file(resolvedPath)
    const exists = await file.exists()
    return c.json({ exists, path: resolvedPath })
  })

  // List directory
  files.get('/list', async (c) => {
    const { path: dirPath, error } = await resolveDirectory(c.req.query('path'), {
      fallback: homedir(),
      requireExists: true,
    })

    if (error || !dirPath) {
      const status = (error?.status ?? 400) as 400 | 403 | 500
      c.status(status)
      return c.json({ error: error?.message, ...error })
    }

    try {
      const glob = new Bun.Glob('*')
      const entries: Array<{ name: string; path: string; isDirectory: boolean; size: number }> = []

      for await (const entry of glob.scan({ cwd: dirPath, onlyFiles: false })) {
        const fullPath = join(dirPath, entry)
        const file = Bun.file(fullPath)

        // Check if directory by trying to scan it
        let isDirectory = false
        try {
          const testGlob = new Bun.Glob('*')
          for await (const _ of testGlob.scan({ cwd: fullPath, onlyFiles: false })) {
            isDirectory = true
            break
          }
        } catch {
          // Not a directory or no permission
        }

        entries.push({
          name: entry,
          path: fullPath, // client expects full path
          isDirectory,
          size: isDirectory ? 0 : file.size,
        })
      }

      return c.json({ entries, path: dirPath })
    } catch (error) {
      console.error('[files/list]', error)
      return c.json({ error: 'Failed to list directory', path: dirPath }, 500)
    }
  })

  // Get home directory
  files.get('/home', (c) => {
    return c.json({ home: homedir() })
  })

  // Search files (glob pattern)
  files.get('/search', async (c) => {
    const { path: directory, error } = await resolveDirectory(c.req.query('directory'), {
      fallback: process.cwd(),
      requireExists: true,
    })
    const pattern = c.req.query('pattern') || '*'
    const limit = parseInt(c.req.query('limit') || '100', 10)

    if (error || !directory) {
      const status = (error?.status ?? 400) as 400 | 403 | 500
      return c.json({ error: error?.message, ...error }, status)
    }

    try {
      const glob = new Bun.Glob(pattern)
      const results: string[] = []

      for await (const file of glob.scan({ cwd: directory, onlyFiles: true })) {
        results.push(file)
        if (results.length >= limit) break
      }

      return c.json({ files: results, directory, pattern })
    } catch (error) {
      console.error('[files/search]', error)
      return c.json({ error: 'Failed to search files', directory, pattern }, 500)
    }
  })

  return files
}

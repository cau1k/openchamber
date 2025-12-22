/**
 * Path utilities using Bun-native APIs
 */

import { join, resolve } from 'path'
import { homedir } from 'os'
import { stat } from 'fs/promises'

export interface DirectoryResolutionError {
  status: number
  message: string
  raw?: string
  resolved?: string
  details?: string
}

export function expandTilde(input: string): string {
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2))
  }
  if (input === '~') {
    return homedir()
  }
  return input
}

export async function resolveDirectory(
  raw: string | null | undefined,
  options: { fallback?: string; requireExists?: boolean } = {}
): Promise<{ path?: string; error?: DirectoryResolutionError }> {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const fallback = options.fallback?.trim()
  const selected = trimmed || fallback

  if (!selected) {
    return { error: { status: 400, message: 'directory required' } }
  }

  const resolved = resolve(expandTilde(selected))

  if (options.requireExists) {
    try {
      const stats = await stat(resolved)
      if (!stats.isDirectory()) {
        return {
          error: {
            status: 400,
            message: 'directory is not a directory',
            raw: selected,
            resolved,
          },
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return {
          error: {
            status: 400,
            message: 'directory does not exist',
            raw: selected,
            resolved,
          },
        }
      }
      if (err.code === 'EACCES') {
        return {
          error: {
            status: 403,
            message: 'permission denied while accessing directory',
            raw: selected,
            resolved,
          },
        }
      }
      return {
        error: {
          status: 500,
          message: 'failed to access directory',
          raw: selected,
          resolved,
          details: err.message,
        },
      }
    }
  }

  return { path: resolved }
}

export function getDataDir(): string {
  return Bun.env.OPENCHAMBER_DATA_DIR || join(homedir(), '.config', 'openchamber')
}

export function getSettingsPath(): string {
  return join(getDataDir(), 'settings.json')
}

export function getGitIdentitiesPath(): string {
  return join(getDataDir(), 'git-identities.json')
}

export function getDistDir(): string {
  // Relative to server/src/lib, dist is at ../../../dist
  return join(import.meta.dir, '..', '..', '..', 'dist')
}

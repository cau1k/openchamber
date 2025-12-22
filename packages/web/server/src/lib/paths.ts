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

const normalizeTildeInput = (input: string, homeDir: string) => {
  const base = homeDir.split('/').filter(Boolean).pop()
  if (!base) {
    return input
  }

  if (input === `~/${base}`) {
    return '~'
  }

  if (input.startsWith(`~/${base}/`)) {
    return `~/${input.slice(base.length + 3)}`
  }

  return input
}

export function expandTilde(input: string): string {
  const homeDir = homedir()
  const normalized = normalizeTildeInput(input, homeDir)
  if (normalized.startsWith('~/')) {
    return join(homeDir, normalized.slice(2))
  }
  if (normalized === '~') {
    return homeDir
  }
  return normalized
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

  const homeDir = homedir()
  const homeBase = homeDir.split('/').filter(Boolean).pop()
  if (homeBase && (selected === `~/${homeBase}` || selected.startsWith(`~/${homeBase}/`))) {
    return {
      error: {
        status: 400,
        message: 'invalid directory path: do not include home directory after ~',
        raw: selected,
        resolved: `${homeDir}/${selected.slice(homeBase.length + 3)}`,
      },
    }
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

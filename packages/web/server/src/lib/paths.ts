/**
 * Path utilities using Bun-native APIs
 */

import { join } from 'path'
import { homedir } from 'os'

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

/**
 * Git routes using Bun.$ shell
 * Replaces simple-git library
 */

import { Hono } from 'hono'
import { $ } from 'bun'
import { join } from 'path'

export function createGitRoutes() {
  const git = new Hono()

  // Check if directory is a git repo
  git.get('/is-repo', async (c) => {
    const directory = c.req.query('directory')
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    const gitDir = join(directory, '.git')
    const exists = await Bun.file(gitDir).exists()
    return c.json({ isRepo: exists })
  })

  // Get git status
  git.get('/status', async (c) => {
    const directory = c.req.query('directory')
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      // Get porcelain status
      const statusOutput = await $`git -C ${directory} status --porcelain -uall`.text()
      
      // Get branch info
      const branchOutput = await $`git -C ${directory} branch --show-current`.text()
      const current = branchOutput.trim()

      // Get tracking info
      let tracking: string | null = null
      let ahead = 0
      let behind = 0
      
      try {
        const trackingOutput = await $`git -C ${directory} rev-parse --abbrev-ref @{upstream}`.text()
        tracking = trackingOutput.trim()
        
        const aheadBehind = await $`git -C ${directory} rev-list --left-right --count HEAD...@{upstream}`.text()
        const [a, b] = aheadBehind.trim().split(/\s+/).map(Number)
        ahead = a || 0
        behind = b || 0
      } catch {
        // No upstream configured
      }

      // Parse status
      const files = statusOutput
        .split('\n')
        .filter(Boolean)
        .map(line => ({
          index: line[0],
          working_dir: line[1],
          path: line.slice(3),
        }))

      // Get diff stats
      const [stagedStats, workingStats] = await Promise.all([
        $`git -C ${directory} diff --cached --numstat`.text().catch(() => ''),
        $`git -C ${directory} diff --numstat`.text().catch(() => ''),
      ])

      const diffStats: Record<string, { insertions: number; deletions: number }> = {}
      
      const parseNumstat = (raw: string) => {
        raw.split('\n').filter(Boolean).forEach(line => {
          const parts = line.split('\t')
          if (parts.length >= 3) {
            const [ins, del, ...pathParts] = parts
            const path = pathParts.join('\t')
            const insertions = ins === '-' ? 0 : parseInt(ins, 10) || 0
            const deletions = del === '-' ? 0 : parseInt(del, 10) || 0
            
            if (!diffStats[path]) {
              diffStats[path] = { insertions: 0, deletions: 0 }
            }
            diffStats[path].insertions += insertions
            diffStats[path].deletions += deletions
          }
        })
      }

      parseNumstat(stagedStats)
      parseNumstat(workingStats)

      return c.json({
        current,
        tracking,
        ahead,
        behind,
        files,
        isClean: files.length === 0,
        diffStats,
      })
    } catch (error) {
      console.error('[git/status]', error)
      return c.json({ error: 'Failed to get git status' }, 500)
    }
  })

  // Get diff
  git.get('/diff', async (c) => {
    const directory = c.req.query('directory')
    const path = c.req.query('path')
    const staged = c.req.query('staged') === 'true'
    const contextLines = parseInt(c.req.query('contextLines') || '3', 10)

    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const args = ['diff', '--no-color', `-U${contextLines}`]
      if (staged) args.push('--cached')
      if (path) args.push('--', path)

      const diff = await $`git -C ${directory} ${args}`.text()
      return c.json({ diff })
    } catch (error) {
      console.error('[git/diff]', error)
      return c.json({ error: 'Failed to get diff' }, 500)
    }
  })

  // Get file diff (original + modified content)
  git.get('/file-diff', async (c) => {
    const directory = c.req.query('directory')
    const filePath = c.req.query('path')

    if (!directory || !filePath) {
      return c.json({ error: 'directory and path required' }, 400)
    }

    try {
      // Get original from HEAD
      let original = ''
      try {
        original = await $`git -C ${directory} show HEAD:${filePath}`.text()
      } catch {
        // File is new
      }

      // Get modified from filesystem
      const fullPath = join(directory, filePath)
      const file = Bun.file(fullPath)
      let modified = ''
      
      if (await file.exists()) {
        modified = await file.text()
      }

      return c.json({ original, modified, path: filePath })
    } catch (error) {
      console.error('[git/file-diff]', error)
      return c.json({ error: 'Failed to get file diff' }, 500)
    }
  })

  // Get branches
  git.get('/branches', async (c) => {
    const directory = c.req.query('directory')
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const output = await $`git -C ${directory} branch -a`.text()
      const current = (await $`git -C ${directory} branch --show-current`.text()).trim()

      const all = output
        .split('\n')
        .map(line => line.replace(/^\*?\s*/, '').trim())
        .filter(Boolean)

      return c.json({ all, current })
    } catch (error) {
      console.error('[git/branches]', error)
      return c.json({ error: 'Failed to get branches' }, 500)
    }
  })

  // Get log
  git.get('/log', async (c) => {
    const directory = c.req.query('directory')
    const maxCount = parseInt(c.req.query('maxCount') || '50', 10)

    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s'
      const output = await $`git -C ${directory} log --max-count=${maxCount} --pretty=format:${format}`.text()

      const all = output.split('\n').filter(Boolean).map(line => {
        const [hash, author_name, author_email, date, message] = line.split('\x1f')
        return { hash, author_name, author_email, date, message }
      })

      return c.json({ all, latest: all[0] || null, total: all.length })
    } catch (error) {
      console.error('[git/log]', error)
      return c.json({ error: 'Failed to get log' }, 500)
    }
  })

  // Commit
  git.post('/commit', async (c) => {
    const { directory, message, files, addAll } = await c.req.json()
    
    if (!directory || !message) {
      return c.json({ error: 'directory and message required' }, 400)
    }

    try {
      if (addAll) {
        await $`git -C ${directory} add -A`.quiet()
      } else if (files?.length) {
        await $`git -C ${directory} add ${files}`.quiet()
      }

      const result = await $`git -C ${directory} commit -m ${message}`.text()
      return c.json({ success: true, result })
    } catch (error) {
      console.error('[git/commit]', error)
      return c.json({ error: 'Failed to commit' }, 500)
    }
  })

  // Push
  git.post('/push', async (c) => {
    const { directory, remote = 'origin', branch } = await c.req.json()
    
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const args = ['push', remote]
      if (branch) args.push(branch)
      
      await $`git -C ${directory} ${args}`.quiet()
      return c.json({ success: true })
    } catch (error) {
      console.error('[git/push]', error)
      return c.json({ error: 'Failed to push' }, 500)
    }
  })

  // Pull
  git.post('/pull', async (c) => {
    const { directory, remote = 'origin', branch } = await c.req.json()
    
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const args = ['pull', remote]
      if (branch) args.push(branch)
      
      const result = await $`git -C ${directory} ${args}`.text()
      return c.json({ success: true, result })
    } catch (error) {
      console.error('[git/pull]', error)
      return c.json({ error: 'Failed to pull' }, 500)
    }
  })

  // Checkout branch
  git.post('/checkout', async (c) => {
    const { directory, branch } = await c.req.json()
    
    if (!directory || !branch) {
      return c.json({ error: 'directory and branch required' }, 400)
    }

    try {
      await $`git -C ${directory} checkout ${branch}`.quiet()
      return c.json({ success: true, branch })
    } catch (error) {
      console.error('[git/checkout]', error)
      return c.json({ error: 'Failed to checkout' }, 500)
    }
  })

  // Revert file
  git.post('/revert', async (c) => {
    const { directory, path: filePath } = await c.req.json()
    
    if (!directory || !filePath) {
      return c.json({ error: 'directory and path required' }, 400)
    }

    try {
      // Check if tracked
      const isTracked = await $`git -C ${directory} ls-files --error-unmatch ${filePath}`
        .quiet()
        .then(() => true)
        .catch(() => false)

      if (!isTracked) {
        // Untracked - clean it
        await $`git -C ${directory} clean -f -- ${filePath}`.quiet()
      } else {
        // Tracked - restore
        await $`git -C ${directory} restore --staged ${filePath}`.quiet().catch(() => {})
        await $`git -C ${directory} restore ${filePath}`.quiet()
      }

      return c.json({ success: true })
    } catch (error) {
      console.error('[git/revert]', error)
      return c.json({ error: 'Failed to revert' }, 500)
    }
  })

  // Get identity
  git.get('/identity', async (c) => {
    const directory = c.req.query('directory')
    const scope = c.req.query('scope') || 'local'
    
    try {
      const args = scope === 'global' ? ['--global'] : []
      const cwd = directory || process.cwd()
      
      const [userName, userEmail] = await Promise.all([
        $`git -C ${cwd} config ${args} user.name`.text().catch(() => ''),
        $`git -C ${cwd} config ${args} user.email`.text().catch(() => ''),
      ])

      return c.json({
        userName: userName.trim() || null,
        userEmail: userEmail.trim() || null,
      })
    } catch (error) {
      console.error('[git/identity]', error)
      return c.json({ error: 'Failed to get identity' }, 500)
    }
  })

  // Set identity
  git.post('/identity', async (c) => {
    const { directory, userName, userEmail, scope = 'local' } = await c.req.json()
    
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    try {
      const args = scope === 'global' ? ['--global'] : []
      
      if (userName) {
        await $`git -C ${directory} config ${args} user.name ${userName}`.quiet()
      }
      if (userEmail) {
        await $`git -C ${directory} config ${args} user.email ${userEmail}`.quiet()
      }

      return c.json({ success: true })
    } catch (error) {
      console.error('[git/identity]', error)
      return c.json({ error: 'Failed to set identity' }, 500)
    }
  })

  // Worktrees
  git.get('/worktrees', async (c) => {
    const directory = c.req.query('directory')
    if (!directory) {
      return c.json({ error: 'directory required' }, 400)
    }

    // Check if directory is a git repo first
    const gitDir = join(directory, '.git')
    const isGitRepo = await Bun.file(gitDir).exists()
    if (!isGitRepo) {
      // Not a git repo - return empty worktrees (graceful degradation)
      return c.json([])
    }

    try {
      const output = await $`git -C ${directory} worktree list --porcelain`.text()
      const worktrees: Array<{ worktree: string; head?: string; branch?: string }> = []
      let current: { worktree?: string; head?: string; branch?: string } = {}

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.worktree) worktrees.push(current as any)
          current = { worktree: line.slice(9) }
        } else if (line.startsWith('HEAD ')) {
          current.head = line.slice(5)
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7)
        } else if (line === '' && current.worktree) {
          worktrees.push(current as any)
          current = {}
        }
      }
      
      if (current.worktree) worktrees.push(current as any)

      return c.json(worktrees)
    } catch (error) {
      console.error('[git/worktrees]', error)
      return c.json({ error: 'Failed to get worktrees' }, 500)
    }
  })

  return git
}

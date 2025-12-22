/**
 * OpenChamber Server - Hono + Bun Native
 * 
 * Replaces Express server with Bun-native APIs:
 * - Hono for routing (native Bun.serve() export)
 * - Bun.file() / Bun.write() for filesystem
 * - Bun.$ for shell commands (git, etc.)
 * - bun-pty for terminal emulation
 * - Bun.env for environment variables
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createApiProxy } from './routes/proxy'
import { createGitRoutes } from './routes/git'
import { createFileRoutes } from './routes/files'
import { createTerminalRoutes } from './routes/terminal'
import { createSettingsRoutes } from './routes/settings'
import { createConfigRoutes } from './routes/config'
import { createOpenchamberRoutes } from './routes/openchamber'
import { getOpenCodePort, ensureOpenCodeRunning } from './lib/opencode'
import { getDataDir, getDistDir } from './lib/paths'

const app = new Hono()

// CORS for development
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}))

// Health check
app.get('/health', (c) => c.json({ status: 'ok', runtime: 'bun' }))

// Mount route modules
app.route('/api/git', createGitRoutes())
app.route('/api/filesystem', createFileRoutes())
app.route('/api/terminal', createTerminalRoutes())
app.route('/api/settings', createSettingsRoutes())
app.route('/api/config', createConfigRoutes())
app.route('/api/openchamber', createOpenchamberRoutes())

// OpenCode API proxy - must be after specific routes
app.all('/api/*', createApiProxy())

// Static files (UI bundle) - serve from dist/
app.use('/*', serveStatic({ root: getDistDir() }))

// SPA fallback
app.get('*', async (c) => {
  const indexPath = `${getDistDir()}/index.html`
  const file = Bun.file(indexPath)
  if (await file.exists()) {
    return c.html(await file.text())
  }
  return c.text('Not found', 404)
})

// Parse CLI arguments
function parseArgs(): { port: number; workdir: string } {
  const args = Bun.argv.slice(2)
  let port = parseInt(Bun.env.PORT || '3000', 10)
  let workdir = Bun.env.OPENCODE_WORKDIR || process.cwd()
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--workdir' && args[i + 1]) {
      workdir = args[i + 1]
      i++
    }
  }
  
  return { port, workdir }
}

// Server startup
async function main() {
  const { port, workdir } = parseArgs()
  
  console.log(`[openchamber] Starting server...`)
  console.log(`[openchamber] Work directory: ${workdir}`)
  console.log(`[openchamber] Data directory: ${getDataDir()}`)
  
  // Ensure OpenCode is running
  const openCodePort = await ensureOpenCodeRunning(workdir)
  console.log(`[openchamber] OpenCode API available at port ${openCodePort}`)
  
  // Start Hono server with Bun.serve()
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  })
  
  console.log(`[openchamber] Server running at http://localhost:${server.port}`)
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[openchamber] Shutting down...')
    server.stop()
    process.exit(0)
  })
  
  process.on('SIGTERM', () => {
    console.log('\n[openchamber] Shutting down...')
    server.stop()
    process.exit(0)
  })
}

// Exported server start function for CLI integration
export interface ServerOptions {
  port: number;
  workdir?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
}

export async function startWebUiServer(options: ServerOptions): Promise<void> {
  const workdir = options.workdir || process.cwd();
  
  console.log(`[openchamber] Starting server...`);
  console.log(`[openchamber] Work directory: ${workdir}`);
  console.log(`[openchamber] Data directory: ${getDataDir()}`);
  
  // Ensure OpenCode is running
  const openCodePort = await ensureOpenCodeRunning(workdir);
  console.log(`[openchamber] OpenCode API available at port ${openCodePort}`);
  
  // Start Hono server with Bun.serve()
  const server = Bun.serve({
    port: options.port,
    fetch: app.fetch,
  });
  
  console.log(`[openchamber] Server running at http://localhost:${server.port}`);
  
  if (options.attachSignals !== false) {
    const shutdown = () => {
      console.log('\n[openchamber] Shutting down...');
      server.stop();
      if (options.exitOnShutdown !== false) {
        process.exit(0);
      }
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Run if executed directly
if (import.meta.main) {
  const { port, workdir } = parseArgs();
  startWebUiServer({ port, workdir, attachSignals: true, exitOnShutdown: true })
    .catch(console.error);
}

export { app }

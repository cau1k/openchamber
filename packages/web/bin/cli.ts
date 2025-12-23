#!/usr/bin/env bun

import path from 'path';
import os from 'os';
import { startWebUiServer } from '../server/src/index';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const DEFAULT_PORT = 3000;

interface CLIOptions {
  port: number;
  daemon: boolean;
  uiPassword?: string;
  tailscale: boolean;
}

interface ParsedArgs {
  command: string;
  options: CLIOptions;
}

async function getPackageVersion(): Promise<string> {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const file = Bun.file(pkgPath);
  const pkg = await file.json();
  return pkg.version;
}

async function parseArgs(): Promise<ParsedArgs> {
  const args = Bun.argv.slice(2);
  const envPassword = process.env.OPENCHAMBER_UI_PASSWORD;
  const options: CLIOptions = { port: DEFAULT_PORT, daemon: false, uiPassword: envPassword, tailscale: false };
  let command = 'serve';

  const consumeValue = (currentIndex: number, inlineValue?: string): { value?: string; nextIndex: number } => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const candidate = args[currentIndex + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('-')) {
      let optionName: string;
      let inlineValue: string | undefined;

      if (arg.startsWith('--')) {
        const eqIndex = arg.indexOf('=');
        optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
        inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;
      } else {
        optionName = arg.slice(1);
        inlineValue = undefined;
      }

      switch (optionName) {
        case 'port':
        case 'p': {
          const { value, nextIndex } = consumeValue(i, inlineValue);
          i = nextIndex;
          const parsed = parseInt(value ?? '', 10);
          options.port = Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
          break;
        }
        case 'daemon':
        case 'd':
          options.daemon = true;
          break;
        case 'ui-password': {
          const { value, nextIndex } = consumeValue(i, inlineValue);
          i = nextIndex;
          options.uiPassword = typeof value === 'string' ? value : '';
          break;
        }
        case 'help':
        case 'h':
          showHelp();
          process.exit(0);
          break;
        case 'version':
        case 'v': {
          const version = await getPackageVersion();
          console.log(version);
          process.exit(0);
        }
        case 'tailscale':
        case 'T':
          options.tailscale = true;
          break;
      }
    } else {
      command = arg;
    }
  }

  return { command, options };
}

function showHelp(): void {
  console.log(`
OpenChamber - Web interface for the OpenCode AI coding agent

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status

OPTIONS:
  -p, --port     Web server port (default: ${DEFAULT_PORT})
  --ui-password  Protect browser UI with single password
  -d, --daemon   Run in background (serve command)
  -T, --tailscale  Forward port via tailscale serve
  -h, --help     Show help
  -v, --version  Show version

ENVIRONMENT:
  OPENCHAMBER_UI_PASSWORD  Alternative to --ui-password flag

EXAMPLES:
  openchamber                    # Start on default port 3000
  openchamber --port 8080        # Start on port 8080
  openchamber serve --daemon     # Start in background
  openchamber stop               # Stop all running instances
  openchamber stop --port 3000   # Stop specific instance
  openchamber status             # Check status
`);
}

async function isExecutable(filePath: string): Promise<boolean> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return false;
  
  if (process.platform === 'win32') return true;
  
  // Check execute permission on Unix
  try {
    const result = await Bun.$`test -x ${filePath}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function searchPathFor(command: string): Promise<string | null> {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' 
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.trim().toLowerCase())
    : [''];

  for (const dir of segments) {
    for (const ext of extensions) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function checkOpenCodeCLI(): Promise<string> {
  // Check explicit override
  if (process.env.OPENCODE_BINARY) {
    const override = process.env.OPENCODE_BINARY;
    if (path.isAbsolute(override) && await isExecutable(override)) {
      return override;
    }
    console.warn(`Warning: OPENCODE_BINARY="${override}" is not executable. Falling back to PATH lookup.`);
  }

  // Search PATH
  const resolvedFromPath = await searchPathFor('opencode');
  if (resolvedFromPath) {
    process.env.OPENCODE_BINARY = resolvedFromPath;
    return resolvedFromPath;
  }

  // Try shell lookup on Unix
  if (process.platform !== 'win32') {
    const shells = [process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'].filter(Boolean) as string[];
    
    for (const shell of shells) {
      if (!(await isExecutable(shell))) continue;
      
      try {
        const result = await Bun.$`${shell} -lic "command -v opencode"`.quiet();
        if (result.exitCode === 0) {
          const candidate = result.stdout.toString().trim().split(/\s+/).pop();
          if (candidate && await isExecutable(candidate)) {
            // Add to PATH if not present
            const dir = path.dirname(candidate);
            const currentPath = process.env.PATH || '';
            if (!currentPath.split(path.delimiter).includes(dir)) {
              process.env.PATH = `${dir}${path.delimiter}${currentPath}`;
            }
            process.env.OPENCODE_BINARY = candidate;
            return candidate;
          }
        }
      } catch {
        // Continue to next shell
      }
    }
  } else {
    // Windows: try 'where' command
    try {
      const result = await Bun.$`where opencode`.quiet();
      if (result.exitCode === 0) {
        const candidate = result.stdout.toString().split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
        if (candidate && await isExecutable(candidate)) {
          process.env.OPENCODE_BINARY = candidate;
          return candidate;
        }
      }
    } catch {
      // Fall through to error
    }
  }

  console.error('Error: Unable to locate the opencode CLI on PATH.');
  console.error(`Current PATH: ${process.env.PATH || '<empty>'}`);
  console.error('Ensure the CLI is installed and reachable, or set OPENCODE_BINARY to its full path.');
  process.exit(1);
}

function getPidFilePath(port: number): string {
  return path.join(os.tmpdir(), `openchamber-${port}.pid`);
}

function getInstanceFilePath(port: number): string {
  return path.join(os.tmpdir(), `openchamber-${port}.json`);
}

async function readPidFile(pidFilePath: string): Promise<number | null> {
  try {
    const file = Bun.file(pidFilePath);
    if (!(await file.exists())) return null;
    const content = await file.text();
    const pid = parseInt(content.trim());
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
  try {
    await Bun.write(pidFilePath, pid.toString());
  } catch (error) {
    console.warn(`Warning: Could not write PID file: ${error instanceof Error ? error.message : error}`);
  }
}

async function removePidFile(pidFilePath: string): Promise<void> {
  try {
    const file = Bun.file(pidFilePath);
    if (await file.exists()) {
      await Bun.$`rm ${pidFilePath}`.quiet();
    }
  } catch {
    // Ignore
  }
}

interface StoredOptions {
  port: number;
  daemon: boolean;
  hasUiPassword?: boolean;
  uiPassword?: string;
}

async function readInstanceOptions(instanceFilePath: string): Promise<StoredOptions | null> {
  try {
    const file = Bun.file(instanceFilePath);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}

async function writeInstanceOptions(instanceFilePath: string, options: CLIOptions): Promise<void> {
  try {
    const toStore: StoredOptions = {
      port: options.port,
      daemon: options.daemon || false,
      hasUiPassword: typeof options.uiPassword === 'string',
    };
    // For daemon mode, store password to restart properly
    if (options.daemon && typeof options.uiPassword === 'string') {
      toStore.uiPassword = options.uiPassword;
    }
    await Bun.write(instanceFilePath, JSON.stringify(toStore, null, 2));
  } catch (error) {
    console.warn(`Warning: Could not write instance file: ${error instanceof Error ? error.message : error}`);
  }
}

async function removeInstanceFile(instanceFilePath: string): Promise<void> {
  try {
    const file = Bun.file(instanceFilePath);
    if (await file.exists()) {
      await Bun.$`rm ${instanceFilePath}`.quiet();
    }
  } catch {
    // Ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startTailscaleServe(port: number): Promise<boolean> {
  try {
    const which = await Bun.$`which tailscale`.quiet();
    if (which.exitCode !== 0) {
      console.warn('Warning: tailscale not found in PATH, skipping tailscale serve');
      return false;
    }

    // Start tailscale serve in background mode
    const result = await Bun.$`tailscale serve --bg ${port}`.quiet();
    if (result.exitCode === 0) {
      console.log(`Tailscale serve started on port ${port}`);
      // Get the tailscale hostname
      const status = await Bun.$`tailscale status --json`.quiet();
      if (status.exitCode === 0) {
        const statusJson = JSON.parse(status.stdout.toString());
        const hostname = statusJson.Self?.DNSName?.replace(/\.$/, '');
        if (hostname) {
          console.log(`Tailscale URL: https://${hostname}`);
        }
      }
      return true;
    } else {
      console.warn(`Warning: tailscale serve failed: ${result.stderr.toString()}`);
      return false;
    }
  } catch (error) {
    console.warn(`Warning: tailscale serve error: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function stopTailscaleServe(): Promise<void> {
  try {
    await Bun.$`tailscale serve reset`.quiet();
    console.log('Tailscale serve stopped');
  } catch {
    // Ignore errors on cleanup
  }
}

interface RunningInstance {
  port: number;
  pid: number;
  pidFilePath: string;
  instanceFilePath: string;
  storedOptions?: StoredOptions;
}

async function findRunningInstances(): Promise<RunningInstance[]> {
  const tmpDir = os.tmpdir();
  const instances: RunningInstance[] = [];

  try {
    const result = await Bun.$`ls ${tmpDir}`.quiet();
    const files = result.stdout.toString().split('\n').filter(f => f.startsWith('openchamber-') && f.endsWith('.pid'));

    for (const file of files) {
      const port = parseInt(file.replace('openchamber-', '').replace('.pid', ''));
      if (isNaN(port)) continue;

      const pidFilePath = path.join(tmpDir, file);
      const instanceFilePath = path.join(tmpDir, `openchamber-${port}.json`);
      const pid = await readPidFile(pidFilePath);

      if (pid && isProcessRunning(pid)) {
        const storedOptions = await readInstanceOptions(instanceFilePath);
        instances.push({
          port,
          pid,
          pidFilePath,
          instanceFilePath,
          storedOptions: storedOptions ?? undefined,
        });
      } else if (pid) {
        // Clean up stale files
        await removePidFile(pidFilePath);
        await removeInstanceFile(instanceFilePath);
      }
    }
  } catch {
    // Ignore
  }

  return instances;
}

async function stopInstance(instance: RunningInstance, maxAttempts = 10): Promise<void> {
  try {
    process.kill(instance.pid, 'SIGTERM');

    let attempts = 0;
    while (isProcessRunning(instance.pid) && attempts < maxAttempts) {
      await Bun.sleep(500);
      attempts++;
    }

    if (isProcessRunning(instance.pid)) {
      console.log('Force killing process...');
      process.kill(instance.pid, 'SIGKILL');
    }

    await removePidFile(instance.pidFilePath);
    await removeInstanceFile(instance.instanceFilePath);
  } catch (error) {
    console.error(`Error stopping process: ${error instanceof Error ? error.message : error}`);
  }
}

const commands = {
  async serve(options: CLIOptions): Promise<void> {
    const pidFilePath = getPidFilePath(options.port);
    const instanceFilePath = getInstanceFilePath(options.port);

    const existingPid = await readPidFile(pidFilePath);
    if (existingPid && isProcessRunning(existingPid)) {
      console.error(`Error: OpenChamber is already running on port ${options.port} (PID: ${existingPid})`);
      console.error('Use "openchamber stop" to stop the existing instance');
      process.exit(1);
    }

    const opencodeBinary = await checkOpenCodeCLI();
    const serverPath = path.join(__dirname, '..', 'server', 'src', 'index.ts');

    if (options.daemon) {
      // Daemon mode: spawn detached bun process
      const args = [serverPath, '--port', options.port.toString()];
      if (typeof options.uiPassword === 'string') {
        args.push('--ui-password', options.uiPassword);
      }

      const child = Bun.spawn(['bun', ...args], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          OPENCHAMBER_PORT: options.port.toString(),
          OPENCODE_BINARY: opencodeBinary,
          ...(typeof options.uiPassword === 'string' ? { OPENCHAMBER_UI_PASSWORD: options.uiPassword } : {}),
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      // Wait a moment and check if it started
      await Bun.sleep(1000);

      if (child.pid && isProcessRunning(child.pid)) {
        await writePidFile(pidFilePath, child.pid);
        await writeInstanceOptions(instanceFilePath, options);
        console.log(`OpenChamber started in daemon mode on port ${options.port}`);
        console.log(`PID: ${child.pid}`);
        console.log(`Visit: http://localhost:${options.port}`);
        
        if (options.tailscale) {
          await startTailscaleServe(options.port);
        }
      } else {
        console.error('Failed to start server in daemon mode');
        process.exit(1);
      }
    } else {
      // Foreground mode: run server directly
      process.env.OPENCODE_BINARY = opencodeBinary;
      if (typeof options.uiPassword === 'string') {
        process.env.OPENCHAMBER_UI_PASSWORD = options.uiPassword;
      }
      await writeInstanceOptions(instanceFilePath, options);

      await startWebUiServer({
        port: options.port,
        attachSignals: true,
        exitOnShutdown: true,
        uiPassword: typeof options.uiPassword === 'string' ? options.uiPassword : null,
        onReady: options.tailscale ? async () => {
          await startTailscaleServe(options.port);
        } : undefined,
        onShutdown: options.tailscale ? async () => {
          await stopTailscaleServe();
        } : undefined,
      });
    }
  },

  async stop(options: CLIOptions): Promise<void> {
    const runningInstances = await findRunningInstances();

    if (runningInstances.length === 0) {
      console.log('No running OpenChamber instances found');
      return;
    }

    const portWasSpecified = Bun.argv.includes('--port') || Bun.argv.includes('-p');

    if (portWasSpecified) {
      const targetInstance = runningInstances.find(inst => inst.port === options.port);

      if (!targetInstance) {
        console.log(`No OpenChamber instance found running on port ${options.port}`);
        return;
      }

      console.log(`Stopping OpenChamber (PID: ${targetInstance.pid}, Port: ${targetInstance.port})...`);
      await stopInstance(targetInstance);
      console.log('OpenChamber stopped successfully');
    } else {
      console.log(`Stopping all OpenChamber instances (${runningInstances.length} found)...`);

      for (const instance of runningInstances) {
        console.log(`  Stopping instance on port ${instance.port} (PID: ${instance.pid})...`);
        await stopInstance(instance);
        console.log(`    Port ${instance.port} stopped successfully`);
      }

      console.log('\nAll OpenChamber instances stopped');
    }
  },

  async restart(options: CLIOptions): Promise<void> {
    const runningInstances = await findRunningInstances();
    const portWasSpecified = Bun.argv.includes('--port') || Bun.argv.includes('-p');

    if (runningInstances.length === 0) {
      console.log('No running OpenChamber instances to restart');
      console.log('Use "openchamber serve" to start a new instance');
      return;
    }

    let instancesToRestart = runningInstances;
    if (portWasSpecified) {
      const target = runningInstances.find(inst => inst.port === options.port);
      if (!target) {
        console.log(`No OpenChamber instance found running on port ${options.port}`);
        return;
      }
      instancesToRestart = [target];
    }

    for (const instance of instancesToRestart) {
      console.log(`Restarting OpenChamber on port ${instance.port}...`);

      // Merge stored options with CLI-provided options
      const restartOptions: CLIOptions = {
        port: instance.storedOptions?.port ?? instance.port,
        daemon: instance.storedOptions?.daemon ?? false,
        uiPassword: instance.storedOptions?.uiPassword,
        tailscale: false,
        // CLI-provided options override stored ones
        ...(portWasSpecified ? { port: options.port } : {}),
        ...(Bun.argv.includes('--daemon') || Bun.argv.includes('-d') ? { daemon: options.daemon } : {}),
        ...(Bun.argv.includes('--ui-password') ? { uiPassword: options.uiPassword } : {}),
      };

      await stopInstance(instance);
      await Bun.sleep(500);
      await commands.serve(restartOptions);
    }
  },

  async status(): Promise<void> {
    const runningInstances = await findRunningInstances();

    console.log('OpenChamber Status:');

    if (runningInstances.length === 0) {
      console.log('  Status: Stopped');
      return;
    }

    for (const [index, instance] of runningInstances.entries()) {
      if (runningInstances.length > 1) {
        console.log(`\nInstance ${index + 1}:`);
      }
      console.log('  Status: Running');
      console.log(`  PID: ${instance.pid}`);
      console.log(`  Port: ${instance.port}`);
      console.log(`  Visit: http://localhost:${instance.port}`);

      // Try to get start time on Unix
      if (process.platform !== 'win32') {
        try {
          const result = await Bun.$`ps -o lstart= -p ${instance.pid}`.quiet();
          if (result.exitCode === 0) {
            console.log(`  Start Time: ${result.stdout.toString().trim()}`);
          }
        } catch {
          // Ignore
        }
      }
    }
  },
};

async function main(): Promise<void> {
  const { command, options } = await parseArgs();

  const commandFn = commands[command as keyof typeof commands];
  if (!commandFn) {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Use --help to see available commands');
    process.exit(1);
  }

  try {
    await commandFn(options);
  } catch (error) {
    console.error(`Error executing command '${command}': ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main();

export { commands, parseArgs, getPidFilePath };

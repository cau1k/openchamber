#!/usr/bin/env bun

/**
 * Build standalone OpenChamber binaries for multiple platforms
 * 
 * Usage: bun scripts/build-binaries.ts [--target <target>]
 * 
 * Without --target, builds for current platform only.
 * With --target all, builds for all supported platforms.
 */

import path from 'path';

const ROOT_DIR = path.join(import.meta.dir, '..');
const WEB_PKG_DIR = path.join(ROOT_DIR, 'packages', 'web');
const DIST_DIR = path.join(ROOT_DIR, 'dist', 'binaries');

type BunTarget = 
  | 'bun-linux-x64'
  | 'bun-linux-arm64'
  | 'bun-darwin-x64'
  | 'bun-darwin-arm64'
  | 'bun-windows-x64';

const ALL_TARGETS: BunTarget[] = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
];

async function getVersion(): Promise<string> {
  const pkgFile = Bun.file(path.join(WEB_PKG_DIR, 'package.json'));
  const pkg = await pkgFile.json();
  return pkg.version;
}

function getOutputName(target: BunTarget, version: string): string {
  const isWindows = target.includes('windows');
  const ext = isWindows ? '.exe' : '';
  return `openchamber-${version}-${target.replace('bun-', '')}${ext}`;
}

async function buildForTarget(target: BunTarget, version: string): Promise<boolean> {
  const outputName = getOutputName(target, version);
  const outputPath = path.join(DIST_DIR, outputName);
  const entryPoint = path.join(WEB_PKG_DIR, 'bin', 'cli.ts');

  console.log(`Building ${target}...`);

  try {
    const result = await Bun.$`bun build ${entryPoint} --compile --target=${target} --outfile=${outputPath}`.quiet();
    
    if (result.exitCode !== 0) {
      console.error(`  Failed: ${result.stderr.toString()}`);
      return false;
    }

    // Get file size
    const file = Bun.file(outputPath);
    const size = file.size;
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    
    console.log(`  Success: ${outputName} (${sizeMB} MB)`);
    return true;
  } catch (error) {
    console.error(`  Error: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function buildUI(): Promise<boolean> {
  console.log('Building UI assets...');
  
  try {
    const result = await Bun.$`bun run build`.cwd(WEB_PKG_DIR).quiet();
    if (result.exitCode !== 0) {
      console.error(`UI build failed: ${result.stderr.toString()}`);
      return false;
    }
    console.log('  UI build complete');
    return true;
  } catch (error) {
    console.error(`UI build error: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function generateChecksums(): Promise<void> {
  console.log('\nGenerating checksums...');
  
  try {
    const result = await Bun.$`ls`.cwd(DIST_DIR).quiet();
    const files = result.stdout.toString().split('\n').filter(f => f.startsWith('openchamber-'));
    
    const checksums: string[] = [];
    for (const file of files) {
      const filePath = path.join(DIST_DIR, file);
      const hashResult = await Bun.$`sha256sum ${filePath}`.quiet();
      if (hashResult.exitCode === 0) {
        // Format: hash  filename (just filename, not full path)
        const hash = hashResult.stdout.toString().split(/\s+/)[0];
        checksums.push(`${hash}  ${file}`);
      }
    }
    
    await Bun.write(path.join(DIST_DIR, 'checksums.txt'), checksums.join('\n') + '\n');
    console.log('  Checksums written to checksums.txt');
  } catch (error) {
    console.error(`Checksum error: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  let targets: BunTarget[] = [];
  
  // Parse arguments
  const targetIdx = args.indexOf('--target');
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    const targetArg = args[targetIdx + 1];
    if (targetArg === 'all') {
      targets = ALL_TARGETS;
    } else if (ALL_TARGETS.includes(targetArg as BunTarget)) {
      targets = [targetArg as BunTarget];
    } else {
      console.error(`Unknown target: ${targetArg}`);
      console.error(`Available targets: ${ALL_TARGETS.join(', ')}, all`);
      process.exit(1);
    }
  } else {
    // Default to current platform
    const platform = process.platform;
    const arch = process.arch;
    
    const targetMap: Record<string, BunTarget> = {
      'linux-x64': 'bun-linux-x64',
      'linux-arm64': 'bun-linux-arm64',
      'darwin-x64': 'bun-darwin-x64',
      'darwin-arm64': 'bun-darwin-arm64',
      'win32-x64': 'bun-windows-x64',
    };
    
    const key = `${platform}-${arch}`;
    const target = targetMap[key];
    
    if (!target) {
      console.error(`Unsupported platform: ${key}`);
      process.exit(1);
    }
    
    targets = [target];
  }

  const version = await getVersion();
  console.log(`OpenChamber v${version}`);
  console.log(`Targets: ${targets.join(', ')}\n`);

  // Ensure dist directory exists
  await Bun.$`mkdir -p ${DIST_DIR}`.quiet();

  // Build UI first
  const uiSuccess = await buildUI();
  if (!uiSuccess) {
    console.error('\nUI build failed, aborting binary builds.');
    process.exit(1);
  }

  console.log('\nBuilding binaries...');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const target of targets) {
    const success = await buildForTarget(target, version);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Generate checksums if any builds succeeded
  if (successCount > 0) {
    await generateChecksums();
  }

  console.log(`\nBuild complete: ${successCount} succeeded, ${failCount} failed`);
  
  if (failCount > 0) {
    process.exit(1);
  }
}

main();

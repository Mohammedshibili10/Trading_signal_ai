#!/usr/bin/env node
/**
 * Cross-platform launcher for the AI analysis service.
 *
 *   node run.mjs             start the server
 *   node run.mjs --test      run the engine self-test
 *   node run.mjs --ml        also install the optional transformer stack
 *   node run.mjs --trusted   bypass TLS verification for PyPI
 *
 * Or from the repo root:  npm run ai  /  npm run ai:test
 *
 * Written in Node rather than PowerShell because some endpoint-protection
 * setups block script files being created or executed, and because Node is
 * already a hard dependency of this repo while PowerShell is not portable.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, utimesSync, closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

const args = new Set(process.argv.slice(2));
const runTest = args.has('--test');
const installMl = args.has('--ml');
const trustedHost = args.has('--trusted');

const colour = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/** Probe an interpreter, returning its minor version or null. */
function probe(command, extraArgs = []) {
  const result = spawnSync(command, [...extraArgs, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /Python 3\.(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * Find a usable Python.
 *
 * On Windows a bare `python` frequently resolves to the Microsoft Store alias
 * stub, which prints an install prompt and exits non-zero — `probe` filters
 * those out by exit code.
 *
 * Version order is deliberate: established releases reliably have prebuilt
 * wheels for numpy/pandas/scipy. When none exists, pip falls back to compiling
 * from source, which looks like a hang and usually ends in a compiler error.
 * Verified working on 3.11 through 3.14.
 */
function findPython() {
  if (isWindows) {
    for (const version of ['3.12', '3.13', '3.14', '3.11']) {
      if (probe('py', [`-${version}`]) !== null) return { command: 'py', args: [`-${version}`] };
    }
  }

  for (const candidate of ['python3.13', 'python3.12', 'python3.11', 'python3', 'python']) {
    const minor = probe(candidate);
    if (minor !== null && minor >= 11) return { command: candidate, args: [] };
  }

  if (isWindows && probe('py', ['-3']) !== null) return { command: 'py', args: ['-3'] };
  return null;
}

const python = findPython();

if (!python) {
  console.error(colour.red('\nPython 3.11+ was not found.\n'));
  console.error(colour.yellow('Install it with:'));
  console.error(
    isWindows
      ? '    winget install --id Python.Python.3.12 -e'
      : '    brew install python@3.12   (macOS)\n    sudo apt install python3.12 python3.12-venv   (Debian/Ubuntu)',
  );
  console.error(colour.yellow('\nOr skip Python entirely and use Docker:'));
  console.error('    docker compose --profile full up ai\n');
  process.exit(1);
}

console.log(colour.dim(`Using ${python.command} ${python.args.join(' ')}`.trim()));

// ── Virtual environment ────────────────────────────────────────
const venvDir = join(here, '.venv');
const venvPython = isWindows
  ? join(venvDir, 'Scripts', 'python.exe')
  : join(venvDir, 'bin', 'python');

if (!existsSync(venvPython)) {
  console.log(colour.cyan('Creating virtual environment...'));
  const created = spawnSync(python.command, [...python.args, '-m', 'venv', venvDir], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (created.status !== 0) {
    console.error(colour.red('Failed to create the virtual environment.'));
    process.exit(1);
  }
}

// ── Dependencies ───────────────────────────────────────────────
const pipFlags = ['-m', 'pip', 'install', '--disable-pip-version-check', '-q'];
if (trustedHost) {
  pipFlags.push('--trusted-host', 'pypi.org', '--trusted-host', 'files.pythonhosted.org');
}

const marker = join(venvDir, '.installed');
const requirements = join(here, 'requirements.txt');
const needsInstall =
  !existsSync(marker) || statSync(requirements).mtimeMs > statSync(marker).mtimeMs;

if (needsInstall) {
  console.log(colour.cyan('Installing dependencies...'));
  const installed = spawnSync(venvPython, [...pipFlags, '-r', requirements], {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (installed.status !== 0) {
    console.error(colour.yellow('\npip failed. Two common causes:\n'));
    console.error(colour.yellow('  CERTIFICATE_VERIFY_FAILED — your network intercepts TLS.'));
    console.error('      Re-run with:  node run.mjs --trusted\n');
    console.error(colour.yellow("  A 'building wheel' step that never finishes — no prebuilt"));
    console.error('      wheel for this Python. Install 3.12, or use Docker:');
    console.error('      docker compose --profile full up ai\n');
    process.exit(1);
  }

  closeSync(openSync(marker, 'w'));
  utimesSync(marker, new Date(), new Date());
}

if (installMl) {
  console.log(colour.cyan('Installing the optional ML stack (this takes a while)...'));
  spawnSync(venvPython, [...pipFlags, '-r', join(here, 'requirements-ml.txt')], {
    stdio: 'inherit',
    windowsHide: true,
  });
}

/**
 * Force UTF-8 on the child's stdio.
 *
 * A Windows console defaults to cp1252, and Python raises UnicodeEncodeError
 * the moment it prints a character outside that codepage — which the self-test
 * does on its very first heading. The engine is fine; only the printing breaks,
 * which is the most misleading possible failure. Setting this here fixes it for
 * every Windows user rather than asking each of them to discover it.
 */
const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

// ── Run ────────────────────────────────────────────────────────
if (runTest) {
  console.log(colour.cyan('Running engine self-test...\n'));
  const test = spawnSync(venvPython, [join(here, 'selftest.py')], {
    stdio: 'inherit',
    cwd: here,
    windowsHide: true,
    env: childEnv,
  });
  process.exit(test.status ?? 1);
}

const port = process.env.AI_PORT || '8000';
console.log(`\n${colour.green(`AI service starting on http://localhost:${port}`)}`);
console.log(colour.dim(`API docs: http://localhost:${port}/docs\n`));

const server = spawn(
  venvPython,
  ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', port, '--reload'],
  { stdio: 'inherit', cwd: here, windowsHide: true, env: childEnv },
);

// Forward termination so Ctrl-C stops uvicorn cleanly rather than orphaning it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code ?? 0));

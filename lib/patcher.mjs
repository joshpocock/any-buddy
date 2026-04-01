import { readFileSync, writeFileSync, copyFileSync, statSync, chmodSync, realpathSync, unlinkSync, renameSync } from 'fs';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename, dirname } from 'path';
import { homedir, platform } from 'os';
import { ORIGINAL_SALT } from './constants.mjs';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

// Cross-platform `which` — returns the resolved path or null
function which(cmd) {
  try {
    const shellCmd = IS_WIN ? `where ${cmd}` : `which ${cmd}`;
    const result = execSync(shellCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // `where` on Windows may return multiple lines; take the first
    const first = result.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
  } catch { /* ignore */ }
  return null;
}

// Resolve symlinks safely
function realpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

// Resolve the actual Claude Code binary/bundle path.
// Works on Linux (ELF binary), macOS (Mach-O or app bundle), and Windows (.exe or .cmd shim).
export function findClaudeBinary() {
  // 1. User-specified override
  if (process.env.CLAUDE_BINARY) {
    const p = process.env.CLAUDE_BINARY;
    if (existsSync(p)) return realpath(p);
    throw new Error(`CLAUDE_BINARY="${p}" does not exist.`);
  }

  // 2. Try finding `claude` on PATH
  const onPath = which('claude');
  if (onPath) {
    const resolved = realpath(onPath);

    // On Windows, `where claude` might return a .cmd shim from npm.
    // We need the actual binary it points to.
    if (IS_WIN && resolved.endsWith('.cmd')) {
      const target = resolveWindowsShim(resolved);
      if (target) return target;
    }

    // On macOS/Linux, the symlink may point to a versions directory
    return resolved;
  }

  // 3. Platform-specific known locations
  const candidates = getPlatformCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return realpath(candidate);
    }
  }

  const platformHint = IS_WIN
    ? 'On Windows, Claude Code is typically installed via npm or the desktop app.'
    : IS_MAC
      ? 'On macOS, Claude Code is typically at ~/.claude/local/ or installed via npm/brew.'
      : 'On Linux, Claude Code is typically at ~/.local/share/claude/versions/.';

  throw new Error(
    'Could not find Claude Code binary.\n' +
    `  Platform: ${platform()}\n` +
    '  Tried `' + (IS_WIN ? 'where' : 'which') + ' claude` and these paths:\n' +
    candidates.map(c => `    - ${c}`).join('\n') +
    '\n\n  ' + platformHint +
    '\n  Set CLAUDE_BINARY=/path/to/binary to specify manually.' +
    '\n\n  If this is a bug, please report it at:' +
    '\n  https://github.com/cpaczek/any-buddy/issues'
  );
}

function getPlatformCandidates() {
  const home = homedir();

  if (IS_WIN) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(localAppData, 'Programs', 'claude', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd'),
      join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
      join(home, '.volta', 'bin', 'claude.exe'),
    ];
  }

  if (IS_MAC) {
    return [
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      join(home, '.npm-global', 'bin', 'claude'),
      join(home, '.volta', 'bin', 'claude'),
    ];
  }

  // Linux
  return [
    join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
  ];
}

// On Windows, npm installs a .cmd shim. Parse it to find the actual JS entry or binary.
function resolveWindowsShim(cmdPath) {
  try {
    const content = readFileSync(cmdPath, 'utf-8');
    // npm shims contain a line like: "%~dp0\node_modules\@anthropic-ai\claude-code\cli.mjs"
    const match = content.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/][^\s"]+/);
    if (match) {
      const shimDir = dirname(cmdPath);
      const target = join(shimDir, match[0]);
      if (existsSync(target)) return target;
    }
  } catch { /* ignore */ }
  return null;
}

// Find all byte offsets of a string in a buffer
function findAllOccurrences(buffer, searchStr) {
  const searchBuf = Buffer.from(searchStr, 'utf-8');
  const offsets = [];
  let pos = 0;
  while (pos < buffer.length) {
    const idx = buffer.indexOf(searchBuf, pos);
    if (idx === -1) break;
    offsets.push(idx);
    pos = idx + 1;
  }
  return offsets;
}

// Read the current salt from the binary (checks if patched or original)
export function getCurrentSalt(binaryPath) {
  const buf = readFileSync(binaryPath);
  const origOffsets = findAllOccurrences(buf, ORIGINAL_SALT);
  if (origOffsets.length >= 3) {
    return { salt: ORIGINAL_SALT, patched: false, offsets: origOffsets };
  }
  return { salt: null, patched: true, offsets: origOffsets };
}

// Check if a specific salt is present in the binary
export function verifySalt(binaryPath, salt) {
  const buf = readFileSync(binaryPath);
  const offsets = findAllOccurrences(buf, salt);
  return { found: offsets.length, offsets };
}

// Check if Claude is currently running (best-effort, non-fatal)
export function isClaudeRunning(binaryPath) {
  try {
    if (IS_WIN) {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH 2>nul', { encoding: 'utf-8' });
      return out.includes('claude.exe');
    }
    const name = basename(binaryPath);
    const out = execSync(`pgrep -f "${name}" 2>/dev/null || true`, { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Ad-hoc codesign on macOS (required after patching Mach-O binaries)
function codesignBinary(binaryPath) {
  if (!IS_MAC) return { signed: false, error: null };
  try {
    execSync(`codesign --force --sign - "${binaryPath}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { signed: true, error: null };
  } catch (err) {
    return { signed: false, error: err.message };
  }
}

// Patch the binary: replace oldSalt with newSalt at all occurrences.
export function patchBinary(binaryPath, oldSalt, newSalt) {
  if (oldSalt.length !== newSalt.length) {
    throw new Error(
      `Salt length mismatch: old=${oldSalt.length}, new=${newSalt.length}. Must be ${ORIGINAL_SALT.length} chars.`
    );
  }

  const buf = readFileSync(binaryPath);
  const offsets = findAllOccurrences(buf, oldSalt);

  if (offsets.length === 0) {
    throw new Error(
      `Could not find salt "${oldSalt}" in binary at ${binaryPath}.\n` +
      '  The binary may already be patched with a different salt, or Claude Code has changed.\n\n' +
      '  If you think this is a bug, please report it at:\n' +
      '  https://github.com/cpaczek/any-buddy/issues'
    );
  }

  // Create backup
  const backupPath = binaryPath + '.anybuddy-bak';
  if (!existsSync(backupPath)) {
    copyFileSync(binaryPath, backupPath);
  }

  // Replace all occurrences in the buffer
  const newBuf = Buffer.from(newSalt, 'utf-8');
  for (const offset of offsets) {
    newBuf.copy(buf, offset);
  }

  // Write strategy depends on platform.
  // Linux/macOS: write to temp then atomic rename (handles ETXTBSY).
  // Windows: can't rename over a running exe, so try direct write first.
  const stats = statSync(binaryPath);
  const tmpPath = binaryPath + '.anybuddy-tmp';

  try {
    writeFileSync(tmpPath, buf);
    if (!IS_WIN) chmodSync(tmpPath, stats.mode);

    try {
      renameSync(tmpPath, binaryPath);
    } catch {
      try { unlinkSync(binaryPath); } catch { /* ignore */ }
      renameSync(tmpPath, binaryPath);
    }
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath); } catch { /* ignore */ }

    if (IS_WIN && err.code === 'EPERM') {
      throw new Error(
        'Cannot patch: the binary is locked (Claude Code may be running).\n' +
        '  Close all Claude Code windows and try again.'
      );
    }
    throw err;
  }

  // Verify
  const verifyBuf = readFileSync(binaryPath);
  const verify = findAllOccurrences(verifyBuf, newSalt);

  // Re-sign on macOS (patching invalidates the Mach-O code signature)
  const cs = codesignBinary(binaryPath);

  return {
    replacements: offsets.length,
    verified: verify.length === offsets.length,
    backupPath,
    codesigned: cs.signed,
    codesignError: cs.error,
  };
}

// Restore the binary from backup
export function restoreBinary(binaryPath) {
  const backupPath = binaryPath + '.anybuddy-bak';
  if (!existsSync(backupPath)) {
    throw new Error(
      'No backup found. Cannot restore.\n' +
      `  Expected: ${backupPath}`
    );
  }

  const stats = statSync(backupPath);
  const tmpPath = binaryPath + '.anybuddy-tmp';

  try {
    copyFileSync(backupPath, tmpPath);
    if (!IS_WIN) chmodSync(tmpPath, stats.mode);

    try {
      renameSync(tmpPath, binaryPath);
    } catch {
      try { unlinkSync(binaryPath); } catch { /* ignore */ }
      renameSync(tmpPath, binaryPath);
    }
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    if (IS_WIN && err.code === 'EPERM') {
      throw new Error(
        'Cannot restore: the binary is locked (Claude Code may be running).\n' +
        '  Close all Claude Code windows and try again.'
      );
    }
    throw err;
  }

  return true;
}

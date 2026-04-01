import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RARITY_WEIGHTS, diagnostics } from './constants.mjs';
import { findBunBinary, isNodeRuntime } from './patcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'finder-worker.mjs');

// Calculate expected attempts based on probability of matching all desired traits.
export function estimateAttempts(desired) {
  // Species: 1/18
  let p = 1 / 18;

  // Rarity: weight / 100
  p *= RARITY_WEIGHTS[desired.rarity] / 100;

  // Eye: 1/6
  p *= 1 / 6;

  // Hat: common is always 'none' (guaranteed), otherwise 1/8
  if (desired.rarity !== 'common') {
    p *= 1 / 8;
  }

  // Shiny: 1/100
  if (desired.shiny) {
    p *= 0.01;
  }

  // Peak stat: 1/5
  if (desired.peak) {
    p *= 1 / 5;
  }

  // Dump stat: ~1/4 (picked from remaining 4, but rerolls on collision)
  if (desired.dump) {
    p *= 1 / 4;
  }

  // Expected attempts = 1/p (geometric distribution)
  return Math.round(1 / p);
}

// Spawns a subprocess that brute-forces salts.
// Uses Bun (wyhash) for compiled binary installs, or Node (FNV-1a) for npm .js installs.
// Calls onProgress with { attempts, elapsed, rate, expected, pct, eta } on each tick.
// Returns a promise resolving to { salt, attempts, elapsed }.
export function findSalt(userId, desired, { onProgress, binaryPath } = {}) {
  const expected = estimateAttempts(desired);

  // Detect if the Claude binary is a .js file run by Node — if so, use FNV-1a
  const useNodeHash = binaryPath ? isNodeRuntime(binaryPath) : false;
  const runtime = useNodeHash ? process.execPath : findBunBinary();

  return new Promise((resolve, reject) => {
    const args = [
      WORKER_PATH,
      userId,
      desired.species,
      desired.rarity,
      desired.eye,
      desired.hat,
      String(desired.shiny ?? false),
      desired.peak ?? 'any',
      desired.dump ?? 'any',
    ];

    // When targeting Node runtime, pass --fnv1a so the worker uses FNV-1a hash
    if (useNodeHash) {
      args.push('--fnv1a');
    }

    // Scale timeout with expected attempts: 10 min base, +1 min per 50M attempts
    const timeout = Math.max(600000, Math.ceil(expected / 50_000_000) * 60_000 + 600_000);

    const child = spawn(runtime, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!onProgress) return;
      // Worker writes JSON progress lines to stderr
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const progress = JSON.parse(line);
          if (progress.info) return; // Skip info messages
          const rate = progress.attempts / (progress.elapsed / 1000); // attempts/sec
          const pct = Math.min(100, (progress.attempts / expected) * 100);
          // ETA based on expected remaining attempts at current rate
          const remaining = Math.max(0, expected - progress.attempts);
          const eta = rate > 0 ? remaining / rate : Infinity;
          onProgress({ ...progress, rate, expected, pct, eta });
        } catch {
          // Not JSON — could be an error message, already captured in stderr
        }
      }
    });

    child.on('close', (code, signal) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (err) {
          reject(new Error(`Failed to parse finder result: ${stdout.trim()}`));
        }
      } else {
        const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
        const stderrClean = stderr.split('\n').filter(l => {
          try { JSON.parse(l); return false; } catch { return true; }
        }).join('\n').trim();
        const extra = {
          Runtime: `${runtime} (${useNodeHash ? 'FNV-1a' : 'wyhash'})`,
          Expected: `~${expected.toLocaleString()} attempts`,
          Timeout: `${(timeout / 1000).toFixed(0)}s`,
          Args: `[${args.slice(1).map(a => `"${a}"`).join(', ')}]`,
        };
        if (stderrClean) extra['Worker stderr'] = stderrClean;
        reject(new Error(`Salt finder ${reason}\n\n${diagnostics(extra)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(
        `Failed to spawn salt finder: ${err.message}\n\n${diagnostics({ Runtime: runtime })}`
      ));
    });
  });
}

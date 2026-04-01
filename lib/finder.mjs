import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RARITY_WEIGHTS, diagnostics } from './constants.mjs';
import { findBunBinary } from './patcher.mjs';

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

// Spawns a Bun subprocess that brute-forces salts using native Bun.hash.
// Calls onProgress with { attempts, elapsed, rate, expected, pct, eta } on each tick.
// Returns a promise resolving to { salt, attempts, elapsed }.
export function findSalt(userId, desired, { onProgress } = {}) {
  const expected = estimateAttempts(desired);
  const bunBinary = findBunBinary();

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

    // Scale timeout with expected attempts: 10 min base, +1 min per 50M attempts
    const timeout = Math.max(600000, Math.ceil(expected / 50_000_000) * 60_000 + 600_000);

    const child = spawn(bunBinary, args, {
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
          Bun: bunBinary,
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
        `Failed to spawn salt finder: ${err.message}\n\n${diagnostics({ Bun: bunBinary })}`
      ));
    });
  });
}

import { execFileSync } from 'child_process';
import {
  RARITIES, RARITY_WEIGHTS, RARITY_FLOOR, SPECIES, EYES, HATS, STAT_NAMES,
} from './constants.mjs';
import { findBunBinary } from './patcher.mjs';

// FNV-1a 32-bit hash — used when Claude Code runs under Node (e.g., Windows npm installs).
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Bun.hash (wyhash) — spawns bun to get the exact same hash Claude Code uses.
// String passed via stdin since bun -e doesn't forward argv.
// Cached to avoid repeated subprocess calls for the same input.
const hashCache = new Map();

// Hash a string using the same function Claude Code will use at runtime.
// If useNodeHash is true, uses FNV-1a (for Node-based installs like Windows npm).
// Otherwise, uses Bun.hash/wyhash (for compiled binary installs).
export function hashString(s, { useNodeHash = false } = {}) {
  const cacheKey = `${useNodeHash ? 'fnv' : 'bun'}:${s}`;
  if (hashCache.has(cacheKey)) return hashCache.get(cacheKey);

  if (useNodeHash) {
    const result = fnv1a(s);
    hashCache.set(cacheKey, result);
    return result;
  }

  try {
    const result = execFileSync(findBunBinary(), ['-e',
      'const s=await Bun.stdin.text();process.stdout.write(String(Number(BigInt(Bun.hash(s))&0xffffffffn)))',
    ], { encoding: 'utf-8', input: s, timeout: 5000 });
    const h = parseInt(result.trim(), 10);
    hashCache.set(cacheKey, h);
    return h;
  } catch {
    // Fallback to FNV-1a if bun isn't available
    const result = fnv1a(s);
    hashCache.set(cacheKey, result);
    return result;
  }
}

// Mulberry32 seeded PRNG — matches buddy/companion.ts exactly
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function rollRarity(rng) {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity];
    if (roll < 0) return rarity;
  }
  return 'common';
}

function rollStats(rng, rarity) {
  const floor = RARITY_FLOOR[rarity];
  const peak = pick(rng, STAT_NAMES);
  let dump = pick(rng, STAT_NAMES);
  while (dump === peak) dump = pick(rng, STAT_NAMES);

  const stats = {};
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    } else {
      stats[name] = floor + Math.floor(rng() * 40);
    }
  }
  return stats;
}

export function rollFrom(rng) {
  const rarity = rollRarity(rng);
  const bones = {
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  };
  const inspirationSeed = Math.floor(rng() * 1e9);
  return { bones, inspirationSeed };
}

// Roll with explicit salt param (unlike source which hardcodes it)
// Pass useNodeHash: true for Node-based Claude installs (Windows npm)
export function roll(userId, salt, { useNodeHash = false } = {}) {
  const key = userId + salt;
  return rollFrom(mulberry32(hashString(key, { useNodeHash })));
}

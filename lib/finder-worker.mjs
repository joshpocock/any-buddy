#!/usr/bin/env bun
// This script runs under Bun for fast native Bun.hash access.
// Called by finder.mjs as a subprocess.
// Args: <userId> <species> <rarity> <eye> <hat>
// Outputs JSON: { salt, attempts, elapsed }

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
const SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin',
  'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot',
  'rabbit', 'mushroom', 'chonk',
];
const EYES = ['·', '✦', '×', '◉', '@', '°'];
const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'];

function mulberry32(seed) {
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
  const total = 100;
  let roll = rng() * total;
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity];
    if (roll < 0) return rarity;
  }
  return 'common';
}

function quickRoll(userId, salt) {
  const key = userId + salt;
  const seed = Number(BigInt(Bun.hash(key)) & 0xffffffffn);
  const rng = mulberry32(seed);
  const rarity = rollRarity(rng);
  const species = pick(rng, SPECIES);
  const eye = pick(rng, EYES);
  const hat = rarity === 'common' ? 'none' : pick(rng, HATS);
  const shiny = rng() < 0.01;
  return { rarity, species, eye, hat, shiny };
}

const SALT_LEN = 15;
const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

function randomSalt() {
  let s = '';
  for (let i = 0; i < SALT_LEN; i++) {
    s += CHARSET[(Math.random() * CHARSET.length) | 0];
  }
  return s;
}

const [userId, wantSpecies, wantRarity, wantEye, wantHat, wantShiny] = process.argv.slice(2);

if (!userId || !wantSpecies || !wantRarity || !wantEye || !wantHat) {
  console.error('Usage: finder-worker.mjs <userId> <species> <rarity> <eye> <hat> [shiny]');
  process.exit(1);
}

const requireShiny = wantShiny === 'true';

const start = Date.now();
let attempts = 0;

while (true) {
  attempts++;
  const salt = randomSalt();
  const bones = quickRoll(userId, salt);

  if (
    bones.species === wantSpecies &&
    bones.rarity === wantRarity &&
    bones.eye === wantEye &&
    bones.hat === wantHat &&
    (!requireShiny || bones.shiny)
  ) {
    console.log(JSON.stringify({
      salt,
      attempts,
      elapsed: Date.now() - start,
    }));
    process.exit(0);
  }

  if (attempts % 500000 === 0) {
    process.stderr.write(`${(attempts / 1000).toFixed(0)}k seeds tried...\n`);
  }
}

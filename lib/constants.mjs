import { platform, arch } from 'os';

export const ISSUE_URL = 'https://github.com/cpaczek/any-buddy/issues';

export const ORIGINAL_SALT = 'friend-2026-401';

// Centralized system diagnostics for error reporting.
// Pass extra key/value pairs to include context-specific info.
export function diagnostics(extra = {}) {
  const info = {
    Platform: `${platform()} ${arch()}`,
    Node: process.version,
    ...extra,
  };
  return Object.entries(info)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
}

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const RARITY_WEIGHTS = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
};

export const RARITY_STARS = {
  common: '★',
  uncommon: '★★',
  rare: '★★★',
  epic: '★★★★',
  legendary: '★★★★★',
};

export const SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'octopus', 'owl', 'penguin',
  'turtle', 'snail', 'ghost', 'axolotl', 'capybara', 'cactus', 'robot',
  'rabbit', 'mushroom', 'chonk',
];

export const EYES = ['·', '✦', '×', '◉', '@', '°'];

export const HATS = [
  'none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck',
];

export const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];

export const RARITY_FLOOR = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50,
};

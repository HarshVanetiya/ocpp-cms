/**
 * Deterministic randomness.
 *
 * Every fixture in this package comes from a seeded generator, so the fleet
 * looks identical on every reload. That matters more than it sounds: with
 * `Math.random()` you cannot reproduce a bug, screenshots change every refresh,
 * and "station 12 is faulted" is true only until you press F5.
 *
 * mulberry32 — small, fast, good enough for fixtures, not for anything
 * security-related.
 */
export function createRng(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  (): number;
  int(min: number, max: number): number;
  float(min: number, max: number, digits?: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
  bool(probability?: number): boolean;
  shuffle<T>(items: T[]): T[];
  uuid(): string;
  /** A timestamp `maxAgoMs` in the past, biased towards recent. */
  pastIso(maxAgoMs: number, now?: number): string;
}

export function rng(seed: number): Rng {
  const next = createRng(seed);
  const r = next as Rng;

  r.int = (min, max) => Math.floor(next() * (max - min + 1)) + min;

  r.float = (min, max, digits = 2) =>
    Number((next() * (max - min) + min).toFixed(digits));

  r.pick = (items) => items[Math.floor(next() * items.length)];

  r.weighted = (entries) => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let roll = next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1][0];
  };

  r.bool = (probability = 0.5) => next() < probability;

  r.shuffle = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  r.uuid = () => {
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i += 1) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
      else if (i === 14) out += '4';
      else if (i === 19) out += hex[(Math.floor(next() * 16) & 0x3) | 0x8];
      else out += hex[Math.floor(next() * 16)];
    }
    return out;
  };

  r.pastIso = (maxAgoMs, now = Date.now()) => {
    // Square the roll so most timestamps cluster near "now" — a log where
    // events are uniformly spread over 30 days looks nothing like reality.
    const roll = next() ** 2;
    return new Date(now - roll * maxAgoMs).toISOString();
  };

  return r;
}

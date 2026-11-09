// The player's chart settings: defaults, and a strict check of what the app sends.
// Pure: no database. Only known keys with allowed values are kept; anything else is dropped,
// so the JSONB column can never fill up with junk or grow without limit.

import type { ChartSettings } from './contract.js';

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  type: 'candles',
  tf: 'D',
  range: 126,
  bg: 'app',
  colors: 'mint',
  volume: true,
  sma20: false,
  sma50: false,
  grid: true,
  watermark: true,
  lastLine: true,
};

const CHOICES = {
  type: ['candles', 'bars', 'line', 'area'],
  tf: ['D', 'W'],
  range: [22, 66, 126],
  bg: ['app', 'black', 'paper'],
  colors: ['mint', 'classic', 'blue'],
} as const;
const FLAGS = ['volume', 'sma20', 'sma50', 'grid', 'watermark', 'lastLine'] as const;

// The valid part of `input`, or null when nothing in it is valid.
export function pickChartSettings(input: unknown): Partial<ChartSettings> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if ((allowed as readonly unknown[]).includes(src[key])) out[key] = src[key];
  }
  for (const key of FLAGS) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  return Object.keys(out).length > 0 ? (out as Partial<ChartSettings>) : null;
}

// The saved settings on top of the defaults. Old or broken values in the column fall back to the default.
export function withDefaults(saved: unknown): ChartSettings {
  return { ...DEFAULT_CHART_SETTINGS, ...(pickChartSettings(saved) ?? {}) };
}

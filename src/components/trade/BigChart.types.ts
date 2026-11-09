// Props of the full chart. Shared by BigChart.web.tsx (the real chart, web) and BigChart.tsx (phones).

import type { ChartBar, ChartSettings } from '../../../api/src/contract';
import type { Levels } from '../../trade/orderCheck';
import type { Measurement } from './OrderCenter';

// The chart's own colors for the "app" background, taken from the current theme.
export type ChartPalette = {
  bg: string; fg: string; fg2: string; grid: string; border: string;
  // toolbar + menus (the frame around the canvas)
  surface: string; surface2: string; line: string; line2: string; muted: string; text: string; faint: string;
  accent: string; accentInk: string; accentTint: string; warn: string; warnInk: string;
};

export type BigChartProps = {
  symbol: string;
  currency: 'ILS' | 'USD';
  bars: ChartBar[] | null;            // null = still loading
  error: string | null;
  settings: ChartSettings;
  onSettings: (patch: Partial<ChartSettings>) => void;
  savedAt: number;                    // last save of the settings (shows "נשמר ✓")
  palette: ChartPalette;
  levels: Levels;                     // the position tool, in the security's currency
  onLevels: (levels: Levels) => void;
  onLevel: (key: keyof Levels, value: number) => void;
  posOn: boolean;
  onPosToggle: () => void;
  amountIls: number;
  toIls: number;                      // 1 for ₪, the USD/ILS rate for $
  onMeasure: (m: Measurement | null) => void;
};

// Phones: the full chart is a web canvas (Lightweight Charts), so the app shows a note instead.
// The web build uses BigChart.web.tsx. Supporting phones needs an Expo DOM component + react-native-webview.

import { Empty } from '../dashboard/Card';
import type { BigChartProps } from './BigChart.types';

export function BigChart(_props: BigChartProps) {
  return <Empty>הגרף המלא זמין בגרסת הדפדפן. כאן מוצג גרף עשרת הימים.</Empty>;
}

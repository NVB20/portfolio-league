// Breakpoints from the mock-up's media queries, as a hook (React Native has no media queries).
//   < 640  phone: one card per row, 14px gaps (DD-05)
//   >= 640 tablet: two cards side by side, 20px gaps
//   >= 960 desktop: headline column next to the cards, sticky on web

import { Platform, useWindowDimensions } from 'react-native';

export const MAX_WIDTH = 1200;

// Writing direction, passed INLINE: style={[styles.x, ltr]}. react-native-web rejects `direction`
// inside StyleSheet.create, but turns an inline one into CSS `direction`. On iOS/Android it's a normal style.
export const ltr = { direction: 'ltr' } as const;
export const rtl = { direction: 'rtl' } as const;
// Note: react-native-web turns `start`/`end` (and marginStart, paddingEnd...) into left/right from the app-wide
// RTL setting (I18nManager), NOT from our `direction` style. So positions use physical left/right.

// SVG text on the web falls back to a serif font; charts use the system UI font instead.
export const CHART_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' : undefined;

export function useLayout() {
  const { width } = useWindowDimensions();
  const isPhone = width < 640;
  return {
    width,
    isPhone,
    isWide: width >= 960,
    gap: isPhone ? 14 : 20,
    // clamp(34px, 4.4vw, 56px) from the mock-up's section headline
    headlineSize: Math.round(Math.min(56, Math.max(34, width * 0.044))),
  };
}

// `position: sticky` exists only on the web (react-native-web passes it through to CSS).
// The cast is needed because React Native's style types don't include it.
export const webSticky = (top: number) =>
  Platform.OS === 'web' ? ({ position: 'sticky', top } as unknown as { position: 'relative' }) : null;

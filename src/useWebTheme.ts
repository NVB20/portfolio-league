// Web only: the parts of the theme that live in the browser itself, not in our components.
//
// 1. Scrollbars. Browsers draw them light unless the page says otherwise, so a dark dashboard got a white one.
//      color-scheme     which built-in look to use (dark scrollbar, dark form controls)
//      scrollbar-color  the thumb and track colors (Chrome, Edge, Firefox)
//    Both are inherited, so setting them on <html> covers every scrolling area, including ScrollViews.
//
// 2. The theme crossfade (DD-11). When the user switches theme, every color fades over 0.35s instead of
//    snapping. A class on <html> turns the CSS transition on for 400ms, then off again, so it never slows
//    down hover or other effects. Skipped when the device asks for reduced motion.

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { dark, light } from './theme';
import { Theme } from './types/user';

const CROSSFADE_CLASS = 'theming';
const CROSSFADE_CSS = `html.${CROSSFADE_CLASS}, html.${CROSSFADE_CLASS} * {
  transition: background-color .35s, color .35s, border-color .35s, fill .35s, stroke .35s !important;
}`;

export function useWebTheme(theme: Theme) {
  const previous = useRef<Theme | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const root = document.documentElement;
    const colors = theme === 'dark' ? dark : light;

    const changed = previous.current !== null && previous.current !== theme;
    previous.current = theme;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (changed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      ensureStyle();
      root.classList.add(CROSSFADE_CLASS);
      timer = setTimeout(() => root.classList.remove(CROSSFADE_CLASS), 400);
    }

    root.style.setProperty('color-scheme', theme);
    root.style.setProperty('scrollbar-color', `${colors.line2} ${colors.page}`);
    return () => clearTimeout(timer);
  }, [theme]);
}

// Adds the crossfade rule to the page once.
function ensureStyle() {
  if (document.getElementById('theme-crossfade')) return;
  const el = document.createElement('style');
  el.id = 'theme-crossfade';
  el.textContent = CROSSFADE_CSS;
  document.head.appendChild(el);
}

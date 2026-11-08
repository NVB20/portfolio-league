// The dashboard's motion (DD-06), in one place. Everything turns off under "reduce motion".
//
//   Time-based (once, on load):   FadeUp, useTween, useSpring, useLoop
//   Scroll-based (follows the finger, both directions):
//     ScrollReveal  a row slides up and fades in as it enters the screen (sections 2 and 3)
//     useDrift      a whole card group floats slowly against its sticky headline (desktop)
//     Spread        the gaps between cards widen with scroll speed (up to +28px) and close when you stop
//
// Scroll effects need each element's position inside the scrolled content. React Native's onLayout only
// gives the position inside the PARENT, so useMeasure() adds the parent's offset from OffsetContext.
//
// All Animated work uses the JS driver: one scroll value feeds several effects, and mixing native- and
// JS-driven values on one view throws. That's fine at this screen's size.

import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  useWindowDimensions,
  ViewStyle,
} from 'react-native';

const NATIVE = false;
const MAX_SPREAD = 28;      // px added to each gap at full scroll speed
const DRIFT = 0.05;         // how far a card group floats per px scrolled away from the screen's middle

// ---------- reduce motion ----------

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduce(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

// ---------- the scroll context ----------

type Motion = {
  scrollY: Animated.Value;      // the scroll position, for scroll-linked effects
  spread: Animated.Value;       // extra px per gap, from the smoothed scroll speed
  current: { y: number };       // the same scroll position as a plain number, for checks
  viewport: number;             // screen height
  reduce: boolean;
};

const MotionContext = createContext<Motion | null>(null);
export const MotionProvider = MotionContext.Provider;

function useMotionContext() {
  return useContext(MotionContext);
}

export function useReduce(): boolean {
  return useMotionContext()?.reduce ?? false;
}

// For the screen: creates the scroll values and the onScroll handler for an Animated.ScrollView.
export function useScrollMotion() {
  const reduce = useReducedMotion();
  const { height } = useWindowDimensions();
  const scrollY = useRef(new Animated.Value(0)).current;
  const spread = useRef(new Animated.Value(0)).current;
  const current = useRef({ y: 0 }).current;
  const loop = useRef({ lastY: 0, speed: 0, lastT: 0, running: false, lastSpread: 0, raf: 0 }).current;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  // Scroll speed is smoothed: quick to pick up, slow to settle, so the gaps "breathe" instead of jumping.
  // It runs frame by frame only while there is movement, then stops.
  const frame = (t: number) => {
    const dt = Math.max(0.5, Math.min(3, (t - loop.lastT) / 16.7));
    loop.lastT = t;
    const v = Math.abs(current.y - loop.lastY) / dt;
    loop.lastY = current.y;
    loop.speed += (v - loop.speed) * (v > loop.speed ? 0.25 : 0.06);
    if (!v && loop.speed < 0.03) loop.speed = 0;
    const s = Math.round(Math.min(MAX_SPREAD, loop.speed * 0.5) * 2) / 2;
    if (s !== loop.lastSpread) {
      spread.setValue(s);
      loop.lastSpread = s;
    }
    if (loop.speed !== 0 || v !== 0) loop.raf = requestAnimationFrame(frame);
    else loop.running = false;
  };

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: NATIVE,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          current.y = e.nativeEvent.contentOffset.y;
          if (reduceRef.current || loop.running) return;
          loop.running = true;
          loop.lastT = Date.now();
          loop.raf = requestAnimationFrame(frame);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => cancelAnimationFrame(loop.raf), [loop]);

  const motion = useMemo<Motion>(() => ({ scrollY, spread, current, viewport: height, reduce }), [scrollY, spread, current, height, reduce]);
  return { motion, onScroll };
}

// ---------- positions inside the scrolled content ----------

const OffsetContext = createContext(0);
export const OffsetProvider = OffsetContext.Provider;

// Returns this element's top (`abs`) and height inside the scrolled content. Stores the position relative
// to the parent and adds the parent's offset at render, so it stays right when something above it grows.
// `base`: the parent's offset, when the parent is measured in the SAME component (context can't see it yet).
export function useMeasure(base?: number) {
  const fromContext = useContext(OffsetContext);
  const parentY = base ?? fromContext;
  const [box, setBox] = useState<{ rel: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setBox((b) => (b && Math.abs(b.rel - y) < 1 && Math.abs(b.h - height) < 1 ? b : { rel: y, h: height }));
  };
  return { measured: box !== null, abs: parentY + (box?.rel ?? 0), h: box?.h ?? 0, onLayout };
}

// ---------- once, on load ----------

// Slides up and fades in after `delay` ms. Used for section 1's load sequence.
export function FadeUp({ delay = 0, distance = 24, duration = 550, style, children }: {
  delay?: number;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduce = useReduce();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    const a = Animated.timing(v, { toValue: 1, duration, delay, easing: Easing.bezier(0.2, 0.7, 0.2, 1), useNativeDriver: NATIVE });
    a.start();
    return () => a.stop();
  }, [reduce, v, delay, duration]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

// A number that goes 0 -> 1 over `duration` ms, starting `delay` ms after `start` turns true.
// For things drawn from a number each frame (a chart line, a counting value). Under reduce motion: 1.
export function useTween({ start = true, delay = 0, duration = 1000, easing = easeOutCubic } = {}): number {
  const reduce = useReduce();
  return useFrames(start, delay, reduce, (t) => {
    const x = Math.min(1, t / duration);
    return { value: easing(x), done: x >= 1 };
  });
}

// A damped spring 0 -> ~1.07 -> 1 that settles in ~1.2s (DD-06: gauge and weight bars).
// Same math as the mock-up: damping ratio 0.65, natural frequency 11.
export function useSpring({ start = true, delay = 0 } = {}): number {
  const reduce = useReduce();
  return useFrames(start, delay, reduce, (t) => {
    const s = t / 1000;
    if (s >= 1.3) return { value: 1, done: true };
    const z = 0.65;
    const w = 11;
    const wd = w * Math.sqrt(1 - z * z);
    return { value: 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s)), done: false };
  });
}

function useFrames(start: boolean, delay: number, reduce: boolean, at: (ms: number) => { value: number; done: boolean }) {
  const [value, setValue] = useState(reduce ? 1 : 0);
  const atRef = useRef(at);
  atRef.current = at;
  useEffect(() => {
    if (!start) return;
    if (reduce) {
      setValue(1);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const step = () => {
      const r = atRef.current(Date.now() - t0);
      setValue(r.value);
      if (!r.done) raf = requestAnimationFrame(step);
    };
    const timer = setTimeout(() => {
      t0 = Date.now();
      raf = requestAnimationFrame(step);
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [start, delay, reduce]);
  return value;
}

// A value that swings 0 -> 1 -> 0 forever (blinking dot, floating chips, flame). Stays 0 under reduce motion.
// `phase` (0..1) starts the swing part-way through, so two loops on screen don't move in step.
export function useLoop(period: number, phase = 0): Animated.Value {
  const reduce = useReduce();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(0);
      return;
    }
    const half = period / 2;
    const ease = Easing.inOut(Easing.sin);
    v.setValue(phase);
    // resetBeforeIteration: false = each round continues from where the last ended, so there's no jump.
    const swing = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: half, easing: ease, useNativeDriver: NATIVE }),
        Animated.timing(v, { toValue: 0, duration: half, easing: ease, useNativeDriver: NATIVE }),
      ]),
      { iterations: -1, resetBeforeIteration: false },
    );
    swing.start();
    return () => swing.stop();
  }, [reduce, v, period, phase]);
  return v;
}

// ---------- scroll-linked ----------

// Slides up 56px, grows from 96% and fades in while its top travels from the screen's bottom edge
// until 45% of it is on screen. Tied to the scroll position, so scrolling back reverses it.
export function ScrollReveal({ abs, h, measured, children }: { abs: number; h: number; measured: boolean; children: ReactNode }) {
  const m = useMotionContext();
  const progress = useMemo(() => {
    if (!m || m.reduce || !measured) return null;
    const startAt = abs - m.viewport;
    return m.scrollY.interpolate({ inputRange: [startAt, startAt + Math.max(1, h * 0.45)], outputRange: [0, 1], extrapolate: 'clamp' });
  }, [m, abs, h, measured]);

  if (!m || m.reduce) return <>{children}</>;
  if (!progress) return <Animated.View style={{ opacity: 0 }}>{children}</Animated.View>;   // until measured
  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [56, 0] }) },
          { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

// The transform for a card group that floats against its sticky headline (desktop only). Moves the group by
// 5% of its distance from the middle of the screen; the cards inside never move relative to each other.
export function useDrift(enabled: boolean, abs: number, h: number) {
  const m = useMotionContext();
  return useMemo(() => {
    if (!m || m.reduce || !enabled || h === 0) return null;
    const c = -DRIFT * (abs + h / 2 - m.viewport / 2);
    return { transform: [{ translateY: m.scrollY.interpolate({ inputRange: [0, 1], outputRange: [c, c + DRIFT], extrapolate: 'extend' }) }] };
  }, [m, enabled, abs, h]);
}

// Moves its child by `offset` x the current spread. Give items offsets centred on 0 (-1, 0, +1...): the
// group then opens up around its middle, so the gaps widen without the group growing taller.
export function Spread({ offset, style, onLayout, children }: {
  offset: number;
  style?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const m = useMotionContext();
  const move = useMemo(() => (m && !m.reduce && offset !== 0 ? Animated.multiply(m.spread, offset) : null), [m, offset]);
  return (
    <Animated.View style={[style, move ? { transform: [{ translateY: move }] } : null]} onLayout={onLayout}>
      {children}
    </Animated.View>
  );
}

// True once the element's top `threshold` of its height is on screen (then stays true).
export function useSeen(abs: number, h: number, measured: boolean, threshold = 0.4): boolean {
  const m = useMotionContext();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !m || !measured) return;
    const check = (y: number) => {
      if (y + m.viewport >= abs + h * threshold) setSeen(true);
    };
    check(m.current.y);
    const id = m.scrollY.addListener(({ value }) => check(value));
    return () => m.scrollY.removeListener(id);
  }, [seen, m, abs, h, measured, threshold]);
  return seen || !m;
}

// Whether the row around a card has been seen, and which column the card is in (for staggering).
export const SeenContext = createContext(true);
export const ColumnContext = createContext(0);

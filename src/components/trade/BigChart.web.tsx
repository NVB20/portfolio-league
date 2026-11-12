// The full chart (web): TradingView Lightweight Charts v5 with the toolbar on top (TradingView order),
// the canvas, and the range bar at the bottom. Real OHLC + volume from Yahoo (GET /me/chart), cut at
// the world clock. The game trades on the stored open/close, not on these bars (D-012).
//
// On the canvas: a position tool (entry / target / stop for the order amount; drag the box, an edge,
// a label, or the right edge) and a ruler (drag to measure). Both live in chart coordinates
// (bar index × price) and are re-projected whenever the chart moves.
//
// Settings (type, timeframe, range, background, colors, indicators) are saved per player (users.chart_settings).
// Tools (ruler, axis zoom) are not settings.
//
// This file is plain DOM: react-native-web renders into the page, so a <div> here is a real div.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  createChart,
  createTextWatermark,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type ITextWatermarkPluginApi,
  type Logical,
  type MouseEventParams,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import type { ChartBar, ChartSettings } from '../../../api/src/contract';
import { ils } from '../../dashboard/format';
import { money } from '../../trade/copy';
import { positionMath, type Levels } from '../../trade/orderCheck';
import type { BigChartProps } from './BigChart.types';

const TYPES: Record<ChartSettings['type'], string> = { candles: 'נרות', bars: 'ברים', line: 'קו', area: 'שטח' };
const COLORS: Record<ChartSettings['colors'], { up: string; down: string }> = {
  mint: { up: '#5FE3B8', down: '#E5484D' },
  classic: { up: '#26A69A', down: '#EF5350' },
  blue: { up: '#4F8DF7', down: '#F2B84B' },
};
const FIXED_BG = {
  black: { bg: '#050A0C', fg: '#6E8A85', fg2: '#FFFFFF', grid: '#111C20', border: '#1E2F33' },
  paper: { bg: '#F4F7F6', fg: '#4E6C68', fg2: '#0B2B30', grid: '#DFE9E5', border: '#C5D6D0' },
};
const RANGES: [ChartSettings['range'], string][] = [[22, '1M'], [66, '3M'], [126, '6M']];
const MINUS = '−';
const signed = (v: number, s: string) => (v >= 0 ? '+' : MINUS) + s;
const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hexa = (hex: string, a: number) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex);
const dmy = (t: string) => `${t.slice(8, 10)}.${t.slice(5, 7)}`;

// Lightweight Charts gives times back as a string, a {year, month, day} object, or a timestamp.
function tkey(t: Time | undefined): string | null {
  if (t === undefined) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return new Date(t * 1000).toISOString().slice(0, 10);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function sma(bars: ChartBar[], n: number) {
  const out: { time: string; value: number }[] = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: b.time, value: sum / n });
  });
  return out;
}

type Ruler = { l0: number; p0: number; l1: number; p1: number };   // bar index × price
type Menu = 'type' | 'ind' | 'set' | null;

export function BigChart(p: BigChartProps) {
  const { settings: cfg, bars, palette, currency, symbol } = p;
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const extraRef = useRef<ISeriesApi<SeriesType>[]>([]);
  const wmRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const zoom = useRef(1);   // price-axis zoom: < 1 = in, > 1 = out, 1 = auto
  const [, setFrame] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [measuring, setMeasuring] = useState(false);
  const [ruler, setRuler] = useState<Ruler | null>(null);
  const [pos, setPos] = useState<{ t0: string | null; w: number }>({ t0: null, w: cfg.tf === 'W' ? 6 : 20 });
  const [showSaved, setShowSaved] = useState(false);

  const data = useMemo(() => bars ?? [], [bars]);   // stable: the series effect must not rerun every frame
  const theme = cfg.bg === 'app' ? palette : FIXED_BG[cfg.bg];
  const col = COLORS[cfg.colors];
  const fmtP = useCallback((v: number) => money(v, currency), [currency]);

  // Re-project the overlays at most once per frame.
  const raf = useRef(0);
  const redraw = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setFrame((f) => f + 1);
    });
  }, []);

  // ---------- the chart itself: created once ----------
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { fontFamily: 'Heebo, Rubik, system-ui, sans-serif', fontSize: 11, attributionLogo: true },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 2 },
      crosshair: { mode: CrosshairMode.Normal },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
      kineticScroll: { mouse: true, touch: true },
      localization: { locale: 'he-IL' },
    });
    chartRef.current = chart;
    wmRef.current = createTextWatermark(chart.panes()[0], { visible: false, horzAlign: 'center', vertAlign: 'center', lines: [] });

    const onCross = (param: MouseEventParams<Time>) => setHover(tkey(param.time));
    chart.subscribeCrosshairMove(onCross);
    chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);

    // Dragging the price axis fires no event, so a frame loop runs while the pointer is down on the chart.
    let loop = false;
    const tick = () => {
      if (!loop) return;
      redraw();
      requestAnimationFrame(tick);
    };
    const stop = () => {
      loop = false;
      redraw();
    };
    const down = () => {
      if (loop) return;
      loop = true;
      requestAnimationFrame(tick);
    };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    el.addEventListener('wheel', redraw, { passive: true });
    el.addEventListener('dblclick', redraw);
    window.addEventListener('resize', redraw);

    return () => {
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      el.removeEventListener('wheel', redraw);
      el.removeEventListener('dblclick', redraw);
      window.removeEventListener('resize', redraw);
      chart.unsubscribeCrosshairMove(onCross);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      extraRef.current = [];
      wmRef.current = null;
    };
  }, [redraw]);

  const zoomProvider = useCallback(
    () => (original: () => AutoscaleInfo | null) => {
      const r = original();
      if (!r?.priceRange || zoom.current === 1) return r;
      const mid = (r.priceRange.minValue + r.priceRange.maxValue) / 2;
      const half = ((r.priceRange.maxValue - r.priceRange.minValue) / 2) * zoom.current;
      return { priceRange: { minValue: mid - half, maxValue: mid + half }, margins: r.margins };
    },
    [],
  );

  // ---------- series: rebuilt when the data or a setting changes ----------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const transparent = 'rgba(0,0,0,0)';
    chart.applyOptions({
      layout: { background: { color: theme.bg }, textColor: theme.fg },
      grid: { vertLines: { color: cfg.grid ? theme.grid : transparent }, horzLines: { color: cfg.grid ? theme.grid : transparent } },
      crosshair: {
        vertLine: { color: hexa(theme.fg, 0.5), width: 1, style: LineStyle.Dashed, labelBackgroundColor: theme.border },
        horzLine: { color: hexa(theme.fg, 0.5), width: 1, style: LineStyle.Dashed, labelBackgroundColor: theme.border },
      },
      localization: { priceFormatter: fmtP },
    });
    wmRef.current?.applyOptions({
      visible: cfg.watermark,
      lines: [{ text: symbol, color: hexa(theme.fg, cfg.bg === 'paper' ? 0.14 : 0.1), fontSize: 72, fontFamily: 'Rubik, Heebo, system-ui, sans-serif' }],
    });

    [mainRef.current, ...extraRef.current].forEach((s) => s && chart.removeSeries(s));
    mainRef.current = null;
    extraRef.current = [];
    if (data.length === 0) return;

    const common = {
      priceLineVisible: cfg.lastLine,
      priceLineColor: theme.fg2,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1 as const,
      lastValueVisible: true,
      autoscaleInfoProvider: zoomProvider(),
    };
    let main: ISeriesApi<SeriesType>;
    if (cfg.type === 'candles') {
      main = chart.addSeries(CandlestickSeries, { ...common, upColor: col.up, downColor: col.down, borderVisible: false, wickUpColor: col.up, wickDownColor: col.down });
    } else if (cfg.type === 'bars') {
      main = chart.addSeries(BarSeries, { ...common, upColor: col.up, downColor: col.down, thinBars: false });
    } else if (cfg.type === 'line') {
      main = chart.addSeries(LineSeries, { ...common, color: col.up, lineWidth: 2 });
    } else {
      main = chart.addSeries(AreaSeries, { ...common, lineColor: col.up, topColor: hexa(col.up, 0.35), bottomColor: hexa(col.up, 0), lineWidth: 2 });
    }
    main.setData(cfg.type === 'line' || cfg.type === 'area' ? data.map((b) => ({ time: b.time, value: b.close })) : data);
    mainRef.current = main;

    if (cfg.volume) {
      const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(data.map((b) => ({ time: b.time, value: b.volume, color: hexa(b.close >= b.open ? col.up : col.down, 0.35) })));
      extraRef.current.push(vol);
    }
    const avg = (n: number, color: string) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: zoomProvider() });
      s.setData(sma(data, n));
      extraRef.current.push(s);
    };
    if (cfg.sma20) avg(20, '#F2B84B');
    if (cfg.sma50) avg(50, '#9B7BFF');

    const n = cfg.tf === 'W' ? Math.ceil(cfg.range / 5) : cfg.range;
    if (n >= data.length) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleRange({ from: data[data.length - n].time, to: data[data.length - 1].time });
    redraw();
  }, [data, cfg, theme, col, symbol, fmtP, zoomProvider, redraw]);

  // A new security or timeframe: the ruler is cleared and the position box starts over.
  useEffect(() => {
    setRuler(null);
    setPos({ t0: null, w: cfg.tf === 'W' ? 6 : 20 });
  }, [symbol, cfg.tf]);

  // "נשמר ✓" for 1.6s after each save.
  useEffect(() => {
    if (!p.savedAt) return;
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 1600);
    return () => clearTimeout(t);
  }, [p.savedAt]);

  // Escape closes menus and clears the ruler; a click outside a menu closes it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setRuler(null);
    };
    const click = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.lwc-pop')) setMenu(null);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('click', click);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('click', click);
    };
  }, []);

  // ---------- coordinates ----------
  const chart = chartRef.current;
  const main = mainRef.current;
  const xOf = (i: number) => chart?.timeScale().logicalToCoordinate(i as Logical) ?? null;
  const logOf = (x: number) => chart?.timeScale().coordinateToLogical(x) ?? null;
  const yOf = (v: number) => main?.priceToCoordinate(v) ?? null;
  const pOf = (y: number) => main?.coordinateToPrice(y) ?? null;
  const paneW = () => (holder.current?.clientWidth ?? 0) - (chart?.priceScale('right').width() ?? 0);
  const paneH = () => holder.current?.clientHeight ?? 0;
  const at = (l: number) => data[Math.min(data.length - 1, Math.max(0, Math.round(l)))]?.time ?? '';

  // The measurement in time order, sent up to the stats strip.
  const measurement = useMemo(() => {
    if (!ruler || data.length === 0) return null;
    const a = { time: at(ruler.l0), price: ruler.p0 };
    const b = { time: at(ruler.l1), price: ruler.p1 };
    return { from: ruler.l1 >= ruler.l0 ? a : b, to: ruler.l1 >= ruler.l0 ? b : a, bars: Math.abs(Math.round(ruler.l1) - Math.round(ruler.l0)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruler, data]);
  const { onMeasure } = p;
  useEffect(() => onMeasure(measuring ? measurement : null), [measurement, measuring, onMeasure]);

  // ---------- position tool ----------
  const levelsRef = useRef(p.levels);
  levelsRef.current = p.levels;
  const idx0 = () => {
    if (data.length === 0) return 0;
    const def = Math.max(0, data.length - 1 - Math.round(pos.w * 0.6));
    if (!pos.t0) return def;
    let i = data.findIndex((b) => b.time === pos.t0);
    if (i < 0) data.forEach((b, k) => { if (b.time <= pos.t0!) i = k; });
    return i < 0 ? def : i;
  };

  function startDrag(kind: string, e: ReactPointerEvent<HTMLDivElement>) {
    if (!main || !holder.current) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const r = holder.current.getBoundingClientRect();
    const s = { x: e.clientX - r.left, y: e.clientY - r.top, levels: levelsRef.current, i0: idx0() };
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (kind === 'body') {
        const p0 = pOf(s.y), p1 = pOf(y);
        if (p0 != null && p1 != null && s.levels.stop + (p1 - p0) > 0) {
          const d = p1 - p0;
          p.onLevels({ entry: s.levels.entry + d, target: s.levels.target + d, stop: s.levels.stop + d });
        }
        const li = logOf(x), ls = logOf(s.x);
        if (li != null && ls != null && data.length) {
          const ni = Math.min(data.length - 1, Math.max(0, Math.round(s.i0 + li - ls)));
          setPos((q) => ({ ...q, t0: data[ni].time }));
        }
      } else if (kind === 'right') {
        const li = logOf(x);
        if (li != null) setPos((q) => ({ ...q, w: Math.max(2, Math.round(li - s.i0)) }));
      } else {
        const v = pOf(y);
        if (v != null) p.onLevel(kind as keyof Levels, v);
      }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function startRuler(e: ReactPointerEvent<HTMLDivElement>) {
    if (!main || !holder.current) return;
    e.preventDefault();
    const cap = e.currentTarget;
    cap.setPointerCapture(e.pointerId);
    const r = holder.current.getBoundingClientRect();
    const l0 = logOf(e.clientX - r.left), p0 = pOf(e.clientY - r.top);
    if (l0 == null || p0 == null) return;
    setRuler({ l0, p0, l1: l0, p1: p0 });
    let moved = false;
    const move = (ev: PointerEvent) => {
      const l1 = logOf(ev.clientX - r.left), p1 = pOf(ev.clientY - r.top);
      if (l1 == null || p1 == null) return;
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 3) moved = true;
      setRuler({ l0, p0, l1, p1 });
    };
    const up = () => {
      cap.removeEventListener('pointermove', move);
      cap.removeEventListener('pointerup', up);
      cap.removeEventListener('pointercancel', up);
      if (!moved) setRuler(null);
    };
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', up);
    cap.addEventListener('pointercancel', up);
  }

  function axisZoom(z: 'in' | 'out' | 'reset') {
    if (!chart || !main) return;
    zoom.current = z === 'in' ? zoom.current * 0.8 : z === 'out' ? zoom.current * 1.25 : 1;
    chart.priceScale('right').applyOptions({ autoScale: true });
    [main, ...extraRef.current].forEach((s) => {
      if (s.seriesType() !== 'Histogram') s.applyOptions({ autoscaleInfoProvider: zoomProvider() });
    });
    redraw();
  }

  // ---------- render ----------
  const legendBar = data.find((b) => b.time === hover) ?? data[data.length - 1];
  const vars = {
    '--tvbg': theme.bg, '--tvfg': theme.fg, '--tvfg2': theme.fg2,
    '--pupc': col.up, '--pdnc': col.down, '--pup': hexa(col.up, 0.14), '--pdn': hexa(col.down, 0.14),
    '--c-surface': palette.surface, '--c-surface2': palette.surface2, '--c-line': palette.line, '--c-line2': palette.line2,
    '--c-muted': palette.muted, '--c-text': palette.text, '--c-faint': palette.faint,
    '--c-accent': palette.accent, '--c-accent-ink': palette.accentInk, '--c-accent-tint': palette.accentTint,
    '--c-warn': palette.warn, '--c-warn-ink': palette.warnInk,
  } as CSSProperties;

  const pick = (patch: Partial<ChartSettings>) => p.onSettings(patch);

  return (
    <div className="lwc" style={vars}>
      <style>{CSS}</style>
      <div className="lwc-toolbar" dir="rtl">
        <div className="lwc-grp" role="radiogroup" aria-label="טווח נר">
          {(['D', 'W'] as const).map((tf) => (
            <button key={tf} type="button" className={cfg.tf === tf ? 'on' : ''} aria-checked={cfg.tf === tf} role="radio" onClick={() => pick({ tf })}>
              {tf === 'D' ? 'יומי' : 'שבועי'}
            </button>
          ))}
        </div>

        <div className="lwc-pop">
          <button type="button" className="lwc-pb" aria-haspopup="menu" aria-expanded={menu === 'type'} onClick={() => setMenu(menu === 'type' ? null : 'type')}>
            <svg className="lwc-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v3M7 17v3M17 2v4M17 15v7" /><rect x="4" y="7" width="6" height="10" rx="1" /><rect x="14" y="6" width="6" height="9" rx="1" /></svg>
            {TYPES[cfg.type]}<span className="car">▼</span>
          </button>
          {menu === 'type' ? (
            <div className="lwc-menu" role="menu">
              {(Object.keys(TYPES) as ChartSettings['type'][]).map((t) => (
                <button key={t} type="button" role="menuitemradio" aria-checked={cfg.type === t} className={cfg.type === t ? 'on' : ''} onClick={() => pick({ type: t })}>
                  {{ candles: 'נרות יפניים', bars: 'ברים OHLC', line: 'קו', area: 'שטח' }[t]}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="lwc-pop">
          <button type="button" className="lwc-pb" aria-haspopup="menu" aria-expanded={menu === 'ind'} onClick={() => setMenu(menu === 'ind' ? null : 'ind')}>
            <span className="fx">ƒx</span>אינדיקטורים<span className="car">▼</span>
          </button>
          {menu === 'ind' ? (
            <div className="lwc-menu" role="menu">
              {([['volume', 'מחזור'], ['sma20', 'ממוצע נע 20'], ['sma50', 'ממוצע נע 50'], ['grid', 'רשת']] as const).map(([k, label]) => (
                <button key={k} type="button" role="menuitemcheckbox" aria-checked={cfg[k]} className={cfg[k] ? 'on' : ''} onClick={() => pick({ [k]: !cfg[k] })}>
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button type="button" className={`lwc-pb${p.posOn ? ' on' : ''}`} aria-pressed={p.posOn} onClick={p.onPosToggle} title="כניסה, יעד וסטופ לסכום הפקודה">
          <svg className="lwc-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16" /><path d="M6 16l4-6 4 3 4-7" /></svg>פוזיציה
        </button>
        <button
          type="button"
          className={`lwc-pb${measuring ? ' on' : ''}`}
          aria-pressed={measuring}
          onClick={() => {
            setMeasuring(!measuring);
            setRuler(null);
          }}
          title="גרור על הגרף כדי למדוד"
        >
          <svg className="lwc-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15l12-12 6 6-12 12z" /><path d="M8 10l2 2M11 7l2 2M14 4l2 2" /></svg>מדידה
        </button>

        <span className="lwc-sep" />

        <div className="lwc-pop">
          <button type="button" className="lwc-pb" aria-haspopup="menu" aria-expanded={menu === 'set'} aria-label="הגדרות גרף" onClick={() => setMenu(menu === 'set' ? null : 'set')}>
            <svg className="lwc-i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>
          </button>
          {menu === 'set' ? (
            <div className="lwc-menu end" role="menu">
              <div className="h">רקע</div>
              {([['app', 'אפליקציה', palette.bg], ['black', 'שחור', FIXED_BG.black.bg], ['paper', 'נייר', FIXED_BG.paper.bg]] as const).map(([v, label, sw]) => (
                <button key={v} type="button" role="menuitemradio" aria-checked={cfg.bg === v} className={cfg.bg === v ? 'on' : ''} onClick={() => pick({ bg: v })}>
                  <span className="l"><i className="sw" style={{ background: sw }} />{label}</span>
                </button>
              ))}
              <div className="h">צבעי עלייה / ירידה</div>
              {([['mint', 'מנטה'], ['classic', 'קלאסי'], ['blue', 'כחול']] as const).map(([v, label]) => (
                <button key={v} type="button" role="menuitemradio" aria-checked={cfg.colors === v} className={cfg.colors === v ? 'on' : ''} onClick={() => pick({ colors: v })}>
                  <span className="l"><i className="sw2"><i style={{ background: COLORS[v].up }} /><i style={{ background: COLORS[v].down }} /></i>{label}</span>
                </button>
              ))}
              <div className="h">תצוגה</div>
              <button type="button" role="menuitemcheckbox" aria-checked={cfg.watermark} className={cfg.watermark ? 'on' : ''} onClick={() => pick({ watermark: !cfg.watermark })}>סימן מים של הנייר</button>
              <button type="button" role="menuitemcheckbox" aria-checked={cfg.lastLine} className={cfg.lastLine ? 'on' : ''} onClick={() => pick({ lastLine: !cfg.lastLine })}>קו מחיר אחרון</button>
              <hr />
              <button type="button" onClick={() => pick({ type: 'candles', bg: 'app', colors: 'mint', volume: true, sma20: false, sma50: false, grid: true, watermark: true, lastLine: true, range: 126 })}>
                <span>חזרה לברירת המחדל<small>נשמר למשתמש שלך</small></span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={`lwc-cw${measuring ? ' measuring' : ''}`}>
        <div className="lwc-lw" ref={holder} />
        {legendBar ? <Legend bar={legendBar} symbol={symbol} tf={cfg.tf} col={col} volume={cfg.volume} /> : null}
        {data.length > 0 ? (
          <div className="lwc-ov">
            {p.posOn ? <PositionTool {...{ data, levels: p.levels, idx0: idx0(), w: pos.w, xOf, yOf, paneW: paneW(), paneH: paneH(), currency, amountIls: p.amountIls, toIls: p.toIls, startDrag }} /> : null}
            {ruler ? <RulerBox {...{ ruler, measurement, xOf, yOf, paneH: paneH(), currency, unit: cfg.tf === 'W' ? 'שבועות' : 'ימי מסחר' }} /> : null}
            {measuring ? <div className="lwc-cap" onPointerDown={startRuler} /> : null}
          </div>
        ) : null}
        <div className="lwc-axz">
          <button type="button" title="הגדל את ציר המחיר" onClick={() => axisZoom('in')}>+</button>
          <button type="button" title="כווץ את ציר המחיר" onClick={() => axisZoom('out')}>−</button>
          <button type="button" title="חזרה לקנה מידה אוטומטי" onClick={() => axisZoom('reset')}>⟲</button>
        </div>
        {measuring && !ruler ? <div className="lwc-hint">גרור על הגרף כדי למדוד</div> : null}
        {bars === null && !p.error ? <div className="lwc-msg">טוען גרף…</div> : null}
        {p.error ? <div className="lwc-msg">{p.error}</div> : null}
        {bars !== null && bars.length === 0 ? <div className="lwc-msg">אין עדיין נתונים לגרף.</div> : null}
      </div>

      <div className="lwc-foot">
        <div className="lwc-ranges" role="radiogroup" aria-label="טווח זמן">
          {RANGES.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={cfg.range === v} className={cfg.range === v ? 'on' : ''} onClick={() => pick({ range: v })}>
              {label}
            </button>
          ))}
        </div>
        <div className="lwc-saved" dir="rtl">
          <span className="txt">ההגדרות נשמרות למשתמש</span>
          <span className="chip" style={{ opacity: showSaved ? 1 : 0 }}>נשמר ✓</span>
        </div>
      </div>
    </div>
  );
}

function Legend({ bar, symbol, tf, col, volume }: { bar: ChartBar; symbol: string; tf: 'D' | 'W'; col: { up: string; down: string }; volume: boolean }) {
  const c = bar.close >= bar.open ? col.up : col.down;
  const v = (x: number) => <b style={{ color: c }}>{fmt2(x)}</b>;
  return (
    <div className="lwc-legend">
      <b>{symbol}</b>
      <span>{`${tf === 'W' ? '1W' : '1D'} · ${dmy(bar.time)}`}</span>
      <span>O {v(bar.open)}</span>
      <span>H {v(bar.high)}</span>
      <span>L {v(bar.low)}</span>
      <span>C {v(bar.close)}</span>
      {volume ? <span>Vol <b>{(bar.volume / 1e6).toFixed(2)}M</b></span> : null}
    </div>
  );
}

function PositionTool({ data, levels, idx0, w, xOf, yOf, paneW, paneH, currency, amountIls, toIls, startDrag }: {
  data: ChartBar[];
  levels: Levels;
  idx0: number;
  w: number;
  xOf: (i: number) => number | null;
  yOf: (v: number) => number | null;
  paneW: number;
  paneH: number;
  currency: 'ILS' | 'USD';
  amountIls: number;
  toIls: number;
  startDrag: (kind: string, e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const yE = yOf(levels.entry), yT = yOf(levels.target), yS = yOf(levels.stop), x0 = xOf(idx0), x1 = xOf(idx0 + w);
  if (data.length === 0 || [yE, yT, yS, x0, x1].some((v) => v == null)) return null;
  const L = Math.max(0, Math.min(x0!, paneW)), R = Math.max(L, Math.min(x1!, paneW));
  if (R - L < 2) return null;
  const m = positionMath(amountIls, levels);
  const units = levels.entry * toIls > 0 ? amountIls / (levels.entry * toIls) : 0;
  const h = (kind: string) => ({ onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => startDrag(kind, e) });
  const label = (cls: string, y: number, kind: string, a: string, b: string, aria: string) => (
    <div className={`pl ${cls}`} style={{ top: y }} role="slider" aria-label={aria} aria-valuenow={Number(levels[kind as keyof Levels].toFixed(2))} {...h(kind)}>
      <span>{a}</span><small>{b}</small>
    </div>
  );
  return (
    <div className="lwc-ptool" style={{ left: L, width: R - L, height: paneH }}>
      <div className="pz up" style={{ top: yT!, height: Math.max(0, yE! - yT!) }} {...h('body')} />
      <div className="pz dn" style={{ top: yE!, height: Math.max(0, yS! - yE!) }} {...h('body')} />
      <div className="ph h" style={{ top: yT! }} {...h('target')} />
      <div className="ph h" style={{ top: yE! }} {...h('entry')} />
      <div className="ph h" style={{ top: yS! }} {...h('stop')} />
      <div className="ph v" style={{ left: R - L, top: yT!, height: Math.max(0, yS! - yT!) }} {...h('right')} />
      {label('t', yT!, 'target', `יעד ${money(levels.target, currency)}`, `${signed(m.tp, `${Math.abs(m.tp * 100).toFixed(1)}%`)} · ${signed(m.reward, ils(Math.abs(m.reward)))}`, 'יעד')}
      {label('e', yE!, 'entry', `כניסה ${money(levels.entry, currency)}`, `${units.toLocaleString('en-US', { maximumFractionDigits: 2 })} יח׳ · 1 : ${m.rr.toFixed(2)}`, 'כניסה')}
      {label('s', yS!, 'stop', `סטופ ${money(levels.stop, currency)}`, `${MINUS}${(m.sl * 100).toFixed(1)}% · ${MINUS}${ils(Math.abs(m.risk))}`, 'סטופ')}
    </div>
  );
}

function RulerBox({ ruler, measurement, xOf, yOf, paneH, currency, unit }: {
  ruler: Ruler;
  measurement: { from: { time: string; price: number }; to: { time: string; price: number }; bars: number } | null;
  xOf: (i: number) => number | null;
  yOf: (v: number) => number | null;
  paneH: number;
  currency: 'ILS' | 'USD';
  unit: string;
}) {
  const x0 = xOf(ruler.l0), x1 = xOf(ruler.l1), y0 = yOf(ruler.p0), y1 = yOf(ruler.p1);
  if (!measurement || [x0, x1, y0, y1].some((v) => v == null)) return null;
  const { from: a, to: b } = measurement;
  const ch = b.price / a.price - 1;
  const up = ch >= 0;
  const days = Math.round((Date.parse(b.time) - Date.parse(a.time)) / 864e5);
  return (
    <div className="lwc-ruler">
      <div className={`rb ${up ? 'up' : 'dn'}`} style={{ left: Math.min(x0!, x1!), top: Math.min(y0!, y1!), width: Math.abs(x1! - x0!), height: Math.abs(y1! - y0!) }} />
      <div className={`rl ${up ? 'up' : 'dn'}`} style={{ left: (x0! + x1!) / 2, top: Math.min(paneH - 60, Math.max(y0!, y1!) + 10) }}>
        <b>{`${signed(ch, money(Math.abs(b.price - a.price), currency))} (${signed(ch, `${Math.abs(ch * 100).toFixed(2)}%`)})`}</b>
        <small>{`${measurement.bars} ${unit}${days > 0 ? ` · ${days} ימים` : ''}`}</small>
      </div>
    </div>
  );
}

// The frame's CSS, ported from the design artifact. Colors come from CSS variables set on .lwc.
const CSS = `
.lwc { border-radius: 16px; border: 1px solid var(--c-line); background: var(--tvbg); position: relative; margin-top: 12px; font-family: Heebo, Rubik, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.lwc button { font-family: inherit; cursor: pointer; }
.lwc button:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
.lwc-i { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.lwc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; background: var(--c-surface2); border-bottom: 1px solid var(--c-line); border-radius: 16px 16px 0 0; position: relative; z-index: 8; }
.lwc-grp { display: flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--c-surface); border: 1px solid var(--c-line); }
.lwc-grp button { border: 0; background: none; color: var(--c-muted); border-radius: 8px; padding: 0 10px; height: 28px; font-weight: 500; font-size: 12.5px; white-space: nowrap; }
.lwc-grp button:hover { color: var(--c-text); }
.lwc-grp button.on { background: var(--c-accent); color: var(--c-accent-ink); font-weight: 600; }
.lwc-pb { border: 1px solid var(--c-line); background: var(--c-surface); color: var(--c-muted); border-radius: 10px; padding: 0 10px; height: 34px; font-weight: 500; font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: border-color .15s, color .15s; }
.lwc-pb:hover { color: var(--c-text); border-color: var(--c-faint); }
.lwc-pb.on { border-color: var(--c-accent); color: var(--c-accent); background: var(--c-accent-tint); }
.lwc-pb .car { font-size: 9px; opacity: .7; }
.lwc-pb .fx { font: italic 600 13px serif; }
.lwc-sep { flex: 1; }
.lwc-pop { position: relative; }
.lwc-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 220px; background: var(--c-surface2); border: 1px solid var(--c-line2); border-radius: 16px; padding: 6px; box-shadow: 0 24px 40px -20px rgba(0,0,0,.9); display: grid; gap: 2px; direction: rtl; }
.lwc-menu.end { right: auto; left: 0; }
.lwc-menu button { width: 100%; text-align: start; border: 0; background: none; color: var(--c-muted); border-radius: 10px; padding: 8px 10px; font-weight: 500; font-size: 13px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.lwc-menu button:hover { background: var(--c-surface); color: var(--c-text); }
.lwc-menu button.on { color: var(--c-text); }
.lwc-menu button.on::after { content: "✓"; color: var(--c-accent); font-weight: 700; }
.lwc-menu button small { display: block; color: var(--c-faint); font-size: 11px; }
.lwc-menu .h { font-weight: 600; font-size: 11px; letter-spacing: .06em; color: var(--c-faint); padding: 8px 10px 4px; }
.lwc-menu .l { display: flex; align-items: center; gap: 8px; }
.lwc-menu .sw { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(127,127,127,.35); flex: none; display: inline-block; }
.lwc-menu .sw2 { display: inline-grid; grid-template-columns: 1fr 1fr; gap: 1px; width: 16px; height: 14px; flex: none; }
.lwc-menu .sw2 i { border-radius: 2px; }
.lwc-menu hr { border: 0; border-top: 1px solid var(--c-line); margin: 4px 0; }
.lwc-cw { position: relative; direction: ltr; overflow: hidden; }
.lwc-cw.measuring { cursor: crosshair; }
.lwc-lw { height: 420px; width: 100%; }
@media (max-width: 600px) { .lwc-lw { height: 320px; } .lwc-legend { right: 12px !important; } .lwc-saved .txt { display: none; } }
.lwc-legend { position: absolute; top: 10px; left: 12px; right: 76px; z-index: 6; font-size: 11.5px; color: var(--tvfg); display: flex; gap: 10px; flex-wrap: wrap; pointer-events: none; }
.lwc-legend b { font-weight: 600; color: var(--tvfg2); }
.lwc-msg { position: absolute; inset: 0; display: grid; place-items: center; color: var(--tvfg); font-size: 13px; direction: rtl; z-index: 7; pointer-events: none; }
.lwc-hint { position: absolute; bottom: 14px; left: 50%; translate: -50% 0; z-index: 6; background: var(--c-warn); color: var(--c-warn-ink); border-radius: 999px; padding: 5px 12px; font-weight: 600; font-size: 12px; white-space: nowrap; direction: rtl; pointer-events: none; }
.lwc-ov { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.lwc-ptool, .lwc-ruler { position: absolute; top: 0; left: 0; }
.lwc-ptool .pz { position: absolute; left: 0; right: 0; pointer-events: auto; cursor: move; touch-action: none; border-left: 1px dashed var(--tvfg); border-right: 1px dashed var(--tvfg); }
.lwc-ptool .pz.up { background: var(--pup); border-top: 1px solid var(--pupc); }
.lwc-ptool .pz.dn { background: var(--pdn); border-bottom: 1px solid var(--pdnc); }
.lwc-ptool .pz.up::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; border-top: 1px dashed var(--tvfg2); }
.lwc-ptool .ph { position: absolute; pointer-events: auto; touch-action: none; }
.lwc-ptool .ph.h { left: 0; right: 0; height: 10px; translate: 0 -50%; cursor: ns-resize; }
.lwc-ptool .ph.v { width: 10px; translate: -50% 0; cursor: ew-resize; }
.lwc-ptool .pl { position: absolute; left: 50%; translate: -50% -50%; pointer-events: auto; cursor: ns-resize; direction: rtl; display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 10px; font-weight: 600; font-size: 11.5px; white-space: nowrap; user-select: none; touch-action: none; box-shadow: 0 8px 20px -10px rgba(0,0,0,.8); }
.lwc-ptool .pl.t { background: var(--pupc); color: #081214; }
.lwc-ptool .pl.s { background: var(--pdnc); color: #fff; }
.lwc-ptool .pl.e { background: var(--tvfg2); color: var(--tvbg); }
.lwc-ptool .pl small { font-weight: 500; opacity: .8; }
.lwc-ruler .rb { position: absolute; border: 1px solid; }
.lwc-ruler .rb.up { background: var(--pup); border-color: var(--pupc); }
.lwc-ruler .rb.dn { background: var(--pdn); border-color: var(--pdnc); }
.lwc-ruler .rl { position: absolute; translate: -50% 0; border-radius: 10px; padding: 6px 10px; text-align: center; font-weight: 600; font-size: 12px; white-space: nowrap; direction: rtl; box-shadow: 0 8px 20px -10px rgba(0,0,0,.8); }
.lwc-ruler .rl.up { background: var(--pupc); color: #081214; }
.lwc-ruler .rl.dn { background: var(--pdnc); color: #fff; }
.lwc-ruler .rl b, .lwc-ruler .rl small { display: block; }
.lwc-ruler .rl small { font-weight: 500; opacity: .8; font-size: 11px; }
.lwc-cap { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; touch-action: none; }
.lwc-axz { position: absolute; right: 8px; bottom: 34px; z-index: 7; display: grid; gap: 3px; }
.lwc-axz button { width: 26px; height: 24px; border-radius: 7px; border: 1px solid var(--tvfg); background: var(--tvbg); color: var(--tvfg2); font-weight: 600; font-size: 14px; display: grid; place-items: center; opacity: .7; padding: 0; }
.lwc-axz button:hover { opacity: 1; }
.lwc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--c-line); background: var(--c-surface2); border-radius: 0 0 16px 16px; direction: ltr; }
.lwc-ranges { display: flex; gap: 2px; }
.lwc-ranges button { border: 0; background: none; color: var(--c-muted); border-radius: 8px; padding: 4px 9px; font-weight: 600; font-size: 11.5px; }
.lwc-ranges button:hover { color: var(--c-text); }
.lwc-ranges button.on { background: var(--c-surface); color: var(--c-text); }
.lwc-saved { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--c-faint); }
.lwc-saved .chip { transition: opacity .3s; background: var(--c-accent-tint); color: var(--c-accent); font-weight: 600; padding: 3px 8px; border-radius: 999px; }
@media (prefers-reduced-motion: reduce) { .lwc *, .lwc *::before, .lwc *::after { transition: none !important; } }
`;

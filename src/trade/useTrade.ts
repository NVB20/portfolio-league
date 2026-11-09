// Data for the trading screen:
//   useTrade()             GET /me/trade once when the screen opens
//   useChart(symbol, tf)   GET /me/chart/:symbol, kept in memory per symbol + tf while the app is open
//   useChartSettings()     the player's chart settings, saved with PATCH /me/chart-settings (debounced)

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { ChartSettings, ChartView, TradeView } from '../../api/src/contract';

type State = { data: TradeView | null; error: string | null; isLoading: boolean };

export function useTrade() {
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: true });
  const alive = useRef(true);

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const data = await apiFetch<TradeView>('/me/trade');
      if (alive.current) setState({ data, error: null, isLoading: false });
    } catch (e) {
      console.error('Could not load the trading screen', e);
      if (alive.current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את המסחר', isLoading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  return { ...state, reload };
}

// One fetch per symbol + tf for the life of the app: switching back and forth costs nothing.
const chartCache = new Map<string, Promise<ChartView>>();

export function useChart(symbol: string | null, tf: 'D' | 'W') {
  const [chart, setChart] = useState<ChartView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let current = true;
    const key = `${symbol}:${tf}`;
    let p = chartCache.get(key);
    if (!p) {
      p = apiFetch<ChartView>(`/me/chart/${encodeURIComponent(symbol)}?tf=${tf}`);
      chartCache.set(key, p);
      p.catch(() => chartCache.delete(key));   // don't keep a failure: the next visit tries again
    }
    setError(null);
    p.then((c) => current && setChart(c)).catch((e) => {
      console.error('Could not load the chart', e);
      if (current) setError('הגרף לא נטען. נסו שוב בעוד רגע.');
    });
    return () => {
      current = false;
    };
  }, [symbol, tf]);

  // Only bars for the symbol + tf asked for; never the previous symbol's while the new one loads.
  const fresh = chart && chart.symbol === symbol && chart.tf === tf ? chart : null;
  return { chart: fresh, error };
}

const SAVE_DELAY_MS = 600;

export function useChartSettings(initial: ChartSettings | null) {
  const [settings, setSettings] = useState<ChartSettings | null>(initial);
  const [savedAt, setSavedAt] = useState(0);   // last successful save, for the "נשמר ✓" chip
  const pending = useRef<Partial<ChartSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The first time the data arrives, take the saved settings.
  useEffect(() => {
    if (initial && !settings) setSettings(initial);
  }, [initial, settings]);

  const flush = useCallback(async () => {
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length === 0) return;
    try {
      await apiFetch<ChartSettings>('/me/chart-settings', { method: 'PATCH', body: JSON.stringify(body) });
      setSavedAt(Date.now());
    } catch (e) {
      console.error('Could not save the chart settings', e);
    }
  }, []);

  // Changes show at once; several quick clicks are saved in one request.
  const change = useCallback(
    (patch: Partial<ChartSettings>) => {
      setSettings((s) => (s ? { ...s, ...patch } : s));
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      flush();   // leaving the screen: save what's left
    },
    [flush],
  );

  return { settings, change, savedAt };
}

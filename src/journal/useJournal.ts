// Data for the trade journal (/journal, D-035):
//   GET /me/journal?filter=&period=     the results and the first 20 rows. Switching the filter or the period
//                                       loads again.
//   loadMore()                          "טען עוד 20": &before=<the last row's id>, appended
// The answer carries the world clock, for the top bar and for the reload at each open and close.
//
// Like the leaderboard, it loads again when the world clock passes an open or a close (or a new day begins), since
// that is when orders run. The runner gets to them up to a minute later (D-030), so while an answer says a pending
// order is `due`, it asks again every 15 to 30 s until it isn't (dueRetryMs). A reload keeps the journal on screen
// while it loads, and keeps the rows "טען עוד" added (reloadLimit). A failed load keeps the last good journal and
// says so (`error`).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { TradeJournalFilter, TradeJournalPeriod, TradeJournalView } from '../../api/src/contract';
import { marketsChanged } from '../dashboard/markets';
import { useElapsed } from '../dashboard/useElapsed';
import { dueRetryMs, journalPath, mergePage, reloadLimit } from './journal';

export type MoreState = 'idle' | 'loading' | 'failed';

type State = { data: TradeJournalView | null; error: string | null; isLoading: boolean; more: MoreState };

export function useJournal(initialFilter: TradeJournalFilter) {
  const [filter, setFilterState] = useState<TradeJournalFilter>(initialFilter);
  const [period, setPeriodState] = useState<TradeJournalPeriod>('all');
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: true, more: 'idle' });
  const alive = useRef(true);        // false after the screen closes, so a late answer doesn't set state
  const query = useRef({ filter: initialFilter, period: 'all' as TradeJournalPeriod });
  const dataRef = useRef<TradeJournalView | null>(null);
  const seq = useRef(0);             // the newest request wins: an answer for another filter or period is dropped
  const moreBusy = useRef(false);
  const eventBusy = useRef(false);
  const dueTries = useRef(0);        // loads in a row that found a pending order due

  // `limit` = how many rows: the first page, or as many as are shown (a reload).
  const load = useCallback(async (limit?: number) => {
    const id = ++seq.current;
    const { filter: f, period: p } = query.current;
    setState((s) => ({ ...s, isLoading: true, error: null, more: 'idle' }));
    try {
      const data = await apiFetch<TradeJournalView>(journalPath(f, p, { limit }));
      if (!alive.current || id !== seq.current) return;
      dataRef.current = data;
      setState({ data, error: null, isLoading: false, more: 'idle' });
    } catch (e) {
      console.error('Could not load the journal', e);
      if (!alive.current || id !== seq.current) return;
      // Keep the last good journal on screen, and the filter and period it shows: the switches must not claim a
      // choice whose rows never came (pressing it again is the retry).
      const shown = dataRef.current;
      if (shown) {
        query.current = { filter: shown.filter, period: shown.period };
        setFilterState(shown.filter);
        setPeriodState(shown.period);
      }
      setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את היומן', isLoading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const setFilter = useCallback(
    (f: TradeJournalFilter) => {
      if (f === query.current.filter) return;
      query.current = { ...query.current, filter: f };
      setFilterState(f);
      void load();
    },
    [load],
  );

  const setPeriod = useCallback(
    (p: TradeJournalPeriod) => {
      if (p === query.current.period) return;
      query.current = { ...query.current, period: p };
      setPeriodState(p);
      void load();
    },
    [load],
  );

  // The same filter and period again, with as many rows as are shown.
  const reload = useCallback(() => {
    void load(reloadLimit(dataRef.current?.rows.length ?? 0));
  }, [load]);

  // The 20 rows sent before the last one shown.
  const loadMore = useCallback(async () => {
    const cur = dataRef.current;
    const last = cur?.rows[cur.rows.length - 1];
    if (!cur?.hasMore || !last || moreBusy.current) return;
    moreBusy.current = true;
    const id = seq.current;   // a reload or a switch after this point makes the answer stale
    setState((s) => ({ ...s, more: 'loading' }));
    try {
      const page = await apiFetch<TradeJournalView>(journalPath(cur.filter, cur.period, { before: last.id }));
      if (!alive.current || id !== seq.current) return;
      const merged = mergePage(cur, page);
      dataRef.current = merged;
      setState((s) => ({ ...s, data: merged, more: 'idle' }));
    } catch (e) {
      console.error('Could not load more of the journal', e);
      if (alive.current && id === seq.current) setState((s) => ({ ...s, more: 'failed' }));
    } finally {
      moreBusy.current = false;
    }
  }, []);

  // An open or close has passed since the journal (and its clock) was loaded: orders may have run. Load it again.
  const clock = state.data?.clock ?? null;
  const elapsed = useElapsed(clock);
  const moved = clock ? marketsChanged(clock, elapsed) : false;
  useEffect(() => {
    if (!moved || eventBusy.current) return;
    eventBusy.current = true;
    dueTries.current = 0;   // a new open or close: an order may be due again
    void load(reloadLimit(dataRef.current?.rows.length ?? 0)).finally(() => {
      eventBusy.current = false;
    });
  }, [moved, elapsed, load]);

  // A pending order's time has passed and the runner hasn't run it yet: ask again soon, until it has run or
  // MAX_DUE_TRIES ran out. A newer answer, a switch or closing the screen cancels the timer.
  const { data, error } = state;
  useEffect(() => {
    if (!data) return;
    if (!data.due) dueTries.current = 0;
    const ms = dueRetryMs(data, dueTries.current);
    if (ms === null) return;
    const timer = setTimeout(() => {
      dueTries.current += 1;
      void load(reloadLimit(dataRef.current?.rows.length ?? 0));
    }, ms);
    return () => clearTimeout(timer);
  }, [data, error, load]);

  return { ...state, filter, period, setFilter, setPeriod, reload, loadMore, clock };
}

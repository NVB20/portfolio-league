// Data for the leaderboard screen (/leaderboard):
//   GET /me/leaderboard?view=top&from=1 or ?view=around   the board shown (D-032): 20 rows from place 1, or my
//                                                        place ± 5. Switching the view loads again.
//   loadMore()                                           "טען עוד 20": view=top&from=<last place + 1>, appended
// The answer carries the world clock, for the top bar and for the reload at each open and close.
//
// Like the trading screen, the board is loaded again when the world clock passes an open or a close (or a new
// day begins), since that is when places can change. The runner scores that event a little later (up to a minute,
// D-034), so while an answer says the board is `behind` the clock, it is loaded again every 15 to 30 s until it
// catches up (behindRetryMs). A reload keeps the board on screen while it loads, and keeps the rows "טען עוד"
// added (up to MAX_KEPT_ROWS). A failed load keeps the last good board and says so (`error`).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { LeaderboardView } from '../../api/src/contract';
import { marketsChanged } from '../dashboard/markets';
import { useElapsed } from '../dashboard/useElapsed';
import { behindRetryMs, boardPath, mergePage, nextFrom, PAGE_SIZE, sameBoard, type TableView } from './board';

export type MoreState = 'idle' | 'loading' | 'failed';

type State = { data: LeaderboardView | null; error: string | null; isLoading: boolean; more: MoreState };

// A reload fetches again at most this many rows (5 pages): it runs at every open and close, when every open screen
// reloads at once.
const MAX_KEPT_ROWS = 5 * PAGE_SIZE;

export function useLeaderboard() {
  const [view, setViewState] = useState<TableView>('top');
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: true, more: 'idle' });
  const alive = useRef(true);        // false after the screen closes, so a late answer doesn't set state
  const viewRef = useRef<TableView>('top');
  const dataRef = useRef<LeaderboardView | null>(null);
  const seq = useRef(0);              // the newest board request wins: an older answer (other view) is dropped
  const moreBusy = useRef(false);
  const eventBusy = useRef(false);
  const behindTries = useRef(0);      // loads in a row that found the board behind the clock

  // `keep` = how many rows to load: the first page of the view, then the next pages again (from the same ranking)
  // until there are that many, so a reload doesn't drop what "טען עוד" added. A page that fails or comes from a
  // newer ranking stops it there.
  const load = useCallback(async (v: TableView, keep = 0) => {
    const id = ++seq.current;
    const current = () => alive.current && id === seq.current;
    setState((s) => ({ ...s, isLoading: true, error: null, more: 'idle' }));
    try {
      let data = await apiFetch<LeaderboardView>(boardPath(v));
      const want = Math.min(keep, MAX_KEPT_ROWS);
      while (data.hasMore && data.rows.length < want && current()) {
        const page = await apiFetch<LeaderboardView>(boardPath('top', nextFrom(data))).catch((e: unknown) => {
          console.error('Could not load the next page of the leaderboard', e);
          return null;
        });
        if (!page || !sameBoard(data, page)) break;
        data = mergePage(data, page);
      }
      if (!current()) return;
      dataRef.current = data;
      setState({ data, error: null, isLoading: false, more: 'idle' });
    } catch (e) {
      console.error('Could not load the leaderboard', e);
      if (!current()) return;
      // Keep the last good board on screen, and the view it shows: the switch must not claim a view whose rows
      // never came (pressing the other option again is the retry). The screen shows the error over the table.
      const shown = dataRef.current?.view;
      if (shown && shown !== viewRef.current) {
        viewRef.current = shown;
        setViewState(shown);
      }
      setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את הטבלה', isLoading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load(viewRef.current);
    return () => {
      alive.current = false;
    };
  }, [load]);

  const setView = useCallback(
    (v: TableView) => {
      if (v === viewRef.current) return;
      viewRef.current = v;
      setViewState(v);
      void load(v);
    },
    [load],
  );

  // The same view again, with as many rows as are loaded.
  const reload = useCallback(() => {
    void load(viewRef.current, dataRef.current?.rows.length ?? 0);
  }, [load]);

  // The next 20 places after the last row, in either view. If the board was re-ranked meanwhile (another day, or the
  // same day scored again), the page wouldn't fit the rows above it: load the view again instead, with this page.
  const loadMore = useCallback(async () => {
    const cur = dataRef.current;
    if (!cur?.hasMore || moreBusy.current) return;
    moreBusy.current = true;
    const id = seq.current;   // a reload or a view switch after this point makes the answer stale
    setState((s) => ({ ...s, more: 'loading' }));
    try {
      const page = await apiFetch<LeaderboardView>(boardPath('top', nextFrom(cur)));
      if (!alive.current || id !== seq.current) return;
      if (!sameBoard(cur, page)) {
        void load(viewRef.current, cur.rows.length + PAGE_SIZE);
        return;
      }
      const merged = mergePage(cur, page);
      dataRef.current = merged;
      setState((s) => ({ ...s, data: merged, more: 'idle' }));
    } catch (e) {
      console.error('Could not load more of the leaderboard', e);
      if (alive.current && id === seq.current) setState((s) => ({ ...s, more: 'failed' }));
    } finally {
      moreBusy.current = false;
    }
  }, [load]);

  // An open or close has passed since the board (and its clock) was loaded: load it again, with as many rows as
  // are shown. The new answer's clock ends `moved`. If the load fails, the last board stays with its error and
  // retry, and the next tick (useElapsed ticks every 10 s while the clock runs) tries again.
  const clock = state.data?.clock ?? null;
  const elapsed = useElapsed(clock);
  const moved = clock ? marketsChanged(clock, elapsed) : false;
  useEffect(() => {
    if (!moved || eventBusy.current) return;
    eventBusy.current = true;
    behindTries.current = 0;   // a new open or close: the board may be behind it again
    void load(viewRef.current, dataRef.current?.rows.length ?? 0).finally(() => {
      eventBusy.current = false;
    });
  }, [moved, elapsed, load]);

  // The board shown is behind the clock (an open or close has passed and isn't scored yet): load it again soon,
  // with as many rows as are shown, until an answer has caught up or MAX_BEHIND_TRIES ran out. A failed load (the
  // error changes) schedules the next try too. A newer answer, a view switch or closing the screen cancels it.
  const { data, error } = state;
  useEffect(() => {
    if (!data) return;
    if (!data.behind) behindTries.current = 0;
    const ms = behindRetryMs(data, behindTries.current);
    if (ms === null) return;
    const timer = setTimeout(() => {
      behindTries.current += 1;
      void load(viewRef.current, dataRef.current?.rows.length ?? 0);
    }, ms);
    return () => clearTimeout(timer);
  }, [data, error, load]);

  return { ...state, view, setView, reload, loadMore, clock };
}

export type LeaderboardState = ReturnType<typeof useLeaderboard>;

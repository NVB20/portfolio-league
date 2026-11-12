// The toasts' state (D-023, D-031): which notices are on screen, and telling the API which ones the player saw.
// The screen calls `markShown(ids)` only once the toast is actually visible; this sends exactly those ids to
// POST /me/rejections/seen, each once. If the call fails they stay unseen and show again on the next load.
// Rejections and stop-loss sales (D-037) are marked seen the same way, each list on its own toast.

import { useCallback, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { HoldingView, RejectionView, RejectionsSeenBody, RejectionsSeenResult, StopSaleView } from '../../api/src/contract';
import { idsToMark, rejectionNotices, stopSaleNotices, type RejectionNotice } from './rejections';

export function useRejectionToasts(rejections: RejectionView[], holdings: HoldingView[]) {
  return useSeenNotices(useMemo(() => rejectionNotices(rejections, holdings), [rejections, holdings]));
}

export function useStopSaleToasts(stopSales: StopSaleView[]) {
  return useSeenNotices(useMemo(() => stopSaleNotices(stopSales), [stopSales]));
}

function useSeenNotices(all: RejectionNotice[]) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const sent = useRef(new Set<string>());   // reported (or being reported) in this session

  const notices = useMemo(() => all.filter((n) => !closed.has(n.id)), [all, closed]);

  const markShown = useCallback((shown: string[]) => {
    const ids = idsToMark(shown, sent.current);
    if (ids.length === 0) return;
    ids.forEach((id) => sent.current.add(id));
    const body: RejectionsSeenBody = { ids };
    apiFetch<RejectionsSeenResult>('/me/rejections/seen', { method: 'POST', body: JSON.stringify(body) }).catch((e) => {
      console.warn('Could not mark the notices as seen; they will show again', e);
      ids.forEach((id) => sent.current.delete(id));   // may be reported again if shown again
    });
  }, []);

  // The player closed the toast: hide what is on it now (new ones from a later load still show).
  const close = useCallback(() => {
    setClosed((c) => new Set([...c, ...notices.map((n) => n.id)]));
  }, [notices]);

  return { notices, markShown, close };
}

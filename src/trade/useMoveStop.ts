// Moving a stop loss: PATCH /me/stops/:id (D-041), from a holding card or a journal row.
// `onMoved` reloads the screen that shows the stop: after a move, and after a refusal that says the screen is out of
// date (the stop fired meanwhile, the close changed).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type { MoveStopResult } from '../../api/src/contract';
import { moveFailure, moveStopBody } from './stopMove';

export function useMoveStop(onMoved: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);   // a ref, so two presses in the same frame can't both send
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // true = the stop is at `price` now (moved, or already there).
  const save = useCallback(async (id: string, price: number): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<MoveStopResult>(`/me/stops/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(moveStopBody(price)),
      });
      onMoved();
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) console.error('Stop move got no answer', e);
      const failure = moveFailure(e instanceof ApiError ? { status: e.status, body: e.body } : null);
      if (alive.current) setError(failure.message);
      if (failure.reload) onMoved();
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [onMoved]);

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, save, clearError };
}

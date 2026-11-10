// Sending an order: POST /me/orders (D-018, D-028).
//
// Which clientOrderId goes with which order lives in SendMemory (orderBody.ts), one per player for the life of
// the page. The id is made when the confirm step opens (prepare). After a send with no answer (offline, the 10 s
// timeout, a 5xx) the order may be stored, so that ticket keeps the exact body and id that went out: pressing
// again resends exactly them, and the server answers with the stored order (replay: true) instead of storing a
// second one. That holds while other orders are prepared or sent, after a reload, and after leaving the screen.
// A definite answer clears it: a success (the same order again is then a new order), a refusal, or a conflict.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type { SendOrderResult } from '../../api/src/contract';
import { memoryFor, type OrderBody } from './orderBody';
import { sendFailure, type SendFailure } from './sendError';

export type SendOutcome = { ok: true; result: SendOrderResult } | ({ ok: false } & SendFailure);

// uid: the signed-in player. ticket: what the ticket holds (symbol:side:amount typed).
export function useSendOrder(uid: string) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);   // a ref, so two presses in the same frame can't both send
  const alive = useRef(true);
  const memory = memoryFor(uid);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The confirm step opened.
  const prepare = useCallback((ticket: string, body: OrderBody | null) => memory.prepare(ticket, body), [memory]);

  // null = nothing was sent (a send is already on its way, or there is nothing to send).
  const send = useCallback(async (ticket: string, body: OrderBody | null): Promise<SendOutcome | null> => {
    if (inFlight.current) return null;
    const sent = memory.pick(ticket, body);
    if (!sent) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await apiFetch<SendOrderResult>('/me/orders', {
        method: 'POST',
        body: JSON.stringify({ ...sent.body, clientOrderId: sent.id }),
      });
      memory.settle(ticket, sent, 'stored');
      return { ok: true, result };
    } catch (e) {
      // No answer at all (offline, the 10 s timeout, a body that didn't parse) is not an ApiError.
      if (!(e instanceof ApiError)) console.error('Order send got no answer', e);
      const failure = sendFailure(e instanceof ApiError ? { status: e.status, body: e.body } : null);
      memory.settle(ticket, sent, failure.outcome);
      return { ok: false, ...failure };
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }, [memory]);

  return { busy, prepare, send };
}

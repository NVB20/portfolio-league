// The POST /me/orders body (SendOrderBody, D-018, D-028), built from the ticket. Pure: no React, no network.
// A buy is ₪ with 2 decimals; a sell is the units sellPlan() worked out, as a string with 8 decimals (a JSON
// number could carry a float's long tail, which the server refuses rather than rounds).
//
// The imports are type-only and end in .js: api/test/app-trade.test.ts loads this file under the API's
// NodeNext type check, which wants the extension. The app's bundler never sees them (types are erased).

import type { SendOrderBody } from '../../api/src/contract.js';
import type { SellPlan, Side } from './orderCheck.js';

// stop: a buy's stop loss in the security's currency (D-037), already at 2 decimals (stopSent); null or absent = none.
export type OrderDraft = { symbol: string; side: Side; amount: number; sell: SellPlan | null; stop?: number | null };

// The body without its clientOrderId (useSendOrder adds that). null = nothing to send.
export type OrderBody = Omit<SendOrderBody, 'clientOrderId'>;

export function orderBody({ symbol, side, amount, sell, stop }: OrderDraft): OrderBody | null {
  if (side === 'buy') {
    if (!(amount > 0)) return null;
    return stop != null ? { symbol, side, amountIls: amount.toFixed(2), stopPrice: stop.toFixed(2) } : { symbol, side, amountIls: amount.toFixed(2) };
  }
  return sell ? { symbol, side, units: sell.units } : null;
}

// One key per distinct order: a retry of the same order keeps its clientOrderId, any change gets a new one.
export function bodyKey(b: OrderBody): string {
  return [b.symbol, b.side, b.amountIls ?? '', b.units ?? '', b.stopPrice ?? ''].join('|');
}

// A fresh clientOrderId (^[A-Za-z0-9_-]{1,64}$). crypto.randomUUID where the engine has it (it is missing
// on older engines and on plain http pages other than localhost), otherwise time + randomness: it only has to
// be unique among one player's orders.
export function newClientOrderId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const rand = () => Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${rand()}-${rand()}`;
}

export type Prepared = { body: OrderBody; id: string };

// unknown = no answer (the order may be stored); stored = 201/200; refused = a 4xx, nothing stored under that
// id; conflict = CLIENT_ID_CONFLICT, the id belongs to another order.
export type Settled = 'unknown' | 'stored' | 'refused' | 'conflict';

const MAX_UNSURE = 20;   // unanswered sends kept per player; the oldest goes first

// Which clientOrderId goes with which order, and which sends never got an answer.
//
// `ticket` is what the player has in the ticket (symbol:side:amount typed). After a send with no answer, that
// ticket keeps the exact body that went out and its id, whatever else is prepared or sent meanwhile, and
// however a reload changes what the ticket works out (a ₪ sell's units move with the free units). Pressing
// again resends exactly that, so the server answers with the stored order (replay) instead of storing a second.
// Only a definite answer for it clears it.
export class SendMemory {
  private unsure = new Map<string, Prepared>();
  // The id made when the confirm step opened, for the body it showed. Never sent yet, so it may be replaced.
  private prepared: { key: string; id: string } | null = null;

  constructor(private readonly makeId: () => string = newClientOrderId) {}

  // The confirm step opened: make the id for this order now.
  prepare(ticket: string, body: OrderBody | null): void {
    if (!this.unsure.has(ticket) && body) this.idFor(body);
  }

  // What a confirm press sends: the unanswered send of this ticket if there is one, else this body.
  pick(ticket: string, body: OrderBody | null): Prepared | null {
    const u = this.unsure.get(ticket);
    if (u) return u;
    return body ? { body, id: this.idFor(body) } : null;
  }

  settle(ticket: string, sent: Prepared, outcome: Settled): void {
    if (outcome === 'unknown') {
      this.unsure.delete(ticket);   // re-insert: newest last
      this.unsure.set(ticket, sent);
      while (this.unsure.size > MAX_UNSURE) this.unsure.delete(this.unsure.keys().next().value!);
      return;
    }
    this.unsure.delete(ticket);
    // Stored or taken: this id must never go with a new order again (the same order again is a new order).
    if (outcome === 'stored' || outcome === 'conflict') {
      if (this.prepared?.id === sent.id) this.prepared = null;
      for (const [t, u] of this.unsure) if (u.id === sent.id) this.unsure.delete(t);
    }
  }

  private idFor(body: OrderBody): string {
    const key = bodyKey(body);
    for (const u of this.unsure.values()) if (bodyKey(u.body) === key) return u.id;
    if (this.prepared?.key !== key) this.prepared = { key, id: this.makeId() };
    return this.prepared.id;
  }
}

// One memory per player for the life of the page: leaving the trading screen and coming back keeps it, and
// another player signing in on the same tab never gets the first one's bodies.
const memories = new Map<string, SendMemory>();

export function memoryFor(uid: string): SendMemory {
  let m = memories.get(uid);
  if (!m) memories.set(uid, (m = new SendMemory()));
  return m;
}

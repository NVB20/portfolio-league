// Moving a stop loss in the app (D-041): the request body, the editor's words, what a refusal says, and the
// journal's sentence about a buy's stop. Pure helpers from src/trade/stopMove.ts and src/journal/journal.ts; no
// React, no network.

import { describe, expect, it } from 'vitest';
import type { TradeJournalRow } from '../src/contract.js';
import { checkStop } from '../../src/trade/orderCheck.js';
import {
  canSaveStop, MOVE_NETWORK_FAILURE, moveFailure, moveStopBody, stopEditLine, stopNowText,
} from '../../src/trade/stopMove.js';
import { buyStopText } from '../../src/journal/journal.js';

describe('moveStopBody', () => {
  it('sends the price with 2 decimals, as a string', () => {
    expect(moveStopBody(98.5)).toEqual({ stopPrice: '98.50' });
    expect(moveStopBody(95)).toEqual({ stopPrice: '95.00' });
  });
});

describe('stopNowText (the holding card)', () => {
  it('names the stop, and where it started once moved', () => {
    expect(stopNowText(95, 95, 'ILS')).toBe('סטופ ₪95.00');
    expect(stopNowText(98.5, 95, 'ILS')).toBe('סטופ ₪98.50 · הוזז מ־₪95.00');
    expect(stopNowText(410, 400, 'USD')).toBe('סטופ $410.00 · הוזז מ־$400.00');
  });
});

describe('stopEditLine and canSaveStop (the editor)', () => {
  it('says how far under the latest close a valid price is', () => {
    const c = checkStop(98, 100, 0);
    expect(stopEditLine(c, 100, 'ILS')).toBe('−2.0% מהסגירה האחרונה (₪100.00)');
    expect(canSaveStop(c, 95)).toBe(true);
  });

  it('blocks a price at or above the latest close, and says the limit', () => {
    const c = checkStop(100, 100, 0);
    expect(stopEditLine(c, 100, 'ILS')).toBe('חייב להיות נמוך מ־₪100.00, הסגירה האחרונה');
    expect(canSaveStop(c, 95)).toBe(false);
  });

  it('blocks an empty field, no known close, and the price the stop already has', () => {
    expect(stopEditLine(checkStop(0, 100, 0), 100, 'ILS')).toBe('הזן מחיר לסטופ');
    expect(canSaveStop(checkStop(0, 100, 0), 95)).toBe(false);
    expect(stopEditLine(checkStop(90, null, 0), null, 'ILS')).toBe('אין עדיין מחיר למניה');
    expect(canSaveStop(checkStop(90, null, 0), 95)).toBe(false);
    expect(canSaveStop(checkStop(95, 100, 0), 95)).toBe(false);
  });
});

describe('moveFailure', () => {
  it("shows the server's Hebrew reason when there is one", () => {
    const f = moveFailure({ status: 409, body: { code: 'STOP_CHECK_RUNNING', reason: 'נבדק עכשיו' } });
    expect(f).toEqual({ message: 'נבדק עכשיו', reload: false });
  });

  it('falls back per code, and reloads when the screen is out of date', () => {
    expect(moveFailure({ status: 409, body: { code: 'STOP_NOT_ACTIVE' } })).toEqual({ message: 'הסטופ לוס כבר לא פעיל: הוא הופעל או פג.', reload: true });
    expect(moveFailure({ status: 422, body: { code: 'STOP_NOT_BELOW_PRICE' } }).reload).toBe(true);
    expect(moveFailure({ status: 429, body: { code: 'RATE_LIMITED' } }).reload).toBe(false);
  });

  it('after no answer, says pressing again is safe', () => {
    expect(moveFailure(null)).toEqual({ message: MOVE_NETWORK_FAILURE, reload: false });
    expect(moveFailure({ status: 502, body: null })).toEqual({ message: MOVE_NETWORK_FAILURE, reload: false });
    expect(moveFailure({ status: 418, body: { code: 'TEAPOT' } }).message).toBe('הסטופ לא הוזז. נסו שוב בעוד רגע.');
  });
});

describe("buyStopText (the journal's buy rows)", () => {
  const row = (o: Partial<TradeJournalRow>): Pick<TradeJournalRow, 'stopPrice' | 'stop' | 'currency'> => ({
    stopPrice: 95, stop: null, currency: 'ILS', ...o,
  });

  it('a pending buy names the stop it was sent with', () => {
    expect(buyStopText(row({}))).toBe('סטופ ₪95.00');
  });

  it('a filled buy shows its stop now: moved, fired or expired', () => {
    expect(buyStopText(row({ stop: { id: '1', price: 95, status: 'active', lastClose: 100 } }))).toBe('סטופ ₪95.00');
    expect(buyStopText(row({ stop: { id: '1', price: 98, status: 'active', lastClose: 100 } }))).toBe('סטופ ₪98.00 (הוזז מ־₪95.00)');
    expect(buyStopText(row({ stop: { id: '1', price: 95, status: 'triggered', lastClose: null } }))).toBe('סטופ ₪95.00 · הופעל');
    expect(buyStopText(row({ stop: { id: '1', price: 90, status: 'expired', lastClose: null } }))).toBe('סטופ ₪90.00 (הוזז מ־₪95.00) · פג');
  });

  it('a buy with no stop says nothing', () => {
    expect(buyStopText(row({ stopPrice: null }))).toBe('');
  });
});

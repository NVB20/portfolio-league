// Journal builders for the double-entry ledger (api/src/game/ledger.ts, D-019). Pure, no database.
// Amounts are agorot: 100_000n = ₪1,000.00.

import { describe, expect, it } from 'vitest';
import {
  buyJournal, isBalanced, type Journal, ledgerBalances, releaseJournal, reserveJournal, reversalJournal,
  sellJournal, startJournal,
} from '../src/game/ledger.js';

const cash = (amount: bigint, account: 'cash_free' | 'cash_locked' | 'realized_pnl' | 'capital') =>
  ({ account, symbol: null, amount });
const stock = (symbol: string, amount: bigint) => ({ account: 'stock_cost' as const, symbol, amount });

describe('journal builders', () => {
  it('start: cash_free +cash, capital −cash', () => {
    const j = startJournal(100_000_000n);
    expect(j).toEqual({
      kind: 'start', orderId: null,
      entries: [cash(100_000_000n, 'cash_free'), cash(-100_000_000n, 'capital')],
    });
    expect(isBalanced(j)).toBe(true);
  });

  it('reserve: cash_free −amount, cash_locked +amount', () => {
    const j = reserveJournal('7', 100_000n);
    expect(j).toEqual({ kind: 'reserve', orderId: '7', entries: [cash(-100_000n, 'cash_free'), cash(100_000n, 'cash_locked')] });
    expect(isBalanced(j)).toBe(true);
  });

  it('release: cash_locked −amount, cash_free +amount', () => {
    const j = releaseJournal('7', 100_000n);
    expect(j).toEqual({ kind: 'release', orderId: '7', entries: [cash(-100_000n, 'cash_locked'), cash(100_000n, 'cash_free')] });
    expect(isBalanced(j)).toBe(true);
  });

  it('buy: cash_locked −amount, stock_cost(symbol) +amount', () => {
    const j = buyJournal('7', 'NVDA', 10_000_000n);
    expect(j).toEqual({ kind: 'buy', orderId: '7', entries: [cash(-10_000_000n, 'cash_locked'), stock('NVDA', 10_000_000n)] });
    expect(isBalanced(j)).toBe(true);
  });

  it('every builder refuses a zero, negative or non-bigint amount', () => {
    for (const bad of [0n, -1n, 1 as unknown as bigint]) {
      expect(() => startJournal(bad)).toThrow();
      expect(() => reserveJournal('1', bad)).toThrow();
      expect(() => releaseJournal('1', bad)).toThrow();
      expect(() => buyJournal('1', 'X', bad)).toThrow();
    }
  });

  it('order journals need an order id, stock journals a symbol', () => {
    expect(() => reserveJournal('', 100n)).toThrow();
    expect(() => releaseJournal(null as unknown as string, 100n)).toThrow();
    expect(() => buyJournal('', 'X', 100n)).toThrow();
    expect(() => buyJournal('1', '', 100n)).toThrow();
    expect(() => sellJournal('', 'X', 100n, 50n)).toThrow();
    expect(() => sellJournal('1', '', 100n, 50n)).toThrow();
  });
});

describe('sellJournal', () => {
  it('a gain: cash in, cost out, the gain as − on realized_pnl', () => {
    const j = sellJournal('9', 'X', 110_000n, 100_000n)!;
    expect(j).toEqual({
      kind: 'sell', orderId: '9',
      entries: [cash(110_000n, 'cash_free'), stock('X', -100_000n), cash(-10_000n, 'realized_pnl')],
    });
    expect(isBalanced(j)).toBe(true);
  });

  it('a loss is + on realized_pnl', () => {
    const j = sellJournal('9', 'X', 90_000n, 100_000n)!;
    expect(j.entries).toEqual([cash(90_000n, 'cash_free'), stock('X', -100_000n), cash(10_000n, 'realized_pnl')]);
    expect(isBalanced(j)).toBe(true);
  });

  it('drops zero lines: break-even, worthless proceeds, free cost', () => {
    expect(sellJournal('9', 'X', 100_000n, 100_000n)!.entries)
      .toEqual([cash(100_000n, 'cash_free'), stock('X', -100_000n)]);
    expect(sellJournal('9', 'X', 0n, 5n)!.entries).toEqual([stock('X', -5n), cash(5n, 'realized_pnl')]);
    expect(sellJournal('9', 'X', 5n, 0n)!.entries).toEqual([cash(5n, 'cash_free'), cash(-5n, 'realized_pnl')]);
    for (const j of [sellJournal('9', 'X', 100_000n, 100_000n), sellJournal('9', 'X', 0n, 5n), sellJournal('9', 'X', 5n, 0n)]) {
      expect(isBalanced(j!)).toBe(true);
      expect(j!.entries.every((e) => e.amount !== 0n)).toBe(true);
    }
  });

  it('returns null for a dust sale worth ₪0.00 with ₪0.00 cost', () => {
    expect(sellJournal('9', 'X', 0n, 0n)).toBeNull();
  });

  it('refuses negative proceeds or cost', () => {
    expect(() => sellJournal('9', 'X', -1n, 0n)).toThrow();
    expect(() => sellJournal('9', 'X', 0n, -1n)).toThrow();
  });
});

describe('isBalanced', () => {
  const j = (entries: Journal['entries']): Journal => ({ kind: 'reversal', orderId: null, entries });

  it('accepts two or more non-zero lines that sum to 0', () => {
    expect(isBalanced(j([cash(1n, 'cash_free'), cash(-1n, 'capital')]))).toBe(true);
    expect(isBalanced(j([cash(3n, 'cash_free'), stock('X', -1n), cash(-2n, 'realized_pnl')]))).toBe(true);
  });

  it('refuses fewer than two lines, a zero line, or a non-zero sum', () => {
    expect(isBalanced(j([]))).toBe(false);
    expect(isBalanced(j([cash(0n, 'cash_free')]))).toBe(false);
    expect(isBalanced(j([cash(1n, 'cash_free'), cash(-1n, 'capital'), cash(0n, 'cash_locked')]))).toBe(false);
    expect(isBalanced(j([cash(1n, 'cash_free'), cash(-2n, 'capital')]))).toBe(false);
  });

  it('requires a symbol on stock_cost lines and only there', () => {
    expect(isBalanced(j([{ account: 'stock_cost', symbol: null, amount: 1n }, cash(-1n, 'capital')]))).toBe(false);
    expect(isBalanced(j([{ account: 'stock_cost', symbol: '', amount: 1n }, cash(-1n, 'capital')]))).toBe(false);
    expect(isBalanced(j([{ account: 'cash_free', symbol: 'X', amount: 1n }, cash(-1n, 'capital')]))).toBe(false);
  });

  it('refuses an unknown account', () => {
    expect(isBalanced(j([{ account: 'bonus' as 'capital', symbol: null, amount: 1n }, cash(-1n, 'capital')]))).toBe(false);
  });
});

describe('reversalJournal', () => {
  it('writes the same lines with the opposite sign, so the two cancel out', () => {
    const original = sellJournal('9', 'X', 110_000n, 100_000n)!;
    const r = reversalJournal(original);
    expect(r.kind).toBe('reversal');
    expect(r.orderId).toBe('9');
    expect(r.entries).toEqual([cash(-110_000n, 'cash_free'), stock('X', 100_000n), cash(10_000n, 'realized_pnl')]);
    expect(isBalanced(r)).toBe(true);
    const b = ledgerBalances([original, r]);
    expect([b.cashFree, b.cashLocked, b.realizedPnl, b.capital, b.stockCost.get('X')]).toEqual([0n, 0n, 0n, 0n, 0n]);
  });

  it('refuses to reverse an unbalanced journal', () => {
    expect(() => reversalJournal({ kind: 'buy', orderId: '1', entries: [cash(1n, 'cash_free')] })).toThrow();
  });
});

describe('ledgerBalances', () => {
  it('reproduces the D-019 example: buy 10 units at ₪100, sell them at ₪110', () => {
    const journals = [
      startJournal(100_000n),                     // ₪1,000
      reserveJournal('1', 100_000n),
      buyJournal('1', 'X', 100_000n),
      sellJournal('2', 'X', 110_000n, 100_000n)!,
    ];
    for (const j of journals) expect(isBalanced(j)).toBe(true);
    const b = ledgerBalances(journals);
    expect(b.cashFree).toBe(110_000n);
    expect(b.cashLocked).toBe(0n);
    expect(b.stockCost).toEqual(new Map([['X', 0n]]));
    expect(b.realizedPnl).toBe(-10_000n);          // shown as a ₪100 gain
    expect(b.capital).toBe(-100_000n);
  });

  it('sums every account to 0 across all journals', () => {
    const journals = [
      startJournal(100_000_000n),
      reserveJournal('1', 5_000_000n), buyJournal('1', 'A', 5_000_000n),
      reserveJournal('2', 3_000_000n), releaseJournal('2', 3_000_000n),
      sellJournal('3', 'A', 1_000_000n, 2_000_000n)!,
    ];
    const b = ledgerBalances(journals);
    const stockTotal = [...b.stockCost.values()].reduce((s, v) => s + v, 0n);
    expect(b.cashFree + b.cashLocked + b.realizedPnl + b.capital + stockTotal).toBe(0n);
    expect(b.stockCost.get('A')).toBe(3_000_000n);
    expect(b.realizedPnl).toBe(1_000_000n);        // a ₪10,000 loss
  });

  it('returns zeros for no journals', () => {
    expect(ledgerBalances([])).toEqual({ cashFree: 0n, cashLocked: 0n, realizedPnl: 0n, capital: 0n, stockCost: new Map() });
  });
});

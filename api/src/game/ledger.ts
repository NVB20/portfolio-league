// Journal builders for the double-entry ledger (D-019). Pure functions: no database, no framework.
// Every money event is a journal whose entries add up to exactly 0, so money can only move, never appear.
// Sign rule: + is what the player has (cash_free, cash_locked, stock_cost); − is where it came from
// (capital, realized_pnl). A ₪100 gain is −100 on realized_pnl; a ₪100 loss is +100.
// Amounts are ₪ at SCALE.ILS (agorot). The database refuses a 0 line, so no builder ever writes one.

export type Account = 'cash_free' | 'cash_locked' | 'stock_cost' | 'realized_pnl' | 'capital';
export type Entry = { account: Account; symbol: string | null; amount: bigint };   // ILS scale, never 0
export type JournalKind = 'start' | 'reserve' | 'release' | 'buy' | 'sell' | 'reversal';
export type Journal = { kind: JournalKind; orderId: string | null; entries: Entry[] };

const ACCOUNTS: ReadonlySet<string> = new Set(['cash_free', 'cash_locked', 'stock_cost', 'realized_pnl', 'capital']);

// ≥ 2 entries, none 0, sum 0, and only stock_cost lines name a symbol. The same rules as the database.
export function isBalanced(j: Journal): boolean {
  if (j.entries.length < 2) return false;
  let sum = 0n;
  for (const e of j.entries) {
    if (!ACCOUNTS.has(e.account) || typeof e.amount !== 'bigint' || e.amount === 0n) return false;
    const hasSymbol = typeof e.symbol === 'string' && e.symbol.length > 0;
    if (e.account === 'stock_cost' ? !hasSymbol : e.symbol !== null) return false;
    sum += e.amount;
  }
  return sum === 0n;
}

function line(account: Exclude<Account, 'stock_cost'>, amount: bigint): Entry {
  return { account, symbol: null, amount };
}

function stock(symbol: string, amount: bigint): Entry {
  return { account: 'stock_cost', symbol, amount };
}

function positive(amount: bigint, what: string): void {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new RangeError(`${what} must be a positive bigint, got ${amount}`);
}

function checkSymbol(symbol: string): void {
  if (typeof symbol !== 'string' || symbol.length === 0) throw new Error('a stock journal needs a symbol');
}

// The one way out of this module: balanced or a throw, never an unbalanced journal.
function journal(kind: JournalKind, orderId: string | null, entries: Entry[]): Journal {
  // Only the start cash and a reversal may stand without an order (the journals table CHECK).
  if (kind !== 'start' && kind !== 'reversal' && (typeof orderId !== 'string' || orderId.length === 0)) {
    throw new Error(`a ${kind} journal needs an order id`);
  }
  const j: Journal = { kind, orderId, entries };
  if (!isBalanced(j)) throw new Error(`unbalanced ${kind} journal for order ${orderId}`);
  return j;
}

// Sign-up: the starting cash comes from capital.
export function startJournal(cash: bigint): Journal {
  positive(cash, 'start cash');
  return journal('start', null, [line('cash_free', cash), line('capital', -cash)]);
}

// A buy order is sent: its ₪ amount is locked until the order runs.
export function reserveJournal(orderId: string, amount: bigint): Journal {
  positive(amount, 'reserved amount');
  return journal('reserve', orderId, [line('cash_free', -amount), line('cash_locked', amount)]);
}

// A buy order is rejected (or cancelled): its locked cash is free again.
export function releaseJournal(orderId: string, amount: bigint): Journal {
  positive(amount, 'released amount');
  return journal('release', orderId, [line('cash_locked', -amount), line('cash_free', amount)]);
}

// A buy fills: the locked ₪ becomes stock at cost.
export function buyJournal(orderId: string, symbol: string, amount: bigint): Journal {
  positive(amount, 'buy amount');
  checkSymbol(symbol);
  return journal('buy', orderId, [line('cash_locked', -amount), stock(symbol, amount)]);
}

// A sell fills: the proceeds come in, the units' cost leaves the stock account, and the difference is
// the realized gain (− on realized_pnl) or loss (+). 0 lines are dropped. null = nothing to record
// (a dust sale worth ₪0.00 with ₪0.00 cost): the caller still updates the units.
export function sellJournal(orderId: string, symbol: string, proceeds: bigint, costReleased: bigint): Journal | null {
  if (typeof proceeds !== 'bigint' || proceeds < 0n) throw new RangeError(`proceeds must be ≥ 0, got ${proceeds}`);
  if (typeof costReleased !== 'bigint' || costReleased < 0n) throw new RangeError(`costReleased must be ≥ 0, got ${costReleased}`);
  checkSymbol(symbol);
  const entries = [
    line('cash_free', proceeds),
    stock(symbol, -costReleased),
    line('realized_pnl', -(proceeds - costReleased)),
  ].filter((e) => e.amount !== 0n);
  if (entries.length === 0) return null;
  // Three lines that sum to 0 can't have exactly one non-zero line; if they do, the math above is broken.
  if (entries.length === 1) throw new Error(`sell journal for order ${orderId} has a single non-zero line`);
  return journal('sell', orderId, entries);
}

// Fixes a mistake without editing history: the same lines with the opposite sign (the ledger is append-only).
export function reversalJournal(original: Journal): Journal {
  if (!isBalanced(original)) throw new Error('can only reverse a balanced journal');
  return journal('reversal', original.orderId, original.entries.map((e) => ({ ...e, amount: -e.amount })));
}

// Account balances after a list of journals. realizedPnl is the ACCOUNT, so −100 means a ₪100 gain.
// stockCost keeps symbols whose balance came back to 0 (a closed position), so callers compare with a 0 default.
export type Balances = {
  cashFree: bigint;
  cashLocked: bigint;
  realizedPnl: bigint;
  capital: bigint;
  stockCost: Map<string, bigint>;
};

export function ledgerBalances(journals: readonly Journal[]): Balances {
  const b: Balances = { cashFree: 0n, cashLocked: 0n, realizedPnl: 0n, capital: 0n, stockCost: new Map() };
  for (const j of journals) {
    for (const e of j.entries) {
      switch (e.account) {
        case 'cash_free': b.cashFree += e.amount; break;
        case 'cash_locked': b.cashLocked += e.amount; break;
        case 'realized_pnl': b.realizedPnl += e.amount; break;
        case 'capital': b.capital += e.amount; break;
        case 'stock_cost': {
          const symbol = e.symbol as string;
          b.stockCost.set(symbol, (b.stockCost.get(symbol) ?? 0n) + e.amount);
          break;
        }
      }
    }
  }
  return b;
}

// The stop loss (D-037), as pure functions: when a stop fires, and what each fired stop sells. Nothing here
// touches the database: the runner (triggerStops in runner.ts) loads the active stops and their positions, calls
// planStops, and writes the sell orders it asks for. The sells then run through the engine like any other sell.
//
// Checked only at the open and the close (the game trades at those two prices only: rule 3, D-012), so a dip
// during the day that recovers by the close never fires a stop, and a gap below the stop sells at the open.

export type ActiveStop = {
  id: string;                   // stop_orders.id
  uid: string;
  symbol: string;
  positionId: string;
  stopPrice: bigint;            // PRICE, in the security's currency
  units: bigint;                // UNITS the buy got
  activationPrice: bigint;      // PRICE the buy filled at
};

export type StopPosition = {
  status: 'open' | 'closed';
  units: bigint;                // UNITS
  reservedUnits: bigint;        // UNITS locked by pending sells
};

export type StopPlan =
  | { stopId: string; action: 'sell'; units: bigint }   // becomes a sell of these units at this event
  | { stopId: string; action: 'expire' }                // its position closed: nothing left to sell
  | { stopId: string; action: 'wait' };                 // every unit is locked by a pending sell: check again later

// Fires when the event's price is at or below the stop. Also when the buy itself filled at or below the stop
// (the price gapped past it before the buy ran): a real broker sells such a stop at the next price, whatever it
// is. No price for the stock at this event = nothing to compare, so it waits.
export function stopFires(stopPrice: bigint, activationPrice: bigint, eventPrice: bigint | undefined): boolean {
  if (eventPrice === undefined) return false;
  return eventPrice <= stopPrice || activationPrice <= stopPrice;
}

// What each fired stop does. A stop sells the units its buy got, at most the position's free units (units not
// locked by a pending sell): a hand sale since then leaves it less to sell. Stops on the same position share its
// free units, the highest stop first (it would have been reached first), then the oldest.
// A position that is missing or closed = the stop expires.
export function planStops(fired: readonly ActiveStop[], positions: ReadonlyMap<string, StopPosition>): StopPlan[] {
  const order = [...fired].sort((a, b) => {
    if (a.positionId !== b.positionId) return compareIds(a.positionId, b.positionId);
    if (a.stopPrice !== b.stopPrice) return a.stopPrice > b.stopPrice ? -1 : 1;
    return compareIds(a.id, b.id);
  });
  const free = new Map<string, bigint>();
  const plans: StopPlan[] = [];
  for (const s of order) {
    const p = positions.get(s.positionId);
    if (!p || p.status !== 'open') {
      plans.push({ stopId: s.id, action: 'expire' });
      continue;
    }
    const left = free.get(s.positionId) ?? p.units - p.reservedUnits;
    const units = s.units < left ? s.units : left;
    if (units <= 0n) {
      plans.push({ stopId: s.id, action: 'wait' });
      continue;
    }
    free.set(s.positionId, left - units);
    plans.push({ stopId: s.id, action: 'sell', units });
  }
  return plans;
}

// Numeric ids as strings: '9' before '10'.
function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Exact fixed-point math (api/src/game/fixed.ts). Pure, no database.
// Scales: ILS 2, UNITS 8, PRICE 4, RATE 4, AVG_COST 8, PCT 4.

import { describe, expect, it } from 'vitest';
import {
  abs, avgCost, bigMax, bigMin, costAtAvg, format, mulDiv, parse, pct, pow10, proportion, RATE_ONE, SCALE, unitsFor, valueIls,
} from '../src/game/fixed.js';

describe('parse', () => {
  it('reads the strings pg returns for NUMERIC columns', () => {
    expect(parse('131.0000', SCALE.PRICE)).toBe(1_310_000n);
    expect(parse('-4256.76', SCALE.ILS)).toBe(-425_676n);
    expect(parse('1000000', SCALE.ILS)).toBe(100_000_000n);
    expect(parse('180.18018018', SCALE.UNITS)).toBe(18_018_018_018n);
  });

  it('pads fewer decimals than the scale', () => {
    expect(parse('1.5', SCALE.PRICE)).toBe(15_000n);
    expect(parse('3.7', SCALE.RATE)).toBe(37_000n);
    expect(parse('0.1', SCALE.ILS)).toBe(10n);
  });

  it('handles zero, negative zero, small negatives and leading zeros', () => {
    expect(parse('0', SCALE.ILS)).toBe(0n);
    expect(parse('-0.00', SCALE.ILS)).toBe(0n);
    expect(parse('-0.05', SCALE.ILS)).toBe(-5n);
    expect(parse('-0.00000001', SCALE.UNITS)).toBe(-1n);
    expect(parse('007.10', SCALE.ILS)).toBe(710n);
  });

  it('is exact for numbers far beyond a float', () => {
    expect(parse('123456789012345678901234.12345678', SCALE.UNITS)).toBe(12345678901234567890123412345678n);
    expect(parse('9007199254740993.01', SCALE.ILS)).toBe(900719925474099301n);   // 2^53 + 1 is not a float
  });

  it('refuses a non-zero digit beyond the scale', () => {
    expect(() => parse('1.234', SCALE.ILS)).toThrow();
    expect(() => parse('1.2301', SCALE.ILS)).toThrow();
    expect(() => parse('1000000.0050', SCALE.ILS)).toThrow();   // a fraction of an agora
    expect(() => parse('-0.001', SCALE.ILS)).toThrow();
    expect(() => parse('1.00001', SCALE.PRICE)).toThrow();
    expect(() => parse('1.5', 0)).toThrow();
  });

  it('accepts extra decimals that are all zeros, since the number is unchanged', () => {
    expect(parse('1.230', SCALE.ILS)).toBe(123n);
    expect(parse('1.00000', SCALE.PRICE)).toBe(10_000n);
    expect(parse('1.0', 0)).toBe(1n);
    expect(parse('-4256.7600', SCALE.ILS)).toBe(-425_676n);
  });

  it('reads portfolios.cash, which is NUMERIC(16,4), at the ILS scale', () => {
    // The game migration made cash NUMERIC(16,4), and the generated available_cash and equity follow it,
    // so pg returns '1000000.0000'. It only ever holds whole agorot (D-019).
    expect(parse('1000000.0000', SCALE.ILS)).toBe(100_000_000n);
    expect(parse('954256.7600', SCALE.ILS)).toBe(95_425_676n);
  });

  it('refuses junk and empty strings', () => {
    for (const s of ['', ' ', ' 1', '1 ', '1.', '.5', '+1', '--1', '1e5', '1E5', 'abc', '1,000', '1_000', 'NaN',
      'Infinity', '0x10', '١٢', '1.2.3', '-', '-.5']) {
      expect(() => parse(s, SCALE.ILS), JSON.stringify(s)).toThrow();
    }
  });

  it('refuses a non-string and a bad scale', () => {
    expect(() => parse(12 as unknown as string, SCALE.ILS)).toThrow();
    expect(() => parse('1', -1)).toThrow();
    expect(() => parse('1', 1.5)).toThrow();
  });
});

describe('format', () => {
  it('always prints exactly `scale` decimals', () => {
    expect(format(1_310_000n, SCALE.PRICE)).toBe('131.0000');
    expect(format(100_000_000n, SCALE.ILS)).toBe('1000000.00');
    expect(format(7n, SCALE.UNITS)).toBe('0.00000007');
    expect(format(123n, 0)).toBe('123');
  });

  it('prints negatives with one sign and never -0.00', () => {
    expect(format(-5n, SCALE.ILS)).toBe('-0.05');
    expect(format(-425_676n, SCALE.ILS)).toBe('-4256.76');
    expect(format(0n, SCALE.ILS)).toBe('0.00');
    expect(format(-0n, SCALE.ILS)).toBe('0.00');
    expect(format(-1n, SCALE.UNITS)).toBe('-0.00000001');
    expect(format(-100n, SCALE.ILS)).toBe('-1.00');
  });

  it('is the inverse of parse', () => {
    for (const s of ['0.00', '-0.05', '0.05', '1000000.00', '-4256.76', '12345678901234567890.99']) {
      expect(format(parse(s, SCALE.ILS), SCALE.ILS)).toBe(s);
    }
    for (const s of ['0.00000001', '180.18018018', '-90.09009009']) {
      expect(format(parse(s, SCALE.UNITS), SCALE.UNITS)).toBe(s);
    }
    expect(format(parse('1.5', SCALE.PRICE), SCALE.PRICE)).toBe('1.5000');
  });
});

describe('mulDiv', () => {
  it("'down' truncates toward zero for every sign", () => {
    expect(mulDiv(7n, 1n, 2n, 'down')).toBe(3n);
    expect(mulDiv(-7n, 1n, 2n, 'down')).toBe(-3n);
    expect(mulDiv(7n, 1n, -2n, 'down')).toBe(-3n);
    expect(mulDiv(-7n, 1n, -2n, 'down')).toBe(3n);
    expect(mulDiv(2n, 1n, 3n, 'down')).toBe(0n);
    expect(mulDiv(-2n, 1n, 3n, 'down')).toBe(0n);
  });

  it("'half_up' rounds half away from zero, like Postgres round()", () => {
    // round(3.5) = 4, round(-3.5) = -4
    expect(mulDiv(7n, 1n, 2n, 'half_up')).toBe(4n);
    expect(mulDiv(-7n, 1n, 2n, 'half_up')).toBe(-4n);
    expect(mulDiv(7n, 1n, -2n, 'half_up')).toBe(-4n);
    expect(mulDiv(-7n, 1n, -2n, 'half_up')).toBe(4n);
    // below and above half
    expect(mulDiv(4n, 1n, 3n, 'half_up')).toBe(1n);
    expect(mulDiv(5n, 1n, 3n, 'half_up')).toBe(2n);
    expect(mulDiv(-4n, 1n, 3n, 'half_up')).toBe(-1n);
    expect(mulDiv(-5n, 1n, 3n, 'half_up')).toBe(-2n);
    expect(mulDiv(1n, 1n, 3n, 'half_up')).toBe(0n);
    expect(mulDiv(-1n, 1n, 3n, 'half_up')).toBe(0n);
    // exact results are not moved
    expect(mulDiv(6n, 1n, 3n, 'half_up')).toBe(2n);
    expect(mulDiv(-6n, 1n, 3n, 'half_up')).toBe(-2n);
    expect(mulDiv(0n, 5n, 3n, 'half_up')).toBe(0n);
  });

  it('rounds once, on the full product (no intermediate rounding)', () => {
    // 3 × 3 / 2 = 4.5 → 5; rounding 3/2 first would give 2 × 3 = 6
    expect(mulDiv(3n, 3n, 2n, 'half_up')).toBe(5n);
    expect(mulDiv(10n ** 30n, 10n ** 30n, 10n ** 40n, 'half_up')).toBe(10n ** 20n);
  });

  it('throws on division by zero', () => {
    expect(() => mulDiv(1n, 1n, 0n, 'down')).toThrow();
    expect(() => mulDiv(0n, 0n, 0n, 'half_up')).toThrow();
  });

  it('throws on an unknown rounding mode', () => {
    expect(() => mulDiv(1n, 1n, 1n, 'up' as 'down')).toThrow();
  });
});

describe('valueIls', () => {
  it('values units at a price and a rate, to the agora', () => {
    // NVDA: 180.18018018 units × $160.0000 × 3.7000 = 106,666.6666656 → 106,666.67
    expect(valueIls(18_018_018_018n, 1_600_000n, 37_000n)).toBe(10_666_667n);
    // TASE: 10 units × ₪100.0000 × 1.0000 = ₪1,000.00
    expect(valueIls(1_000_000_000n, 1_000_000n, RATE_ONE)).toBe(100_000n);
  });

  it('rounds half up at the agora', () => {
    // 0.5 units × 0.0100 = 0.005 → 0.01
    expect(valueIls(50_000_000n, 100n, RATE_ONE)).toBe(1n);
    // 0.49999999 units × 0.0100 = 0.0049999999 → 0.00
    expect(valueIls(49_999_999n, 100n, RATE_ONE)).toBe(0n);
    expect(valueIls(0n, 1_000_000n, RATE_ONE)).toBe(0n);
  });
});

describe('unitsFor', () => {
  it('turns ₪ into units, rounding the units down', () => {
    // ₪100,000.00 / ($150.0000 × 3.7000) = 180.18018018018… → 180.18018018
    expect(unitsFor(10_000_000n, 1_500_000n, 37_000n)).toBe(18_018_018_018n);
    // ₪2,000.00 / ₪300.0000 = 6.666666666… → 6.66666666 (half up would be …67)
    expect(unitsFor(200_000n, 3_000_000n, RATE_ONE)).toBe(666_666_666n);
    expect(unitsFor(100_000n, 1_000_000n, RATE_ONE)).toBe(1_000_000_000n);
  });

  it('never gives more units than were paid for', () => {
    const units = unitsFor(10_000_000n, 1_500_000n, 37_000n);
    expect(valueIls(units, 1_500_000n, 37_000n)).toBeLessThanOrEqual(10_000_000n);
  });

  it('gives 0 units for an amount below one unit-step', () => {
    // ₪0.01 at ₪2,000,000 per unit is 0.000000005 units → 0
    expect(unitsFor(1n, 20_000_000_000n, RATE_ONE)).toBe(0n);
  });

  it('throws on a zero or negative price or rate', () => {
    expect(() => unitsFor(100n, 0n, RATE_ONE)).toThrow();
    expect(() => unitsFor(100n, -1n, RATE_ONE)).toThrow();
    expect(() => unitsFor(100n, 10_000n, 0n)).toThrow();
  });
});

describe('avgCost', () => {
  it('divides cost by units into ₪ per unit at 8 decimals', () => {
    // ₪100,000.00 / 180.18018018 = 555.00000000 (rounded from 555.000000000555)
    expect(avgCost(10_000_000n, 18_018_018_018n)).toBe(55_500_000_000n);
    expect(avgCost(210_000n, 2_000_000_000n)).toBe(10_500_000_000n);   // ₪2,100 / 20 = 105
  });

  it('rounds half up', () => {
    expect(avgCost(100n, 300_000_000n)).toBe(33_333_333n);   // ₪1 / 3 = 0.333333333…
    expect(avgCost(200n, 300_000_000n)).toBe(66_666_667n);   // ₪2 / 3 = 0.666666666…
  });

  it('throws on 0 units', () => {
    expect(() => avgCost(100n, 0n)).toThrow();
  });
});

describe('pct', () => {
  it('returns percent at 4 decimals, half up', () => {
    expect(pct(5n, 100n)).toBe(50_000n);          // 5.0000 %
    expect(pct(1n, 3n)).toBe(333_333n);           // 33.3333 %
    expect(pct(2n, 3n)).toBe(666_667n);           // 66.6667 %
    expect(pct(-1n, 3n)).toBe(-333_333n);
    expect(pct(-2n, 3n)).toBe(-666_667n);
    expect(pct(5_000_000n, 105_000_000n)).toBe(47_619n);   // ₪50,000 of ₪1,050,000 = 4.7619 %
  });

  it('takes another scale when asked', () => {
    expect(pct(213n, 1000n, 1)).toBe(213n);       // 21.3 %
    expect(pct(25_000_000n, 105_000_000n, 1)).toBe(238n);   // 23.8095… → 23.8
    expect(pct(1n, 8n, 0)).toBe(13n);             // 12.5 → 13
  });

  it('throws on a zero whole', () => {
    expect(() => pct(1n, 0n)).toThrow();
  });
});

describe('costAtAvg', () => {
  it('values units at the average cost, to the agora, half up', () => {
    // 90.09009009 units × ₪555.00000000 = 49,999.99999995 → 50,000.00
    expect(costAtAvg(9_009_009_009n, 55_500_000_000n)).toBe(5_000_000n);
    // 1 unit × ₪0.33333333 = 0.33; 1 unit × ₪0.66666667 = 0.67
    expect(costAtAvg(100_000_000n, 33_333_333n)).toBe(33n);
    expect(costAtAvg(100_000_000n, 66_666_667n)).toBe(67n);
    // 6,242,323 × ₪0.02637506 = 164,641.6378… → 164,641.64
    expect(costAtAvg(624_232_300_000_000n, 2_637_506n)).toBe(16_464_164n);
    // 0.5 units × ₪0.01 = 0.005 → 0.01; 0.49999999 × ₪0.01 → 0.00
    expect(costAtAvg(50_000_000n, 1_000_000n)).toBe(1n);
    expect(costAtAvg(49_999_999n, 1_000_000n)).toBe(0n);
    expect(costAtAvg(0n, 55_500_000_000n)).toBe(0n);
  });
});

describe('proportion', () => {
  it('scales an amount by num/den with one half-up rounding', () => {
    expect(proportion(10_000_000n, 9_009_009_009n, 18_018_018_018n)).toBe(5_000_000n);
    expect(proportion(100n, 1n, 3n)).toBe(33n);
    expect(proportion(200n, 1n, 3n)).toBe(67n);
    expect(proportion(1n, 1n, 2n)).toBe(1n);
    expect(proportion(-1n, 1n, 2n)).toBe(-1n);
  });

  it('returns the whole amount for num = den', () => {
    expect(proportion(66_667n, 2n, 2n)).toBe(66_667n);
  });
});

describe('small helpers', () => {
  it('pow10, abs, bigMin, bigMax', () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(14)).toBe(100_000_000_000_000n);
    expect(abs(-3n)).toBe(3n);
    expect(abs(3n)).toBe(3n);
    expect(bigMin(2n, -5n)).toBe(-5n);
    expect(bigMax(2n, -5n)).toBe(2n);
  });
});

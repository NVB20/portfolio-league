// The sentences under each section headline, built from the data. Each says what's true now,
// including "nothing yet", and never fills a gap with a made-up number.

import type { Dashboard, HoldingView, PortfolioView, StandingView } from '../../api/src/contract';
import { ils, ilsExact, pct } from './format';

// Section 1: "You're up 2.35% since Monday, 1.15% above the median. ₪312,900 in cash and 2 orders waiting."
export function portfolioSummary(d: Dashboard): string {
  const { portfolio, holdings, pendingOrders } = d;
  if (holdings.length === 0 && pendingOrders.total === 0) {
    return `כל ${ils(portfolio.cash)} במזומן. עוד לא נשלחו פקודות: פקודה ראשונה מתחילה את התיק.`;
  }

  const parts: string[] = [];
  if (portfolio.weekReturnPct !== null) {
    const r = portfolio.weekReturnPct;
    let line = `${r >= 0 ? 'עלית' : 'ירדת'} ${pct(Math.abs(r), { signed: false })} מתחילת השבוע`;
    if (portfolio.vsMedianPct !== null) {
      const m = portfolio.vsMedianPct;
      line += `, ${pct(Math.abs(m), { signed: false })} ${m >= 0 ? 'מעל' : 'מתחת ל'}חציון השחקנים`;
    }
    parts.push(`${line}.`);
  }
  let cashLine = `${ils(portfolio.cash)} במזומן`;
  if (pendingOrders.total === 1) cashLine += ' ופקודה אחת מחכה לביצוע';
  if (pendingOrders.total > 1) cashLine += ` ו־${pendingOrders.total} פקודות מחכות לביצוע`;
  parts.push(`${cashLine}.`);
  return parts.join(' ');
}

// The portfolio card's small print: what a new buy can spend, and the cash pending buys hold, when there is any.
export function cashFigures(p: Pick<PortfolioView, 'availableCash' | 'reservedCash'>): { label: string; value: string }[] {
  const out = [{ label: 'מזומן פנוי', value: ilsExact(p.availableCash) }];
  if (p.reservedCash > 0) out.push({ label: 'שמור לפקודות ממתינות', value: ilsExact(p.reservedCash) });
  return out;
}

// Section 2 headline, second line: how many holdings are near the 20% cap.
export function nearCapLine(holdings: HoldingView[]): string {
  const near = holdings.filter((h) => h.nearCap).length;
  if (holdings.length === 0) return 'הכל במזומן.';
  if (near === 0) return 'אף אחד לא קרוב לתקרה.';
  if (near === 1) return 'אחד קרוב לתקרה.';
  return `${near} קרובים לתקרה.`;
}

export function holdingsSummary(holdings: HoldingView[]): string {
  const rule = 'נייר אחד לא יכול לעבור 20% מהתיק ברגע הקנייה.';
  const closest = holdings.filter((h) => h.nearCap).sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0))[0];
  if (closest?.weightPct != null) {
    return `${rule} ${closest.nameHe} כבר ב־${pct(closest.weightPct, { digits: 1, signed: false })}, והקנייה הבאה שלו עלולה להיחסם.`;
  }
  return rule;
}

// Section 3 headline, second line: what is holding the rank back.
export function standingLine(s: StandingView): string {
  if (s.rank === 1) return 'אתה בראש הטבלה.';
  return s.stabilityRank < s.returnRank ? 'היציבות מורידה אותך.' : 'התשואה מורידה אותך.';
}

export function standingSummary(d: Dashboard): string {
  const s = d.standing;
  if (!s) return 'הציון מחושב בסוף כל יום מסחר: 85% לפי התשואה השבועית ו־15% לפי היציבות. הטבלה מתאפסת בכל יום שני.';
  const mdd = d.portfolio.maxDrawdownPct;
  if (s.stabilityRank < s.returnRank && mdd !== null) {
    return `ירידה של ${pct(mdd, { digits: 1, signed: false })} מהשיא לשפל היא יותר מרוב השחקנים השבוע. תיק מפוזר יותר היה שומר על הדירוג.`;
  }
  return `ציון ${s.score.toFixed(1)} מתוך 100, מקום ${s.rank} מתוך ${s.players.toLocaleString('en-US')} שחקנים.`;
}

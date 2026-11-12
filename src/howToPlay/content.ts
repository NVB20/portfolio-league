// The copy of the rules page (/how-to-play, "איך משחקים" in the avatar menu), as plain data: seven sections, each a
// headline and rows of cards. No React and no colors here: src/components/howToPlay/RuleCards.tsx draws each card,
// and HowToPlayScreen lays the sections out like every other page (DD-02: a headline beside rows of cards).
//
// Each section has exactly one inverse card (DD-04): the one rule to remember. Every other card is plain text.
// The words and numbers match the walkthrough's (src/onboarding/steps.ts) and the README's rules table. The 20% cap
// and the ₪100 minimum come from the trading screen's own order check, so this page says what the preview enforces.

import { CAP, MIN_ORDER_ILS } from '../trade/orderCheck';

export type SectionId = 'money' | 'clock' | 'orders' | 'limits' | 'stop' | 'score' | 'stability';

export type RuleCard =
  | { kind: 'text'; title: string; sub: string; lines: string[] }
  // The inverse cards. `value`: a big number on top. `share`: a bar filled to that share, with a caption.
  | { kind: 'fact'; title: string; sub: string; value?: string; share?: { value: number; label: string }; lines: string[] }
  | { kind: 'weights'; title: string; sub: string; parts: { pct: number; label: string }[]; lines: string[] }
  | { kind: 'drop'; title: string; sub: string; points: { day: string; value: string; note: string }[]; result: string; lines: string[] };

export type RuleSection = {
  id: SectionId;
  chip: string;          // the jump link at the top of the page
  eyebrow: string;
  lead: string;          // the headline's first line
  accent: string;        // its second line, in the accent color
  body: string;
  rows: RuleCard[][];    // DD-03: a row is one wide card or two side by side
};

const CAP_PCT = `${Math.round(CAP * 100)}%`;
const MIN = `₪${MIN_ORDER_ILS}`;

// "10:00–17:30" inside a Hebrew line, isolated (LRI … PDI) so it reads left to right and isn't flipped to
// "17:30–10:00" (DD-08; the mock-up's <bdi>).
const hours = (from: string, to: string) => `⁦${from}–${to}⁩`;

export const SECTIONS: RuleSection[] = [
  {
    id: 'money',
    chip: 'הכסף',
    eyebrow: 'איך משחקים',
    lead: 'מיליון שקל וירטואליים,',
    accent: 'מחירים אמיתיים.',
    body: 'קונים ומוכרים מניות מתל אביב ומניו יורק, ומתחרים בכל שבוע על המקום הראשון בטבלה. כאן כל הכללים, בקצרה.',
    rows: [
      [
        {
          kind: 'fact',
          title: 'המזומן לפתיחה',
          sub: 'לכל שחקן, פעם אחת',
          value: '₪1,000,000',
          lines: ['כסף וירטואלי. המחירים אמיתיים: שלוש שנים של שערי פתיחה וסגירה מהבורסות.'],
        },
        {
          kind: 'text',
          title: 'מה אפשר לקנות',
          sub: '40 ניירות ערך בשני שווקים',
          lines: [
            '20 מניות בתל אביב, כמו טבע, אלביט ולאומי.',
            '20 מניות בניו יורק, כמו NVIDIA, Apple ו־Microsoft.',
            'אפשר לקנות גם חלק ממניה.',
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'התיק נשאר, הציון מתחיל מחדש',
          sub: 'משבוע לשבוע',
          lines: ['המזומן והמניות שלכם נשארים משבוע לשבוע ולא מתאפסים. רק הציון מתחיל מאפס, בכל יום שני.'],
        },
      ],
    ],
  },
  {
    id: 'clock',
    chip: 'השעון',
    eyebrow: 'שעון העולם',
    lead: 'כולם חיים',
    accent: 'על שעון אחד.',
    body: 'המשחק לא מחכה לשוק האמיתי. לעולם יש תאריך ושעה משלו, משותפים לכל השחקנים.',
    rows: [
      [
        {
          kind: 'fact',
          title: 'השעון יכול לקפוץ',
          sub: 'וזה משפיע על כולם',
          lines: [
            'מנהל המשחק מקדם את השעון לפתיחה או לסגירה הבאה, וכל מה שבדרך רץ לפי הסדר. כך שבוע שלם יכול לעבור בכמה דקות.',
            'כשאף אחד לא מקדם, השעון רץ בקצב אמיתי. הוא אף פעם לא חוזר אחורה.',
            'העולם מתחיל ב־27.11.2023 ונעצר ב־05.11.2026, כשנגמרים המחירים.',
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'תל אביב',
          sub: 'שעון ישראל',
          lines: [`שני עד חמישי ${hours('10:00', '17:30')}`, `שישי ${hours('10:00', '13:50')}`, 'עד ינואר 2026 הבורסה לא נסחרה בימי שישי.'],
        },
        {
          kind: 'text',
          title: 'ניו יורק',
          sub: 'שני עד שישי',
          lines: [`${hours('9:30', '16:00')} שעון ניו יורק`, `בדרך כלל ${hours('16:30', '23:00')} שעון ישראל`],
        },
      ],
      [
        {
          kind: 'text',
          title: 'חגים',
          sub: 'לכל שוק לוח משלו',
          lines: ['כל שוק סגור בחגים שלו, ויש ימים שרק אחד מהשניים פתוח. כל מניה נסחרת לפי הלוח של השוק שלה.'],
        },
      ],
    ],
  },
  {
    id: 'orders',
    chip: 'פקודות',
    eyebrow: 'פקודות',
    lead: 'קונים רק',
    accent: 'בפתיחה או בסגירה.',
    body: 'פקודה לא מתבצעת ברגע השליחה. היא מחכה לשער הקרוב של השוק שבו הנייר נסחר.',
    rows: [
      [
        {
          kind: 'text',
          title: 'שלחתם כשהשוק פתוח',
          sub: 'למשל: שליחה בשני 12:15, ביצוע בשני 17:30',
          lines: ['הפקודה מתבצעת בשער הסגירה של אותו יום.'],
        },
        {
          kind: 'text',
          title: 'שלחתם כשהשוק סגור',
          sub: 'למשל: שליחה בשני 20:40, ביצוע בשלישי 10:00',
          lines: ['הפקודה מתבצעת בשער הפתיחה של יום המסחר הבא בשוק של המניה.'],
        },
      ],
      [
        {
          kind: 'fact',
          title: 'אי אפשר לבטל',
          sub: 'פקודה שנשלחה נשארת',
          lines: [
            'היא מחכה עד שהיא מתבצעת או נדחית.',
            'בזמן שהיא מחכה, הכסף שלה (בקנייה) או היחידות שלה (במכירה) שמורים לה, ואי אפשר להשתמש בהם פעמיים.',
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'קנייה ומכירה',
          sub: `קנייה מ־${MIN}`,
          lines: [
            `קונים בסכום בשקלים, מ־${MIN}.`,
            'מוכרים ביחידות. מסך המסחר הופך סכום בשקלים ליחידות בשבילכם.',
            `מכירה של כל היחידות מותרת גם מתחת ל־${MIN}.`,
          ],
        },
        {
          kind: 'text',
          title: 'מניות מניו יורק',
          sub: 'נקנות בדולרים',
          lines: ['הסכום מומר לפי שער הדולר ברגע הביצוע: שער הפתיחה בפתיחה, שער הסגירה בסגירה.'],
        },
      ],
      [
        {
          kind: 'text',
          title: 'כשפקודה נדחית',
          sub: 'ותקבלו הודעה',
          lines: [
            'אם אין למניה מחיר באותו יום, או שהפקודה חורגת מהגבולות במחיר הביצוע, היא נדחית, והכסף או היחידות חוזרים אליכם.',
            'אפשר לשלוח עד 5 פקודות בדקה.',
          ],
        },
      ],
    ],
  },
  {
    id: 'limits',
    chip: 'גבולות',
    eyebrow: 'גבולות',
    lead: 'שלושה גבולות',
    accent: 'לכל תיק.',
    body: 'מסך המסחר בודק אותם לפני השליחה, ובזמן הביצוע הם נבדקים שוב. פקודה שחורגת נדחית, ותקבלו על כך הודעה.',
    rows: [
      [
        {
          kind: 'fact',
          title: `עד ${CAP_PCT} בנייר אחד`,
          sub: 'ברגע הקנייה',
          value: CAP_PCT,
          share: { value: CAP, label: `${CAP_PCT} משווי התיק` },
          lines: [
            `ברגע הקנייה, נייר אחד לא יכול להיות יותר מ־${CAP_PCT} משווי התיק. נספרות גם קניות אחרות שלכם באותה מניה שעוד ממתינות.`,
            `מניה שעלתה אחרי הקנייה ועברה את ה־${CAP_PCT} נשארת אצלכם: אף אחד לא מוכר בשבילכם.`,
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'בלי שורט',
          sub: 'מוכרים רק מה שיש',
          lines: ['מוכרים רק יחידות שאתם מחזיקים, ושלא שמורות כבר למכירה אחרת שממתינה.'],
        },
        {
          kind: 'text',
          title: 'בלי מינוף',
          sub: 'קונים רק במזומן',
          lines: ['קונים רק במזומן שיש לכם, ושלא שמור כבר לקנייה אחרת שממתינה.'],
        },
      ],
    ],
  },
  {
    id: 'stop',
    chip: 'סטופ לוס',
    eyebrow: 'סטופ לוס',
    lead: 'רשת ביטחון,',
    accent: 'בפתיחה ובסגירה בלבד.',
    body: 'רשות: לקנייה אפשר לצרף סטופ לוס, מחיר שאם המניה יורדת אליו, היחידות של הקנייה הזו נמכרות.',
    rows: [
      [
        {
          kind: 'fact',
          title: 'נבדק רק בפתיחה ובסגירה',
          sub: 'כמו כל פקודה במשחק',
          lines: [
            'הפתיחה או הסגירה הראשונה שבה המחיר בסטופ או מתחתיו מוכרת את היחידות שהקנייה הזו קנתה, במחיר של אותו רגע.',
            'מניה שנפתחת בפער כלפי מטה נמכרת מתחת לסטופ.',
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'קובעים פעם אחת',
          sub: 'בזמן הקנייה',
          lines: ['מחיר מתחת לסגירה האחרונה. אחרי השליחה אי אפשר לבטל או להזיז אותו.'],
        },
        {
          kind: 'text',
          title: 'מכירה ידנית מבטלת אותו',
          sub: 'הסטופ פג',
          lines: ['מכרתם את המניה בעצמכם? הסטופ לוס שלה פג ולא יופעל.'],
        },
      ],
    ],
  },
  {
    id: 'score',
    chip: 'הציון',
    eyebrow: 'הציון השבועי',
    lead: 'מנצח מי שמרוויח,',
    accent: 'ובלי ליפול בדרך.',
    body: 'התחרות רצה משני עד שישי, ובכל שבוע מתחילים מחדש. רק אחוזים קובעים, לא סכומים, כך שלתיק גדול אין יתרון.',
    rows: [
      [
        {
          kind: 'weights',
          title: 'הנוסחה',
          sub: '0.85 × דירוג תשואה + 0.15 × דירוג יציבות',
          parts: [
            { pct: 85, label: 'דירוג תשואה' },
            { pct: 15, label: 'דירוג יציבות' },
          ],
          lines: ['שני הדירוגים הם אחוזונים בין כל השחקנים בטבלה, מ־0 עד 100.'],
        },
      ],
      [
        {
          kind: 'text',
          title: 'דירוג תשואה',
          sub: '85% מהציון',
          lines: ['המקום של התשואה השבועית שלכם בין כל השחקנים. 100 הוא התשואה הגבוהה ביותר.'],
        },
        {
          kind: 'text',
          title: 'דירוג יציבות',
          sub: '15% מהציון',
          lines: ['לפי הירידה הגדולה ביותר של התיק מהשיא שלו במהלך השבוע. 100 הוא הירידה הקטנה ביותר.'],
        },
      ],
      [
        {
          kind: 'text',
          title: 'מי בטבלה',
          sub: 'מהקנייה הראשונה',
          lines: ['נכנסים לטבלה כשהקנייה הראשונה שלכם מתבצעת. מי שמחזיק רק מזומן ולא עשה דבר השבוע לא מדורג.'],
        },
        {
          kind: 'text',
          title: 'מתי היא מתעדכנת',
          sub: 'בכל פתיחה וסגירה',
          lines: [
            'השבוע נסגר בסגירה האחרונה של יום שישי, ואז הטבלה ננעלת.',
            'בציון שווה מכריע אחוז הרווח, אחר כך הירידה הקטנה יותר, ואחר כך מי שנרשם קודם.',
          ],
        },
      ],
    ],
  },
  {
    id: 'stability',
    chip: 'יציבות',
    eyebrow: 'יציבות',
    lead: 'איך משפרים',
    accent: 'את היציבות.',
    body: 'דירוג היציבות בודק כמה התיק ירד מהשיא שלו במהלך השבוע. ירידה קטנה יותר, דירוג גבוה יותר.',
    rows: [
      [
        {
          kind: 'drop',
          title: 'דוגמה: ירידה של 5%',
          sub: 'הירידה הגדולה ביותר מהשיא',
          points: [
            { day: 'שני', value: '₪1,000,000', note: 'פתיחת השבוע' },
            { day: 'רביעי', value: '₪1,050,000', note: 'השיא' },
            { day: 'חמישי', value: '₪997,500', note: 'השפל אחריו' },
          ],
          result: '−5%',
          lines: [
            'מ־₪1,050,000 ל־₪997,500 זו ירידה של 5%. גם אם התיק עולה שוב, הירידה הזו נשארת בחשבון של השבוע.',
            'הירידה נמדדת רק בפתיחות ובסגירות, כי רק אז שווי התיק משתנה.',
          ],
        },
      ],
      [
        {
          kind: 'text',
          title: 'פיזור',
          sub: 'כמה מניות, שני שווקים',
          lines: ['כמה מניות מתחומים שונים ומשני השווקים. כשאחת יורדת, האחרות לא תמיד יורדות איתה.'],
        },
        {
          kind: 'text',
          title: 'פחות במניות קופצניות',
          sub: 'סכום קטן, ירידה קטנה',
          lines: ['מניה שזזה 5% ביום מזיזה את כל התיק. כשפחות כסף יושב בה, התיק יורד פחות.'],
        },
      ],
      [
        {
          kind: 'text',
          title: 'מזומן',
          sub: 'לא יורד, גם לא מרוויח',
          lines: ['מזומן לא יורד, אבל גם לא מרוויח, והתשואה שווה 85% מהציון.'],
        },
        {
          kind: 'text',
          title: 'סטופ לוס',
          sub: 'תקרה להפסד',
          lines: ['מגביל את ההפסד במניה, אבל רק בפתיחה ובסגירה. בפער כלפי מטה הוא מוכר מתחת למחיר שקבעתם.'],
        },
      ],
    ],
  },
];

export const PAGE_FOOTER = 'המחירים אמיתיים, מהבורסות בין 2023 ל־2026. הכסף וירטואלי, והתחרות שבועית.';

// "?section=stability" → 'stability'. Anything else (missing, misspelled, an array) → null: the page opens at the top.
export function parseSection(raw: unknown): SectionId | null {
  return typeof raw === 'string' && SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : null;
}

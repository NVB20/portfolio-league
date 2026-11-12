// The copy of both walkthroughs, as plain data: six steps for a player (/onboarding) and six for an admin
// (/admin-onboarding). No React and no colors here: src/components/onboarding draws each visual from this data.
// The player's steps are phone-first, one visual + a headline per step. The admin's are two panes: the left one
// explains, the right one (the "inverse" card) shows an example of what the admin will see.

import type { OnboardingFlow } from '../types/user';

export type { OnboardingFlow };

// ---------- player ----------

export type PlayerVisual =
  | { kind: 'welcome'; eyebrow: string; cash: { label: string; amount: string; note: string }; facts: { value: string; label: string }[] }
  | {
      kind: 'clock';
      label: string;
      time: string;
      chips: { label: string; open: boolean }[];
      hours: { market: string; lines: string[] }[];
    }
  | {
      kind: 'orders';
      cases: { label: string; open: boolean; sentLabel: string; sentAt: string; doneLabel: string; doneAt: string }[];
      warning: string;
    }
  | {
      kind: 'limits';
      cap: { title: string; value: string; share: number; shareLabel: string; text: string };
      rules: { title: string; text: string }[];
    }
  | {
      kind: 'score';
      label: string;
      returns: { pct: number; label: string };
      stability: { pct: number; label: string };
      parts: { title: string; text: string }[];
    }
  | { kind: 'ready'; items: string[] };

export type PlayerStep = {
  title: string;
  body: string;
  note: string | null;
  visual: PlayerVisual;
};

export const PLAYER_UI = {
  skip: 'דילוג',
  skipLabel: 'דילוג על ההסבר',
  back: 'הקודם',
  next: 'הבא',
  start: 'בואו נתחיל',
  toTrade: 'למסך המסחר',
  toDashboard: 'קודם לסקירת התיק',
  restart: 'הצגה מהתחלה',
};

export const PLAYER_STEPS: PlayerStep[] = [
  {
    title: 'ברוכים הבאים לליגת התיקים',
    body: 'קונים ומוכרים מניות מתל אביב ומניו יורק, ומתחרים בכל שבוע על המקום הראשון בטבלה.',
    note: 'חמישה כללים, בערך דקה. אחר כך קונים.',
    visual: {
      kind: 'welcome',
      eyebrow: 'ליגת תיקים',
      cash: { label: 'המזומן שלכם לפתיחה', amount: '₪1,000,000', note: 'כסף וירטואלי. המחירים אמיתיים.' },
      facts: [
        { value: '40', label: 'ניירות ערך' },
        { value: '2', label: 'שווקים: ת״א וניו יורק' },
        { value: 'שבועית', label: 'תחרות מול כולם' },
      ],
    },
  },
  {
    title: 'כולם חיים על שעון אחד',
    body: 'המשחק לא מחכה לשוק האמיתי. לעולם יש שעון משלו, משותף לכל השחקנים. הוא מופיע בסקירת התיק, ובמסך רחב גם בסרגל העליון.',
    note: 'השעון יכול לקפוץ: מנהל המשחק מקדם אותו לפתיחה או לסגירה הבאה, וכך שבוע שלם יכול לעבור בכמה דקות.',
    visual: {
      kind: 'clock',
      label: 'שעון העולם',
      time: 'יום שני · 10:42',
      chips: [
        { label: 'ת״א פתוחה', open: true },
        { label: 'ניו יורק סגורה', open: false },
      ],
      hours: [
        { market: 'תל אביב', lines: ['שני עד חמישי 10:00–17:30', 'שישי 10:00–13:50'] },
        { market: 'ניו יורק', lines: ['שני עד שישי 16:30–23:00', 'בדרך כלל, לפי שעון ישראל'] },
      ],
    },
  },
  {
    title: 'קונים רק בפתיחה או בסגירה',
    body: 'פקודה לא מתבצעת ברגע השליחה. היא מחכה לשער הקרוב של השוק שבו הנייר נסחר.',
    note: 'קונים בסכום בשקלים, מ־₪100. מוכרים ביחידות. מניה אמריקאית נקנית בדולרים, לפי שער הדולר ברגע הביצוע.',
    visual: {
      kind: 'orders',
      cases: [
        { label: 'שלחתם כשהשוק פתוח', open: true, sentLabel: 'שליחה', sentAt: 'שני 12:15', doneLabel: 'ביצוע בשער הסגירה', doneAt: 'שני 17:30' },
        { label: 'שלחתם כשהשוק סגור', open: false, sentLabel: 'שליחה', sentAt: 'שני 20:40', doneLabel: 'ביצוע בשער הפתיחה', doneAt: 'שלישי 10:00' },
      ],
      warning: 'פקודה שנשלחה אי אפשר לבטל',
    },
  },
  {
    title: 'שלושה גבולות לכל תיק',
    body: 'מסך המסחר בודק אותם לפני השליחה. פקודה שחורגת בזמן הביצוע נדחית, ותקבלו על כך הודעה.',
    note: 'רשות: אפשר לצרף לקנייה סטופ לוס. גם הוא נבדק רק בשער הפתיחה והסגירה.',
    visual: {
      kind: 'limits',
      cap: {
        title: 'עד 20% בנייר אחד',
        value: '20%',
        share: 0.2,
        shareLabel: 'חמישית מהתיק',
        text: 'ברגע הקנייה, נייר אחד לא יכול להיות יותר מחמישית משווי התיק. הבדיקה חוזרת בזמן הביצוע, לפי מחיר הביצוע.',
      },
      rules: [
        { title: 'בלי שורט', text: 'מוכרים רק יחידות שאתם מחזיקים.' },
        { title: 'בלי מינוף', text: 'קונים רק במזומן שיש לכם.' },
      ],
    },
  },
  {
    title: 'מנצח מי שמרוויח, ובלי ליפול בדרך',
    body: 'התחרות רצה משני עד שישי, ובכל שבוע מתחילים מחדש. רק אחוזים קובעים, לא סכומים.',
    note: 'נכנסים לטבלה כשהקנייה הראשונה שלכם מתבצעת.',
    visual: {
      kind: 'score',
      label: 'הציון השבועי',
      returns: { pct: 85, label: 'דירוג תשואה' },
      stability: { pct: 15, label: 'דירוג יציבות' },
      parts: [
        { title: 'דירוג תשואה', text: 'המקום של התשואה השבועית שלכם בין כל השחקנים. 100 הוא התשואה הגבוהה ביותר.' },
        { title: 'דירוג יציבות', text: 'לפי הירידה הגדולה ביותר של התיק מהשיא שלו במהלך השבוע. 100 הוא הירידה הקטנה ביותר.' },
      ],
    },
  },
  {
    title: 'מוכנים. הקנייה הראשונה מכניסה אתכם לטבלה',
    body: 'ההסבר נפתח שוב בכל רגע: תפריט המשתמש, "איך משחקים".',
    note: null,
    visual: {
      kind: 'ready',
      items: [
        '₪1,000,000 וירטואליים לפתיחה',
        'שעון עולם אחד לכל השחקנים',
        'ביצוע בפתיחה או בסגירה, בלי ביטול',
        'עד 20% בנייר, בלי שורט ובלי מינוף',
        'ציון שבועי: 85% תשואה, 15% יציבות',
      ],
    },
  },
];

// ---------- admin ----------

// The left pane, under the headline.
export type AdminLeftBlock =
  | { type: 'lead'; text: string; size: 'large' | 'normal' | 'small' }
  | { type: 'steps'; items: { title: string | null; text: string }[] }   // numbered circles
  | { type: 'tiles'; items: string[] }                                   // numbered rows on a card
  | { type: 'cards'; items: { title: string; text: string }[] };         // two per row

// The right pane: an example of what the admin will see.
export type AdminRightBlock =
  | { type: 'marks'; title: string; tone: 'good' | 'warn'; items: string[] }   // check marks (good) or crosses (warn)
  | { type: 'divider' }
  | { type: 'heading'; text: string }
  | { type: 'caption'; text: string }
  | { type: 'note'; text: string }
  | { type: 'clockDemo'; label: string; time: string; status: string; primary: string; secondary: string }
  | { type: 'summary'; text: string }
  | { type: 'warnings'; items: { title: string; text: string }[] }
  | { type: 'statusTable'; rows: { lead: string; hint: string; live: boolean }[] }
  | { type: 'rows'; items: string[]; size: 'normal' | 'large' }
  | { type: 'infoCards'; items: { title: string; text: string }[] }
  | { type: 'replay' };

export type AdminStep = {
  title: string;
  titleSize: number;
  left: AdminLeftBlock[];
  right: AdminRightBlock[];
  rightGap: number;
  next: string;   // the primary button: "הבא: ..." (the last step: where it leads)
};

export const ADMIN_UI = {
  eyebrow: 'צד הניהול',
  skip: 'דילוג על ההסבר',
  back: 'הקודם',
  restart: 'הצגה מהתחלה',
};

export const ADMIN_STEPS: AdminStep[] = [
  {
    title: 'ברוכים הבאים לצד הניהול',
    titleSize: 38,
    left: [
      { type: 'lead', size: 'large', text: 'יש לכם תפקיד מנהל. מכאן מזיזים את שעון העולם של המשחק ורואים מה השחקנים עושים.' },
      { type: 'lead', size: 'normal', text: 'אתם גם שחקנים רגילים, עם תיק משלכם. חוזרים לצד השחקן מהסרגל העליון או מתפריט המשתמש.' },
    ],
    right: [
      {
        type: 'marks',
        title: 'מה מנהל יכול',
        tone: 'good',
        items: ['לקדם, להפעיל ולעצור את שעון העולם', 'לראות שחקנים, פעילות וחזרה למשחק', 'לעקוב אחרי השימוש באפליקציה ובריאות מסד הנתונים'],
      },
      { type: 'divider' },
      {
        type: 'marks',
        title: 'מה גם מנהל לא יכול',
        tone: 'warn',
        items: ['לשנות מזומן, אחזקות, מחירים או ציונים.', 'להחזיר את השעון אחורה', 'לתת תפקיד מנהל. תפקידים משתנים רק ב־SQL'],
      },
    ],
    rightGap: 24,
    next: 'הבא: שעון העולם',
  },
  {
    title: 'שעון העולם זז בשלוש דרכים',
    titleSize: 32,
    left: [
      {
        type: 'steps',
        items: [
          { title: 'קדם לסגירה', text: 'כששוק פתוח: קפיצה לסגירה הבאה שלו. תל אביב 17:30 (שישי 13:50), ניו יורק 23:00 שעון ישראל.' },
          { title: 'קדם לפתיחה הבאה', text: 'כששני השווקים סגורים: קפיצה לפתיחה הבאה. סופי שבוע וימים ששני השווקים סגורים בהם נדלגים.' },
          { title: 'הפעלה ועצירה', text: 'שעון מופעל רץ בזמן אמת מהנקודה שבה נעצר, גם כשאף מנהל לא מחובר. שעון עצור לא זז עד שמקדמים או מפעילים אותו.' },
        ],
      },
    ],
    right: [
      { type: 'caption', text: 'כך זה נראה בלוח הניהול' },
      { type: 'clockDemo', label: 'שעון העולם', time: 'יום שני · 10:42', status: 'תל אביב פתוחה.', primary: 'קדם לסגירה', secondary: 'עצור את השעון' },
      { type: 'note', text: 'כפתור הקידום הוא אחד, והתווית שלו משתנה: כששוק פתוח הוא "קדם לסגירה", ובכל מצב אחר "קדם לפתיחה הבאה".' },
    ],
    rightGap: 16,
    next: 'הבא: מה קידום מריץ',
  },
  {
    title: 'קידום מריץ את כל מה שבדרך',
    titleSize: 32,
    left: [
      { type: 'lead', size: 'normal', text: 'השעון לא מדלג על אירועים. בכל פתיחה וסגירה שבדרך, לפי סדר הזמן:' },
      {
        type: 'tiles',
        items: [
          'סטופ לוס שהמחיר הגיע אליו הופך למכירה',
          'פקודות שהגיע זמנן מתבצעות או נדחות',
          'שווי התיק מתעדכן אצל השחקנים שהאירוע נוגע להם',
          'הטבלה והציונים נכתבים מחדש. באירוע האחרון של השבוע הטבלה השבועית ננעלת',
        ],
      },
    ],
    right: [
      { type: 'caption', text: 'אחרי כל קידום מופיעה שורת סיכום. לדוגמה:' },
      { type: 'summary', text: 'קודם לסגירה: 27.11.2023 17:30. 1 אירוע רץ: 14 פקודות בוצעו, 2 נדחו.' },
      { type: 'divider' },
      {
        type: 'warnings',
        items: [
          { title: 'אין דרך חזרה', text: 'השעון לא חוזר לפני פתיחה או סגירה שכבר רצה, ופקודות שבוצעו נשארות מבוצעות.' },
          { title: 'למשחק יש סוף', text: 'השעון נעצר ב־05.11.2026 בשעה 09:59, כשנגמרים המחירים. קידום מעבר לזה נדחה.' },
        ],
      },
    ],
    rightGap: 16,
    next: 'הבא: לוח הניהול',
  },
  {
    title: 'לוח הניהול: מי משחק',
    titleSize: 32,
    left: [
      {
        type: 'cards',
        items: [
          { title: 'הרשמות', text: 'כמה נרשמו היום, כמה מחזיקים ניירות וכמה רק במזומן.' },
          { title: 'מגמה', text: 'שחקנים פעילים בכל יום, וכמה חזרו אחרי יום ואחרי שבוע.' },
          { title: 'כל השחקנים', text: 'המקום בטבלה, ומתי כל שחקן נראה לאחרונה.' },
          { title: 'יומן פעולות ניהול', text: 'כל הזזת שעון נרשמת, עם מי שעשה אותה ומתי.' },
        ],
      },
      { type: 'lead', size: 'small', text: 'הלוח מציג בלבד. חוץ מהשעון, אין בו פעולה שמשנה משהו אצל שחקן.' },
    ],
    right: [
      { type: 'caption', text: 'איך קוראים "נראה לאחרונה" (דוגמה)' },
      {
        type: 'statusTable',
        rows: [
          { lead: 'מחובר', hint: 'האפליקציה פתוחה בשתי הדקות האחרונות', live: true },
          { lead: 'לפני 12 דק׳', hint: 'בשעה האחרונה', live: false },
          { lead: 'היום 14:02', hint: 'מוקדם יותר היום', live: false },
          { lead: 'אף פעם', hint: 'נרשם ולא פתח את המשחק', live: false },
        ],
      },
      { type: 'caption', text: 'שורות ביומן הפעולות (דוגמה)' },
      { type: 'rows', size: 'normal', items: ['קידם לסגירה · 14 פקודות בוצעו', 'הפעיל את השעון'] },
    ],
    rightGap: 14,
    next: 'הבא: ניטור',
  },
  {
    title: 'ניטור: איך משתמשים במשחק',
    titleSize: 32,
    left: [
      {
        type: 'cards',
        items: [
          { title: 'פקודות', text: 'כמה נשלחו, וכמה חזרו בהם בחלון האישור.' },
          { title: 'עמודים', text: 'זמן, צפיות ושחקנים לכל עמוד, לפי יום או שבוע.' },
          { title: 'סטופ לוס', text: 'כמה שחקנים השתמשו, כמה הופעלו ומה יצא מהם.' },
          { title: 'מסד הנתונים', text: 'כרטיס בריאות חי, מתרענן כל 30 שניות.' },
        ],
      },
      { type: 'lead', size: 'small', text: 'נתוני השימוש מגיעים מהאפליקציה פעם בדקה ונשמרים כסיכום יומי, כך שהם מתעדכנים באיחור קצר.' },
    ],
    right: [
      { type: 'heading', text: 'משהו נראה לא בסדר? איפה מסתכלים' },
      {
        type: 'infoCards',
        items: [
          { title: 'פקודות לא מתבצעות', text: 'לוח ניהול: האם השעון רץ או עצור, ומה כתוב בשורת הסיכום של הקידום האחרון.' },
          { title: 'שחקנים מתחילים לקנות ולא מסיימים', text: 'ניטור: כרטיס הפקודות, החוזרים בהם בחלון האישור.' },
          { title: 'המשחק איטי', text: 'ניטור: כרטיס מסד הנתונים.' },
        ],
      },
    ],
    rightGap: 14,
    next: 'הבא: סיבוב ראשון',
  },
  {
    title: 'סיבוב ראשון: שבוע משחק בכמה דקות',
    titleSize: 32,
    left: [
      {
        type: 'steps',
        items: [
          { title: null, text: 'עברו לצד השחקן וקנו נייר אחד במסך המסחר.' },
          { title: null, text: 'חזרו לצד הניהול ולחצו על כפתור הקידום. הפקודה מתבצעת בפתיחה או בסגירה הבאה של השוק שלה.' },
          { title: null, text: 'בצד השחקן, פתחו את "יומן" וראו שהפקודה בוצעה.' },
          { title: null, text: 'המשיכו לקדם עד הסגירה האחרונה של יום שישי. שם השבוע ננעל, והטבלה השבועית נכתבת.' },
        ],
      },
    ],
    right: [
      { type: 'heading', text: 'שלושה דברים לזכור' },
      {
        type: 'rows',
        size: 'large',
        items: ['קידום משפיע על כל השחקנים, לא רק עליכם.', 'אין ביטול ואין חזרה אחורה.', 'שעון עצור לא זז. לפני שעוזבים, כדאי להפעיל אותו.'],
      },
      { type: 'note', text: 'ההסבר נפתח שוב בכל רגע: תפריט המשתמש, "איך מנהלים".' },
      { type: 'replay' },
    ],
    rightGap: 16,
    next: 'ללוח הניהול',
  },
];

// ---------- both ----------

export function stepCount(flow: OnboardingFlow): number {
  return flow === 'admin' ? ADMIN_STEPS.length : PLAYER_STEPS.length;
}

// "2 מתוך 6"
export function stepOf(n: number, total: number): string {
  return `${n} מתוך ${total}`;
}

// "שלב 2 מתוך 6": the spoken text of the player's progress bar.
export function stepLabel(n: number, total: number): string {
  return `שלב ${stepOf(n, total)}`;
}

// Where each button of the LAST step leads when the walkthrough ends. "Skip" does not leave: it jumps to the last step.
export const AFTER = {
  player: { primary: '/trade', secondary: '/dashboard' },
  admin: { primary: '/admin-dashboard' },
} as const;

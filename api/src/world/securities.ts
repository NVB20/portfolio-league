// The 40 securities of the game world (D-011): 20 large TASE stocks and 20 large US stocks.
// Copied into the `securities` table by `npm run seed:world`. The prices come from the local
// price database (D-002), which stores them under `yahoo`.

export type WorldSecurity = {
  symbol: string;                              // the game ticker shown in the app
  yahoo: string;                               // the Yahoo Finance symbol (price DB key + chart source)
  nameHe: string;
  nameEn: string;
  market: 'TASE' | 'US';
  exchange: 'TASE' | 'NASDAQ' | 'NYSE';
};

const tase = (symbol: string, nameHe: string, nameEn: string): WorldSecurity => ({
  symbol, yahoo: `${symbol}.TA`, nameHe, nameEn, market: 'TASE', exchange: 'TASE',
});
const us = (symbol: string, exchange: 'NASDAQ' | 'NYSE', nameHe: string, nameEn: string): WorldSecurity => ({
  symbol, yahoo: symbol, nameHe, nameEn, market: 'US', exchange,
});

export const WORLD_SECURITIES: WorldSecurity[] = [
  tase('TEVA', 'טבע', 'Teva'),
  tase('ESLT', 'אלביט מערכות', 'Elbit Systems'),
  tase('LUMI', 'לאומי', 'Bank Leumi'),
  tase('POLI', 'הפועלים', 'Bank Hapoalim'),
  tase('DSCT', 'דיסקונט', 'Israel Discount Bank'),
  tase('MZTF', 'מזרחי טפחות', 'Mizrahi Tefahot'),
  tase('FIBI', 'הבינלאומי', 'First International Bank'),
  tase('NICE', 'נייס', 'NICE'),
  tase('ICL', 'כי״ל', 'ICL Group'),
  tase('BEZQ', 'בזק', 'Bezeq'),
  tase('AZRG', 'עזריאלי', 'Azrieli Group'),
  tase('TSEM', 'טאואר', 'Tower Semiconductor'),
  tase('NVMI', 'נובה', 'Nova'),
  tase('CAMT', 'קמטק', 'Camtek'),
  tase('ENLT', 'אנלייט', 'Enlight Renewable Energy'),
  tase('NWMD', 'ניו-מד אנרג׳י', 'NewMed Energy'),
  tase('DLEKG', 'קבוצת דלק', 'Delek Group'),
  tase('PHOE', 'הפניקס', 'Phoenix Holdings'),
  tase('HARL', 'הראל', 'Harel Insurance'),
  tase('CLIS', 'כלל ביטוח', 'Clal Insurance'),

  us('NVDA', 'NASDAQ', 'אנבידיה', 'NVIDIA'),
  us('AAPL', 'NASDAQ', 'אפל', 'Apple'),
  us('MSFT', 'NASDAQ', 'מיקרוסופט', 'Microsoft'),
  us('AMZN', 'NASDAQ', 'אמזון', 'Amazon'),
  us('GOOGL', 'NASDAQ', 'אלפבית', 'Alphabet'),
  us('META', 'NASDAQ', 'מטא', 'Meta Platforms'),
  us('AVGO', 'NASDAQ', 'ברודקום', 'Broadcom'),
  us('TSLA', 'NASDAQ', 'טסלה', 'Tesla'),
  us('NFLX', 'NASDAQ', 'נטפליקס', 'Netflix'),
  us('COST', 'NASDAQ', 'קוסטקו', 'Costco'),
  us('PLTR', 'NASDAQ', 'פלנטיר', 'Palantir'),
  us('WMT', 'NASDAQ', 'וולמארט', 'Walmart'),
  us('BRK-B', 'NYSE', 'ברקשייר האתוויי', 'Berkshire Hathaway'),
  us('JPM', 'NYSE', 'ג׳יי.פי מורגן', 'JPMorgan Chase'),
  us('V', 'NYSE', 'ויזה', 'Visa'),
  us('MA', 'NYSE', 'מאסטרקארד', 'Mastercard'),
  us('LLY', 'NYSE', 'אלי לילי', 'Eli Lilly'),
  us('JNJ', 'NYSE', 'ג׳ונסון אנד ג׳ונסון', 'Johnson & Johnson'),
  us('ORCL', 'NYSE', 'אורקל', 'Oracle'),
  us('XOM', 'NYSE', 'אקסון מוביל', 'Exxon Mobil'),
];

// The Yahoo symbol of the USD/ILS rate in the price database.
export const USD_ILS_YAHOO = 'ILS=X';

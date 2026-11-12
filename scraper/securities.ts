// What the scraper fetches. Symbols are Yahoo Finance symbols.
// TASE symbols end in ".TA". "ILS=X" is Yahoo's USD/ILS exchange rate.
// The lists are roughly the largest companies by market cap. Edit freely; re-run the scraper.

export type Market = 'TASE' | 'US' | 'FX';

export type Security = {
  symbol: string;
  name: string;
  market: Market;
};

export const SECURITIES: Security[] = [
  { symbol: 'ILS=X', name: 'USD/ILS', market: 'FX' },

  // Tel Aviv Stock Exchange (prices come in agorot, currency "ILA")
  { symbol: 'LUMI.TA', name: 'Bank Leumi', market: 'TASE' },
  { symbol: 'POLI.TA', name: 'Bank Hapoalim', market: 'TASE' },
  { symbol: 'TEVA.TA', name: 'Teva', market: 'TASE' },
  { symbol: 'ESLT.TA', name: 'Elbit Systems', market: 'TASE' },
  { symbol: 'DSCT.TA', name: 'Israel Discount Bank', market: 'TASE' },
  { symbol: 'MZTF.TA', name: 'Mizrahi Tefahot', market: 'TASE' },
  { symbol: 'NICE.TA', name: 'NICE', market: 'TASE' },
  { symbol: 'NVMI.TA', name: 'Nova', market: 'TASE' },
  { symbol: 'TSEM.TA', name: 'Tower Semiconductor', market: 'TASE' },
  { symbol: 'ICL.TA', name: 'ICL Group', market: 'TASE' },
  { symbol: 'FIBI.TA', name: 'First International Bank', market: 'TASE' },
  { symbol: 'PHOE.TA', name: 'Phoenix Holdings', market: 'TASE' },
  { symbol: 'AZRG.TA', name: 'Azrieli Group', market: 'TASE' },
  { symbol: 'BEZQ.TA', name: 'Bezeq', market: 'TASE' },
  { symbol: 'HARL.TA', name: 'Harel Insurance', market: 'TASE' },
  { symbol: 'ENLT.TA', name: 'Enlight Renewable Energy', market: 'TASE' },
  { symbol: 'NWMD.TA', name: 'NewMed Energy', market: 'TASE' },
  { symbol: 'CAMT.TA', name: 'Camtek', market: 'TASE' },
  { symbol: 'CLIS.TA', name: 'Clal Insurance', market: 'TASE' },
  { symbol: 'DLEKG.TA', name: 'Delek Group', market: 'TASE' },

  // US (NYSE + NASDAQ, prices in USD)
  { symbol: 'NVDA', name: 'NVIDIA', market: 'US' },
  { symbol: 'MSFT', name: 'Microsoft', market: 'US' },
  { symbol: 'AAPL', name: 'Apple', market: 'US' },
  { symbol: 'GOOGL', name: 'Alphabet', market: 'US' },
  { symbol: 'AMZN', name: 'Amazon', market: 'US' },
  { symbol: 'META', name: 'Meta Platforms', market: 'US' },
  { symbol: 'AVGO', name: 'Broadcom', market: 'US' },
  { symbol: 'TSLA', name: 'Tesla', market: 'US' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway', market: 'US' },
  { symbol: 'JPM', name: 'JPMorgan Chase', market: 'US' },
  { symbol: 'LLY', name: 'Eli Lilly', market: 'US' },
  { symbol: 'WMT', name: 'Walmart', market: 'US' },
  { symbol: 'V', name: 'Visa', market: 'US' },
  { symbol: 'ORCL', name: 'Oracle', market: 'US' },
  { symbol: 'MA', name: 'Mastercard', market: 'US' },
  { symbol: 'XOM', name: 'Exxon Mobil', market: 'US' },
  { symbol: 'NFLX', name: 'Netflix', market: 'US' },
  { symbol: 'COST', name: 'Costco', market: 'US' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', market: 'US' },
  { symbol: 'PLTR', name: 'Palantir', market: 'US' },
];

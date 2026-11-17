import type { AssetGroup, Instrument, Timeframe } from "./types";

// Every instrument here is available from a source that works from a cloud server: ETFs and FX from
// Twelve Data (free plan: US stocks/ETFs, forex, crypto), DXY computed from FX, the 10-year yield
// from FRED and Bitcoin from Kraken. Index and commodity futures are not on free plans, so ETFs
// that track them stand in, and their names say so. See lib/prices.ts.
export const INSTRUMENTS: Instrument[] = [
  { symbol: "US10Y", name: "US 10-Year Yield (FRED, daily)", group: "Rates", decimals: 2, unit: "%" },
  { symbol: "DXY", name: "US Dollar Index (from FX rates)", group: "FX", decimals: 2 },
  { symbol: "SPY", name: "S&P 500 ETF", group: "Indices", decimals: 2 },
  { symbol: "GLD", name: "Gold ETF", group: "Commodities", decimals: 2 },
  { symbol: "BTC/USD", name: "Bitcoin (Kraken)", group: "Crypto", decimals: 0 },
  { symbol: "USO", name: "US Oil Fund (WTI)", group: "Commodities", decimals: 2 },
  { symbol: "EUR/USD", name: "Euro / US Dollar", group: "FX", decimals: 4 },
  { symbol: "USD/JPY", name: "US Dollar / Yen", group: "FX", decimals: 2 },
  { symbol: "GBP/USD", name: "Sterling / US Dollar", group: "FX", decimals: 4 },
  { symbol: "USD/IDR", name: "US Dollar / Rupiah", group: "FX", decimals: 0 },
  { symbol: "SLV", name: "Silver ETF", group: "Commodities", decimals: 2 },
  { symbol: "CPER", name: "Copper ETF", group: "Commodities", decimals: 2 },
  { symbol: "QQQ", name: "Nasdaq-100 ETF", group: "Indices", decimals: 2 },
  { symbol: "EWJ", name: "Japan equities ETF (MSCI)", group: "Indices", decimals: 2 },
  { symbol: "EWG", name: "Germany equities ETF (MSCI)", group: "Indices", decimals: 2 },
];

export const TAPE_SYMBOLS = ["US10Y", "DXY", "SPY", "GLD", "BTC/USD", "USO"];

export const CHART_GROUPS: { group: AssetGroup; label: string }[] = [
  { group: "FX", label: "FX" },
  { group: "Commodities", label: "CMDTY" },
  { group: "Indices", label: "EQUITY" },
  { group: "Rates", label: "RATES" },
  { group: "Crypto", label: "CRYPTO" },
];

export const TIMEFRAMES: Timeframe[] = ["1H", "4H", "1D", "1W"];

const bySymbol = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): Instrument {
  return bySymbol.get(symbol) ?? INSTRUMENTS[0];
}

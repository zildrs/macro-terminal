import type { AssetGroup, Instrument, Timeframe } from "./types";

// Prices and candles for these come from Yahoo Finance (lib/yahoo.ts).
export const INSTRUMENTS: Instrument[] = [
  { symbol: "US10Y", name: "US 10-Year Yield", group: "Rates", decimals: 3, unit: "%" },
  { symbol: "DXY", name: "US Dollar Index", group: "FX", decimals: 2 },
  { symbol: "SPX", name: "S&P 500", group: "Indices", decimals: 2 },
  { symbol: "GOLD", name: "Gold Futures (COMEX)", group: "Commodities", decimals: 1 },
  { symbol: "BTC/USD", name: "Bitcoin", group: "Crypto", decimals: 0 },
  { symbol: "WTI", name: "WTI Crude Oil", group: "Commodities", decimals: 2 },
  { symbol: "EUR/USD", name: "Euro / US Dollar", group: "FX", decimals: 4 },
  { symbol: "USD/JPY", name: "US Dollar / Yen", group: "FX", decimals: 2 },
  { symbol: "GBP/USD", name: "Sterling / US Dollar", group: "FX", decimals: 4 },
  { symbol: "USD/IDR", name: "US Dollar / Rupiah", group: "FX", decimals: 0 },
  { symbol: "SILVER", name: "Silver Futures (COMEX)", group: "Commodities", decimals: 2 },
  { symbol: "COPPER", name: "Copper Futures", group: "Commodities", decimals: 3 },
  { symbol: "ES", name: "E-mini S&P 500 Fut", group: "Indices", decimals: 2 },
  { symbol: "NQ", name: "E-mini Nasdaq 100 Fut", group: "Indices", decimals: 2 },
  { symbol: "NKY", name: "Nikkei 225", group: "Indices", decimals: 0 },
  { symbol: "DAX", name: "DAX 40", group: "Indices", decimals: 0 },
];

export const TAPE_SYMBOLS = ["US10Y", "DXY", "SPX", "GOLD", "BTC/USD", "WTI"];

export const CHART_GROUPS: { group: AssetGroup; label: string }[] = [
  { group: "FX", label: "FX" },
  { group: "Commodities", label: "CMDTY" },
  { group: "Indices", label: "INDEX" },
  { group: "Rates", label: "RATES" },
  { group: "Crypto", label: "CRYPTO" },
];

export const TIMEFRAMES: Timeframe[] = ["1H", "4H", "1D", "1W"];

const bySymbol = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): Instrument {
  return bySymbol.get(symbol) ?? INSTRUMENTS[0];
}

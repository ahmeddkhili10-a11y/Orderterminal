// Rand per dollar, live from Yahoo Finance (kept for half an hour). NaN until it arrives.
import { useEffect, useState } from 'react';
import { fetchJson } from '../exchanges/ws';
import { yahooChart } from '../shared/yahoo';

let zarCache: { rate: number; at: number } | null = null;

export function useZarRate() {
  const [rate, setRate] = useState(zarCache?.rate ?? NaN);
  useEffect(() => {
    if (zarCache && Date.now() - zarCache.at < 30 * 60_000) return;
    yahooChart(fetchJson, 'ZAR=X', '1d')
      .then((c) => {
        if (!(c.quote.price > 0)) return;
        zarCache = { rate: c.quote.price, at: Date.now() };
        setRate(c.quote.price);
      })
      .catch(() => undefined);
  }, []);
  return rate;
}

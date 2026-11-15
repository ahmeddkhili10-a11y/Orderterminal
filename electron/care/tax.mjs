// The tax export: a year's live trades as a spreadsheet (CSV), with every
// profit, loss and fee also in rands — converted at the dollar's rate on the
// day each trade closed — and a summary at the end.
//
// South Africa's tax year runs from 1 March to the end of February; the
// "2026 tax year" is 1 March 2025 to 28 February 2026. Dates are in South
// African time (UTC+2). Paper trades are not real and are left out.
//
// This is a record for you and your tax practitioner, not tax advice: SARS can
// treat crypto trading as income or as capital, depending on how you trade.
import { isUsdLike } from './journal.mjs';

const SAST = 2 * 3_600_000;
const DAY = 86_400_000;

/** the South African tax year a moment falls in (named by the year it ends) */
export function taxYearOf(t) {
  const d = new Date(t + SAST);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 2 ? y + 1 : y;
}

/** [from, to) of a tax year, in milliseconds */
export function taxYearRange(year) {
  return [Date.UTC(year - 1, 2, 1) - SAST, Date.UTC(year, 2, 1) - SAST];
}

/** the day in South African time, as YYYY-MM-DD */
export const dayKey = (t) => new Date(t + SAST).toISOString().slice(0, 10);
const stamp = (t) => (Number.isFinite(t) ? new Date(t + SAST).toISOString().slice(0, 16).replace('T', ' ') : '');

/**
 * The dollar's rate in rands on a day, from a map of daily closes: the day
 * itself, or the last trading day before it (weekends and holidays).
 */
export function rateOn(rates, t) {
  for (let i = 0; i < 10; i++) {
    const r = rates[dayKey(t - i * DAY)];
    if (r > 0) return r;
  }
  return null;
}

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e8) / 1e8) : '') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (xs) => xs.map(cell).join(',');
const money = (x) => Math.round(x * 100) / 100;

const SOURCE = { swarm: 'Crypto swarm', lab: 'Deployed strategy', bot: 'Order-flow bot', lane: 'Luno lane' };

/**
 * The CSV for one tax year.
 * @param rows journal rows (any; the year's live ones are taken)
 * @param rates { 'YYYY-MM-DD': rands per dollar }
 * @returns {{ csv: string, trades: number, missingRates: number, totals: { gainsZar: number, lossesZar: number, feesZar: number, netZar: number } }}
 */
export function taxCsv(rows, rates, year) {
  const [from, to] = taxYearRange(year);
  const mine = rows.filter((r) => r.mode === 'live' && r.closed >= from && r.closed < to).sort((a, b) => a.closed - b.closed);
  const head = ['Tax year', 'Closed (SA time)', 'Opened (SA time)', 'Source', 'Strategy or bot', 'Exchange', 'Market', 'Side', 'Quantity', 'Entry price', 'Exit price', 'Currency', 'Fees', 'Profit or loss', 'Rand per unit of currency', 'Fees (ZAR)', 'Profit or loss (ZAR)', 'Why it was taken', 'How it closed', 'Your note'];
  const out = [line(head)];
  let gains = 0;
  let losses = 0;
  let fees = 0;
  let missing = 0;
  const bySource = {};
  for (const r of mine) {
    const q = String(r.quote ?? 'USD').toUpperCase();
    const fx = q === 'ZAR' ? 1 : isUsdLike(q) ? rateOn(rates, r.closed) : null;
    if (fx === null) missing++;
    const pnlZ = fx === null ? null : r.pnl * fx;
    const feeZ = fx === null ? null : (r.fees ?? 0) * fx;
    if (pnlZ !== null) {
      if (pnlZ >= 0) gains += pnlZ;
      else losses += -pnlZ;
      fees += feeZ;
      const s = (bySource[r.source] ??= { n: 0, net: 0 });
      s.n++;
      s.net += pnlZ;
    }
    out.push(line([`${year - 1}/${String(year).slice(2)}`, stamp(r.closed), stamp(r.opened), SOURCE[r.source] ?? r.source, r.who, r.venue, r.symbol, r.side === 'buy' ? 'long' : 'short', r.qty, r.entry, r.exit, q, money(r.fees ?? 0), money(r.pnl ?? 0), fx === null ? '' : Math.round(fx * 10000) / 10000, feeZ === null ? '' : money(feeZ), pnlZ === null ? '' : money(pnlZ), r.why, r.reason, r.note]));
  }
  const net = gains - losses;
  out.push('');
  out.push(line(['Summary', `${year - 1}/${String(year).slice(2)} tax year — 1 March ${year - 1} to ${year % 4 === 0 ? 29 : 28} February ${year}`]));
  out.push(line(['Live trades', mine.length]));
  out.push(line(['Profits (ZAR)', money(gains)]));
  out.push(line(['Losses (ZAR)', money(-losses)]));
  out.push(line(['Net profit or loss after fees (ZAR)', money(net)]));
  out.push(line(['Fees paid (ZAR, already in the profit and loss)', money(fees)]));
  for (const [s, v] of Object.entries(bySource)) out.push(line([`  ${SOURCE[s] ?? s}`, `${v.n} trades`, money(v.net)]));
  if (missing) out.push(line(['Trades without a rand rate', missing, 'their rand columns are empty: fill in the rate for the day they closed']));
  out.push(line(['Note', 'Rand amounts use the US dollar rate on the day each trade closed (USDT and USDC count as dollars). Profit and loss is after fees. Not tax advice: SARS can treat crypto trading as income or as capital — show this to a tax practitioner.']));
  return { csv: `﻿${out.join('\r\n')}\r\n`, trades: mine.length, missingRates: missing, totals: { gainsZar: money(gains), lossesZar: money(losses), feesZar: money(fees), netZar: money(net) } };
}

/** every trade (paper too) as a plain journal spreadsheet */
export function journalCsv(rows) {
  const head = ['Closed', 'Opened', 'Mode', 'Source', 'Strategy or bot', 'Exchange', 'Market', 'Side', 'Quantity', 'Entry', 'Exit', 'Currency', 'Fees', 'Profit or loss', 'R', 'Why it was taken', 'How it closed', 'Your note'];
  const out = [line(head)];
  for (const r of rows) out.push(line([stamp(r.closed), stamp(r.opened), r.mode, SOURCE[r.source] ?? r.source, r.who, r.venue, r.symbol, r.side === 'buy' ? 'long' : 'short', r.qty, r.entry, r.exit, r.quote, money(r.fees ?? 0), money(r.pnl ?? 0), r.r === null ? '' : Math.round(r.r * 100) / 100, r.why, r.reason, r.note]));
  return `﻿${out.join('\r\n')}\r\n`;
}

/** daily closes of the dollar in rands from Yahoo Finance's ZAR=X chart */
export function ratesFromChart(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators?.quote?.[0]?.close ?? [];
  const out = {};
  ts.forEach((t, i) => {
    if (close[i] > 0) out[dayKey(t * 1000)] = close[i];
  });
  return out;
}

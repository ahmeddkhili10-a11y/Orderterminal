// The look of every Telegram message Novus Ordo sends: a headline, short labelled sections,
// numbers lined up in a small table, and the fine print folded away at the end. One design for
// every message, so each reads the same way: what happened, the numbers, what it means, what to do.
//
// Helpers that take HTML (head, section, bullets, card) do not escape: callers escape what they
// put in. The table escapes its own plain-text cells.
import { escapeHtml } from './telegram';

export const esc = escapeHtml;
export type Row = readonly [label: string, value: string];

/** the headline: an icon, the title in bold, and an optional second line */
export function head(icon: string, title: string, sub?: string | null): string {
  return `${icon} <b>${title}</b>${sub ? `\n${sub}` : ''}`;
}

/** a section: its bold heading and its lines */
export function section(title: string, body: string | (string | null | undefined | false)[]): string {
  const lines = (Array.isArray(body) ? body : [body]).filter((x): x is string => !!x);
  return lines.length ? `<b>${title}</b>\n${lines.join('\n')}` : '';
}

/** a few points, one a line */
export const bullets = (xs: (string | null | undefined | false)[]) => xs.filter((x): x is string => !!x).map((x) => `• ${x}`);

/**
 * Numbers lined up in a monospaced block (phones fit about 32 characters a line, so labels are
 * kept short). Columns: a label and one value, or a label and several values (a comparison).
 */
export function table(rows: readonly (readonly string[])[], o: { header?: readonly string[] } = {}): string {
  const all = o.header ? [o.header, ...rows] : rows;
  if (!all.length) return '';
  const cols = Math.max(...all.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r) => (r[c] ?? '').length)));
  const line = (r: readonly string[]) =>
    r
      .map((cell, c) => (c === 0 ? cell.padEnd(width[c]) : cell.padStart(width[c])))
      .join('  ')
      .trimEnd();
  return `<pre>${all.map((r) => esc(line(r))).join('\n')}</pre>`;
}

/** a quiet line in italics */
export const note = (html: string) => `<i>${html}</i>`;

/** the fine print, folded away (the reader opens it with a tap) */
export const fine = (html: string) => `<blockquote expandable>${html}</blockquote>`;

/** the parts of a message, a blank line between each (empty parts are left out) */
export function card(parts: (string | null | undefined | false)[]): string {
  return parts.filter((x): x is string => !!x && !!x.trim()).join('\n\n');
}

// ---------- numbers, the same way in every message ----------

const ok = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
export const pct = (x: number | null | undefined, d = 1) => (ok(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%` : '—');
export const pctAbs = (x: number | null | undefined, d = 1) => (ok(x) ? `${Math.abs(x * 100).toFixed(d)}%` : '—');
export const drop = (x: number | null | undefined, d = 1) => (ok(x) ? `−${Math.abs(x * 100).toFixed(d)}%` : '—');
export const num = (x: number | null | undefined, d = 2) => (ok(x) ? x.toFixed(d) : '—');
const money = (v: number) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd = (v: number | null | undefined) => `${(v ?? 0) < 0 ? '−' : ''}$${money(v ?? 0)}`;
export const signedUsd = (v: number | null | undefined) => `${(v ?? 0) >= 0 ? '+' : '−'}$${money(v ?? 0)}`;
export const signedR = (v: number | null | undefined) => `${(v ?? 0) >= 0 ? '+' : '−'}${Math.abs(v ?? 0).toFixed(2)}R`;
export const date = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayName = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

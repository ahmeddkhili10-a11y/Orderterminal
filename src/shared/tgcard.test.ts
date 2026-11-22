// The look of the Telegram messages: tables that line up, sections, and long messages split so
// each part is still valid on its own.
import { describe, expect, it } from 'vitest';
import { bullets, card, fine, head, section, table } from './tgcard';
import { splitHtml } from './telegram';

describe('the Telegram card', () => {
  it('lines numbers up in a monospaced table, escaping what it shows', () => {
    expect(table([['A year (1×)', '+82%'], ['Sharpe', '3.22'], ['Worst drop', '−5.5%']])).toBe('<pre>A year (1×)   +82%\nSharpe        3.22\nWorst drop   −5.5%</pre>');
    // a comparison with a header row
    expect(table([['Sharpe', '1.00', '1.60']], { header: ['', 'Now', 'New'] })).toBe('<pre>         Now   New\nSharpe  1.00  1.60</pre>');
    expect(table([['a<b', 'x&y']])).toBe('<pre>a&lt;b  x&amp;y</pre>');
  });

  it('builds a message from its parts, a blank line between each, leaving out empty ones', () => {
    const m = card([head('⭐', 'Title', 'second line'), section('Section', bullets(['one', null, 'two'])), section('Empty', [null]), null, fine('small print')]);
    expect(m).toBe('⭐ <b>Title</b>\nsecond line\n\n<b>Section</b>\n• one\n• two\n\n<blockquote expandable>small print</blockquote>');
  });

  it('splits a long message at line ends, closing and reopening a table that spans the split', () => {
    const rows = Array.from({ length: 300 }, (_, i) => [`Row ${i}`, String(i)]);
    const html = card([head('📊', 'Long'), table(rows), fine('end')]);
    const parts = splitHtml(html, 1000);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      // every part has as many openings as closings of each block
      for (const t of ['pre', 'blockquote']) expect((p.match(new RegExp(`<${t}[ >]`, 'g')) ?? []).length).toBe((p.match(new RegExp(`</${t}>`, 'g')) ?? []).length);
    }
    expect(parts.join('').replace(/<\/?pre>/g, '')).toContain('Row 299');
  });
});

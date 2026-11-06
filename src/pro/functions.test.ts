import { describe, expect, it } from 'vitest';
import { FN_MAP, FUNCTIONS, KEYS, parseCommand, suggest, WORKSPACES } from './functions';
import { PANEL_MAP } from '../panels/registry';

describe('the command line', () => {
  it('reads a coin and a function, Bloomberg style', () => {
    expect(parseCommand('eth gp <GO>')).toMatchObject({ coin: 'ETH', fn: { code: 'GP' }, workspace: 'markets' });
    expect(parseCommand('RSCH')).toMatchObject({ coin: null, fn: { code: 'RSCH' }, workspace: 'lab' });
    expect(parseCommand('SOL')).toMatchObject({ coin: 'SOL', fn: null, workspace: null });
    expect(parseCommand('F3').workspace).toBe('swarm');
    expect(parseCommand('lab').workspace).toBe('lab');
  });
  it('suggests codes first, then names', () => {
    expect(suggest('co')[0].code).toBe('CORR');
    expect(suggest('volat').map((f) => f.code)).toContain('HVOL');
    expect(suggest('')).toEqual([]);
  });
  it('every function opens a real panel, codes are unique, keys exist', () => {
    expect(new Set(FUNCTIONS.map((f) => f.code)).size).toBe(FUNCTIONS.length);
    for (const f of FUNCTIONS) expect(PANEL_MAP[f.panel], f.code).toBeTruthy();
    for (const w of WORKSPACES) for (const k of KEYS[w.id]) expect(FN_MAP[k], k).toBeTruthy();
  });
});

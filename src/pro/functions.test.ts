import { describe, expect, it } from 'vitest';
import { FN_MAP, FUNCTIONS, KEYS, parseCommand, suggest, WORKSPACES } from './functions';
import { PANEL_MAP } from '../panels/registry';

describe('the command line', () => {
  it('reads a coin and a function, Bloomberg style', () => {
    expect(parseCommand('eth gp <GO>')).toMatchObject({ coin: 'ETH', fn: { code: 'GP' }, workspace: 'markets' });
    expect(parseCommand('RSCH')).toMatchObject({ coin: null, fn: { code: 'RSCH' }, workspace: 'lab' });
    expect(parseCommand('SOL')).toMatchObject({ coin: 'SOL', fn: null, workspace: null });
    expect(parseCommand('F3').workspace).toBe('quant');
    // the crypto swarm is its own view, not a terminal workspace
    expect(WORKSPACES.map((w) => w.id)).toEqual(['markets', 'lab', 'quant']);
    expect(parseCommand('SWRM')).toMatchObject({ fn: { code: 'SWRM', ws: 'swarm' }, workspace: null });
    expect(parseCommand('lab').workspace).toBe('lab');
  });
  it('answers plain questions about a coin with its report', () => {
    expect(parseCommand('ask about bitcoin')).toMatchObject({ coin: 'BTC', fn: { code: 'ASK' }, workspace: 'markets', unknown: [] });
    expect(parseCommand('ASK SOL')).toMatchObject({ coin: 'SOL', fn: { code: 'ASK' } });
    expect(parseCommand('Tell me about Avalanche?')).toMatchObject({ coin: 'AVAX', fn: { code: 'ASK' }, unknown: [] });
    expect(parseCommand("how is solana doing")).toMatchObject({ coin: 'SOL', fn: { code: 'ASK' } });
    expect(parseCommand('ask about chainlink')).toMatchObject({ coin: 'LINK' });
    // names work with other functions too, and a bare coin still just switches the market
    expect(parseCommand('ethereum gp')).toMatchObject({ coin: 'ETH', fn: { code: 'GP' } });
    expect(parseCommand('bitcoin')).toMatchObject({ coin: 'BTC', fn: null });
    // and Enter is not taken over by a suggestion (CORR mentions bitcoin in its description)
    expect(suggest('ask about bitcoin')).toEqual([]);
    expect(suggest('bitcoin')).toEqual([]);
    expect(suggest('how is sol doing')).toEqual([]);
    expect(suggest('ASK')[0].code).toBe('ASK');
  });
  it('suggests codes first, then names', () => {
    expect(suggest('co')[0].code).toBe('CORR');
    expect(suggest('volat').map((f) => f.code)).toContain('HVOL');
    expect(suggest('')).toEqual([]);
  });
  it('every function opens a real panel, codes are unique, keys exist', () => {
    expect(new Set(FUNCTIONS.map((f) => f.code)).size).toBe(FUNCTIONS.length);
    // every function opens a real panel (SWRM switches to the crypto swarm view itself)
    for (const f of FUNCTIONS) if (f.panel !== 'command') expect(PANEL_MAP[f.panel], f.code).toBeTruthy();
    expect(FUNCTIONS.filter((f) => f.ws === 'swarm').map((f) => f.code)).toEqual(expect.arrayContaining(['SWRM', 'TKT', 'PORT', 'AMT']));
    for (const w of WORKSPACES) for (const k of KEYS[w.id]) expect(FN_MAP[k], k).toBeTruthy();
  });
});

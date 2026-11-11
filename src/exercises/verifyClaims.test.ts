import { describe, expect, it } from 'vitest';
import { verifyClaims } from './verifyClaims';
import type { Fact } from './types';

const facts: Fact[] = [
  { t: 'solution', san: ['Nxe5', 'dxe5', 'Qh5+'] },
  { t: 'motif', name: 'fork', squares: ['f7', 'h8'] },
];

describe('LLM claim verifier', () => {
  it('accepts text that only uses moves and squares from the facts', () => {
    expect(verifyClaims('After Nxe5 dxe5, Qh5+ forks the king and the rook on h8; f7 is the weak point.', facts).ok).toBe(true);
  });
  it('rejects invented moves and squares', () => {
    const r = verifyClaims('Bc4 also wins, and the knight could go to d6.', facts);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(expect.arrayContaining(['Bc4', 'd6']));
  });
  it('ignores check and annotation symbols when matching', () => {
    expect(verifyClaims('Qh5 is the key move!', facts).ok).toBe(true);
  });
});

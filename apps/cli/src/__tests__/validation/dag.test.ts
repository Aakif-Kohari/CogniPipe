import { describe, expect, it } from '@jest/globals';
import {
  detectCycles,
  topologicalSort,
  validateDependsOnReferences,
} from '../../validation/dag.ts';

describe('detectCycles', () => {
  it('returns no cycles for a linear chain (A → B → C)', () => {
    const cycles = detectCycles([
      { name: 'A', dependsOn: [] },
      { name: 'B', dependsOn: ['A'] },
      { name: 'C', dependsOn: ['B'] },
    ]);
    expect(cycles).toEqual([]);
  });

  it('returns no cycles for a diamond (A→B, A→C, B→D, C→D)', () => {
    const cycles = detectCycles([
      { name: 'A', dependsOn: [] },
      { name: 'B', dependsOn: ['A'] },
      { name: 'C', dependsOn: ['A'] },
      { name: 'D', dependsOn: ['B', 'C'] },
    ]);
    expect(cycles).toEqual([]);
  });

  it('returns no cycles for a single step with no dependsOn', () => {
    const cycles = detectCycles([{ name: 'A' }]);
    expect(cycles).toEqual([]);
  });

  it('detects a direct cycle (A→B, B→A) naming both steps', () => {
    const cycles = detectCycles([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ]);
    expect(cycles).toEqual(['Circular dependency: a → b → a']);
  });

  it('detects a transitive cycle (A→B, B→C, C→A) naming all three steps', () => {
    const cycles = detectCycles([
      { name: 'A', dependsOn: ['B'] },
      { name: 'B', dependsOn: ['C'] },
      { name: 'C', dependsOn: ['A'] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain('A');
    expect(cycles[0]).toContain('B');
    expect(cycles[0]).toContain('C');
  });

  it('detects a self-dependency (A→A)', () => {
    const cycles = detectCycles([{ name: 'A', dependsOn: ['A'] }]);
    expect(cycles).toEqual(['Circular dependency: A → A']);
  });

  it('ignores dangling dependsOn references (reported separately by validateDependsOnReferences)', () => {
    const cycles = detectCycles([{ name: 'A', dependsOn: ['does-not-exist'] }]);
    expect(cycles).toEqual([]);
  });

  it('does not re-report a step already fully explored via another path', () => {
    const cycles = detectCycles([
      { name: 'A' },
      { name: 'B', dependsOn: ['A'] },
      { name: 'C', dependsOn: ['A'] },
      { name: 'D', dependsOn: ['B', 'C'] },
    ]);
    expect(cycles).toEqual([]);
  });
});

describe('validateDependsOnReferences', () => {
  it('returns no errors when all references are valid', () => {
    const errors = validateDependsOnReferences([
      { name: 'a', dependsOn: [] },
      { name: 'b', dependsOn: ['a'] },
    ]);
    expect(errors).toEqual([]);
  });

  it('returns no errors when no step has dependsOn', () => {
    const errors = validateDependsOnReferences([{ name: 'a' }, { name: 'b' }]);
    expect(errors).toEqual([]);
  });

  it('reports a reference to a non-existent step, naming source and missing dep', () => {
    const errors = validateDependsOnReferences([{ name: 'step-a', dependsOn: ['does-not-exist'] }]);
    expect(errors).toEqual([
      'Step "step-a" depends on "does-not-exist" which is not defined in this workflow.',
    ]);
  });

  it('reports one error per invalid reference', () => {
    const errors = validateDependsOnReferences([
      { name: 'step-a', dependsOn: ['missing-1', 'missing-2'] },
    ]);
    expect(errors).toHaveLength(2);
  });
});

describe('topologicalSort', () => {
  it('orders a linear chain A→B→C as [A, B, C]', () => {
    const order = topologicalSort([
      { name: 'A' },
      { name: 'B', dependsOn: ['A'] },
      { name: 'C', dependsOn: ['B'] },
    ]);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('places independent diamond branches before their shared dependent', () => {
    const order = topologicalSort([
      { name: 'A' },
      { name: 'B', dependsOn: ['A'] },
      { name: 'C', dependsOn: ['A'] },
      { name: 'D', dependsOn: ['B', 'C'] },
    ]);
    expect(order).not.toBeNull();
    const positions = new Map((order ?? []).map((name, index) => [name, index]));
    expect(positions.get('A')).toBeLessThan(positions.get('B') as number);
    expect(positions.get('A')).toBeLessThan(positions.get('C') as number);
    expect(positions.get('B')).toBeLessThan(positions.get('D') as number);
    expect(positions.get('C')).toBeLessThan(positions.get('D') as number);
  });

  it('places a step with no dependsOn before steps that depend on it', () => {
    const order = topologicalSort([{ name: 'B', dependsOn: ['A'] }, { name: 'A' }]);
    expect(order).toEqual(['A', 'B']);
  });

  it('returns null when the graph has a cycle', () => {
    const order = topologicalSort([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ]);
    expect(order).toBeNull();
  });
});

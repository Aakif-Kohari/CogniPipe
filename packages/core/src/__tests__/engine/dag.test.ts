import { detectCycles } from '../../engine/dag';
import type { StepConfig } from '@cognipipe/types';

function buildStep(name: string, dependsOn?: string[]): StepConfig {
  return {
    name,
    uses: '@cognipipe/node-echo',
    config: {},
    dependsOn,
  };
}

describe('detectCycles', () => {
  it('returns no cycles for a linear chain (A → B → C)', () => {
    const steps = [buildStep('a'), buildStep('b', ['a']), buildStep('c', ['b'])];
    expect(detectCycles(steps)).toEqual([]);
  });

  it('returns no cycles for a diamond (A→B, A→C, B→D, C→D)', () => {
    const steps = [
      buildStep('a'),
      buildStep('b', ['a']),
      buildStep('c', ['a']),
      buildStep('d', ['b', 'c']),
    ];
    expect(detectCycles(steps)).toEqual([]);
  });

  it('returns no cycles for disconnected components', () => {
    const steps = [
      buildStep('a1'),
      buildStep('a2', ['a1']),
      buildStep('b1'),
      buildStep('b2', ['b1']),
    ];
    expect(detectCycles(steps)).toEqual([]);
  });

  it('returns no cycles for a single step with no dependsOn', () => {
    const steps = [buildStep('a')];
    expect(detectCycles(steps)).toEqual([]);
  });

  it('returns a cycle string for a direct cycle (A↔B)', () => {
    const steps = [buildStep('a', ['b']), buildStep('b', ['a'])];
    const cycles = detectCycles(steps);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain('Circular dependency');
    expect(cycles[0]).toContain('a');
    expect(cycles[0]).toContain('b');
  });

  it('returns a cycle string for a self-dependency (A depends on itself)', () => {
    const steps = [buildStep('a', ['a'])];
    const cycles = detectCycles(steps);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain('Circular dependency');
    expect(cycles[0]).toContain('a');
  });

  it('returns a cycle string for a transitive cycle (A→B→C→A)', () => {
    const steps = [buildStep('a', ['c']), buildStep('b', ['a']), buildStep('c', ['b'])];
    const cycles = detectCycles(steps);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain('a');
    expect(cycles[0]).toContain('b');
    expect(cycles[0]).toContain('c');
  });

  it('does NOT report a cycle for a dangling dependsOn reference', () => {
    const steps = [buildStep('a', ['does-not-exist']), buildStep('b', ['a'])];
    expect(detectCycles(steps)).toEqual([]);
  });
});

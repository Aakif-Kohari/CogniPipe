/**
 * @module dag
 *
 * Pure DAG cycle-detection utility for CogniPipe's dependsOn graph.
 * Deliberately independent from apps/cli/src/validation/dag.ts — packages/core
 * must never import from apps/*, so this is a separate, equivalent implementation.
 * No I/O, no side effects.
 */

import type { StepConfig } from '@cognipipe/types';

/** Three-colour marking used by {@link detectCycles}'s DFS. */
type Color = 'WHITE' | 'GRAY' | 'BLACK';

/** One frame of the explicit DFS stack used by {@link detectCycles}. */
interface DfsFrame {
  /** Name of the step this frame is visiting. */
  name: string;
  /** Path from the DFS root to this step (inclusive), used to render a cycle if one is found. */
  path: string[];
  /** Index into this step's `dependsOn` array of the next dependency to visit. */
  depIndex: number;
}

/**
 * Detects cycles in a workflow's dependsOn graph using iterative DFS
 * (three-colour marking: WHITE=unseen, GRAY=in-progress, BLACK=complete).
 *
 * @param steps - The workflow's step array (already validated by WorkflowValidator).
 * @returns An array of cycle description strings. Empty array means no cycles.
 *   Dangling dependsOn references (a name not present in `steps`) are ignored
 *   here — that is a separate validation concern, not this function's job.
 *
 * @example
 * ```typescript
 * detectCycles([
 *   { name: 'a', uses: '...', config: {}, dependsOn: ['b'] },
 *   { name: 'b', uses: '...', config: {}, dependsOn: ['a'] },
 * ]);
 * // → ['Circular dependency: a → b → a']
 * ```
 */
export function detectCycles(steps: StepConfig[]): string[] {
  const stepNames = new Set(steps.map(step => step.name));
  const stepByName = new Map(steps.map(step => [step.name, step]));
  const colors = new Map<string, Color>();
  for (const step of steps) {
    colors.set(step.name, 'WHITE');
  }

  const cycles: string[] = [];

  for (const root of steps) {
    if (colors.get(root.name) !== 'WHITE') {
      continue;
    }

    colors.set(root.name, 'GRAY');
    const stack: DfsFrame[] = [{ name: root.name, path: [root.name], depIndex: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as DfsFrame;

      const currentStep = stepByName.get(frame.name);
      const deps = currentStep?.dependsOn ?? [];

      if (frame.depIndex >= deps.length) {
        // All dependencies visited — this step is fully processed.
        colors.set(frame.name, 'BLACK');
        stack.pop();
        continue;
      }

      const dep = deps[frame.depIndex];
      frame.depIndex += 1;

      // Dangling reference — WorkflowValidator's concern, not this function's job.
      if (dep === undefined || !stepNames.has(dep)) {
        continue;
      }

      const depColor = colors.get(dep);

      if (depColor === 'GRAY') {
        // Found a back-edge into a node still on the current path — that's a cycle.
        const cycleStart = frame.path.indexOf(dep);
        const cyclePath = frame.path.slice(Math.max(0, cycleStart)).concat(dep);
        cycles.push(`Circular dependency: ${cyclePath.join(' → ')}`);
        continue;
      }

      if (depColor === 'WHITE') {
        colors.set(dep, 'GRAY');
        stack.push({ name: dep, path: [...frame.path, dep], depIndex: 0 });
      }

      // BLACK: already fully explored via another path — nothing to do.
    }
  }

  return cycles;
}

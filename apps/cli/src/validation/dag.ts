/**
 * @module dag
 *
 * Pure DAG (Directed Acyclic Graph) utilities for CogniPipe workflow validation.
 * No I/O, no side effects — all functions are pure and independently testable.
 */

/** Minimal shape every DAG utility operates on — a step name plus its dependency names. */
export interface DagStep {
  name: string;
  dependsOn?: string[];
}

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
 * @param steps - Array of step objects with `name` and optional `dependsOn`.
 * @returns An array of cycle description strings. Empty array means no cycles.
 *
 * @example
 * ```typescript
 * detectCycles([
 *   { name: 'a', dependsOn: ['b'] },
 *   { name: 'b', dependsOn: ['a'] },  // cycle: a → b → a
 * ]);
 * // → ['Circular dependency: a → b → a']
 * ```
 */
export function detectCycles(steps: Array<{ name: string; dependsOn?: string[] }>): string[] {
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
      const frame = stack[stack.length - 1];
      if (!frame) {
        break;
      }

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

      // Dangling reference — validateDependsOnReferences() is responsible for reporting this.
      if (dep === undefined || !stepNames.has(dep)) {
        continue;
      }

      const depColor = colors.get(dep);

      if (depColor === 'GRAY') {
        // Found a back-edge into a node still on the current path — that's a cycle.
        const cycleStart = frame.path.indexOf(dep);
        const cyclePath = frame.path.slice(cycleStart === -1 ? 0 : cycleStart).concat(dep);
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

/**
 * Validates that every step name listed in any `dependsOn` array
 * exists as an actual step name in the workflow.
 *
 * @returns An array of error strings. Empty means all references are valid.
 *
 * @example
 * ```typescript
 * validateDependsOnReferences([
 *   { name: 'step-a', dependsOn: ['does-not-exist'] },
 * ]);
 * // → ['Step "step-a" depends on "does-not-exist" which is not defined in this workflow.']
 * ```
 */
export function validateDependsOnReferences(
  steps: Array<{ name: string; dependsOn?: string[] }>,
): string[] {
  const stepNames = new Set(steps.map(step => step.name));
  const errors: string[] = [];

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepNames.has(dep)) {
        errors.push(
          `Step "${step.name}" depends on "${dep}" which is not defined in this workflow.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Produces the topological sort order (Kahn's algorithm) of steps,
 * respecting `dependsOn` dependencies. Steps without dependencies come first.
 * Assumes no cycles — call detectCycles() first.
 *
 * Dangling `dependsOn` references (names not present in `steps`) are ignored here;
 * validateDependsOnReferences() is responsible for reporting those separately.
 *
 * @returns Step names in the order they would be executed, or null if the
 *   graph has a cycle (call detectCycles() for details in that case).
 */
export function topologicalSort(
  steps: Array<{ name: string; dependsOn?: string[] }>,
): string[] | null {
  const stepNames = new Set(steps.map(step => step.name));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.name, 0);
    dependents.set(step.name, []);
  }

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepNames.has(dep)) {
        continue;
      }
      inDegree.set(step.name, (inDegree.get(step.name) ?? 0) + 1);
      dependents.get(dep)?.push(step.name);
    }
  }

  const queue: string[] = [];
  for (const step of steps) {
    if (inDegree.get(step.name) === 0) {
      queue.push(step.name);
    }
  }

  const result: string[] = [];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) {
      continue;
    }

    result.push(current);

    for (const dependent of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  return result.length === steps.length ? result : null;
}

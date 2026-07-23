/* eslint-disable no-console -- this command's entire purpose is printing a human-readable report */
/**
 * @module test
 *
 * Implements the `cognipipe test <workflow-file>` CLI command.
 * Validates a workflow without executing any nodes. Exits 0 if valid, 1 if not.
 *
 * Checks performed (in order):
 *   1. Parse the workflow file (WorkflowParser)
 *   2. Validate the workflow structure (WorkflowValidator)
 *      — 1 and 2 are reported together as a single "Structure" row.
 *   3. Validate dependsOn references (all names must exist as step names)
 *   4. Detect circular dependencies in the dependsOn DAG
 *   5. Verify each node package can be dynamically imported
 *   6. Print the execution order (topological sort)
 */
import { Command } from 'commander';
import { detectCycles, topologicalSort, validateDependsOnReferences } from '../validation/dag';

/** Width of the check-name column before the ✅/❌ icon. Matches the spec's sample output. */
const LABEL_WIDTH = 18;

function icon(ok: boolean): string {
  return ok ? '✅' : '❌';
}

/** Renders a labelled check row, e.g. "Structure         ✅ Valid". */
function formatRow(label: string, ok: boolean, message: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${icon(ok)} ${message}`;
}

/** Renders a continuation row under a labelled check (blank label), for multi-line results. */
function formatContinuation(ok: boolean, message: string): string {
  return `${''.padEnd(LABEL_WIDTH)}${icon(ok)} ${message}`;
}

function messageOf(
  err: unknown,
  isCogniPipeError: typeof import('@cognipipe/core').isCogniPipeError,
): string {
  if (isCogniPipeError(err)) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Parses and validates the workflow file. Return type is inferred from WorkflowValidator. */
async function loadConfig(workflowFilePath: string, core: typeof import('@cognipipe/core')) {
  const parser = new core.WorkflowParser();
  const validator = new core.WorkflowValidator();
  const raw = await parser.parseFile(workflowFilePath);
  return validator.validate(raw);
}

/**
 * Runs every check against the given workflow file and prints the report.
 *
 * @returns The process exit code: 0 if every check passed, 1 otherwise.
 */
async function runTest(workflowFilePath: string): Promise<number> {
  const core = await import('@cognipipe/core');

  // Checks 1 + 2: parse and validate structure. Reported as a single "Structure" row —
  // the sample output in the issue only shows one such row for both.
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(workflowFilePath, core);
  } catch (err) {
    console.log(formatRow('Structure', false, messageOf(err, core.isCogniPipeError)));
    console.log(`Result: 1 error — workflow is not ready to run.`);
    return 1;
  }

  console.log(`Validating workflow: ${config.name} (${config.version})`);
  console.log(formatRow('Structure', true, 'Valid'));

  let errorCount = 0;

  // Check 3: dependsOn references.
  const refErrors = validateDependsOnReferences(config.steps);
  if (refErrors.length === 0) {
    const refCount = config.steps.reduce((sum, step) => sum + (step.dependsOn?.length ?? 0), 0);
    const noun = refCount === 1 ? 'reference' : 'references';
    const verb = refCount === 1 ? 'resolves' : 'resolve';
    console.log(formatRow('dependsOn refs', true, `All ${refCount} ${noun} ${verb}`));
  } else {
    const noun = refErrors.length === 1 ? 'reference' : 'references';
    console.log(formatRow('dependsOn refs', false, `${refErrors.length} invalid ${noun}`));
    for (const error of refErrors) {
      console.log(formatContinuation(false, error));
    }
    errorCount += refErrors.length;
  }

  // Check 4: circular dependencies.
  const cycles = detectCycles(config.steps);
  if (cycles.length === 0) {
    console.log(formatRow('Circular deps', true, 'No cycles detected'));
  } else {
    const noun = cycles.length === 1 ? 'cycle' : 'cycles';
    console.log(formatRow('Circular deps', false, `${cycles.length} ${noun} detected`));
    for (const cycle of cycles) {
      console.log(formatContinuation(false, cycle));
    }
    errorCount += cycles.length;
  }

  // Check 5: node package availability.
  const availability: Array<{ stepName: string; packageName: string; available: boolean }> = [];
  for (const step of config.steps) {
    let available = true;
    try {
      await import(step.uses);
    } catch {
      available = false;
    }
    availability.push({ stepName: step.name, packageName: step.uses, available });
  }

  const maxPkgLen = availability.reduce((max, a) => Math.max(max, a.packageName.length), 0);
  availability.forEach((entry, index) => {
    const paddedPkg = entry.packageName.padEnd(maxPkgLen);
    const message = entry.available
      ? `${paddedPkg} (found)`
      : `${paddedPkg} (not installed — run: pnpm add ${entry.packageName})`;

    if (index === 0) {
      console.log(formatRow('Node availability', entry.available, message));
    } else {
      console.log(formatContinuation(entry.available, message));
    }

    if (!entry.available) {
      errorCount += 1;
    }
  });

  // Check 6: execution order preview (skipped when a cycle makes ordering meaningless).
  if (cycles.length === 0) {
    const order = topologicalSort(config.steps);
    if (order) {
      const stepByName = new Map(config.steps.map(step => [step.name, step]));
      const maxNameLen = order.reduce((max, name) => Math.max(max, name.length), 0);

      console.log('Execution order:');
      order.forEach((name, index) => {
        const uses = stepByName.get(name)?.uses ?? '';
        console.log(`  ${index + 1}. ${name.padEnd(maxNameLen)} (${uses})`);
      });
    }
  }

  if (errorCount === 0) {
    console.log('Result: All checks passed — workflow is ready to run.');
    return 0;
  }

  const noun = errorCount === 1 ? 'error' : 'errors';
  console.log(`Result: ${errorCount} ${noun} — workflow is not ready to run.`);
  return 1;
}

export function createTestCommand(): Command {
  const command = new Command('test');

  command
    .description('Validate a workflow without executing any nodes')
    .argument('<workflow-file>', 'Path to the workflow YAML/JSON file')
    .action(async (workflowFile: string) => {
      process.exitCode = await runTest(workflowFile);
    });

  return command;
}

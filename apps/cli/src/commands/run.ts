/* eslint-disable no-console -- this command's entire purpose is printing execution results */
/**
 * @module run
 *
 * Implements the `cognipipe run <workflow-file>` CLI command.
 * Chains WorkflowParser → WorkflowValidator → node discovery → WorkflowExecutor.
 */
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  WorkflowParser,
  WorkflowValidator,
  NodeRegistry,
  WorkflowExecutor,
  isCogniPipeError,
} from '@cognipipe/core';
import type { NodeConstructor } from '@cognipipe/core';

/**
 * Dynamically discovers and registers all node packages referenced by the workflow.
 *
 * Node discovery protocol:
 *   1. `await import(packageName)` — load the npm package
 *   2. Iterate every export — find the class with `cogniNodeMeta.type === packageName`
 *   3. Register that class with the registry
 *
 * If a package cannot be imported (not installed), it is silently skipped.
 * `WorkflowExecutor.run()` performs its own upfront pass over every step's `uses`
 * and throws `NODE_NOT_REGISTERED` with a clear, actionable message before any
 * step executes — so a missing package is never a silent failure, it's just not
 * this function's job to report it.
 *
 * @throws Never — import failures are swallowed, not re-thrown.
 */
async function discoverAndRegisterNodes(uses: string[], registry: NodeRegistry): Promise<void> {
  for (const packageName of uses) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(packageName)) as Record<string, unknown>;
    } catch {
      // Package not installed — NodeRegistry.instantiate() will throw NODE_NOT_REGISTERED
      // with a clear error during the executor's upfront validation pass.
      continue;
    }

    const matches = Object.values(mod).filter(
      (exported): exported is NodeConstructor =>
        typeof exported === 'function' &&
        'cogniNodeMeta' in exported &&
        (exported as { cogniNodeMeta?: { type: string } }).cogniNodeMeta?.type === packageName,
    );

    if (matches.length > 1) {
      // Ambiguous — the package exports more than one class decorated with the
      // same cogniNodeMeta.type. Don't silently pick one; skip registration
      // entirely so NodeRegistry's upfront pass throws NODE_NOT_REGISTERED with
      // an actionable message, same as an uninstalled package.
      continue;
    }

    if (matches[0]) {
      registry.register(packageName, matches[0]);
    }
  }
}

/**
 * Creates and returns the Commander.js `run` subcommand.
 * Registered in src/index.ts via program.addCommand(createRunCommand()).
 */
export function createRunCommand(): Command {
  return new Command('run')
    .description('Execute a workflow from a YAML or JSON file')
    .argument('<workflow-file>', 'Path to the workflow.yaml or workflow.json file')
    .option('--verbose', 'Print detailed step-level execution output', false)
    .action(async (workflowFile: string, options: { verbose: boolean }) => {
      const filePath = resolve(process.cwd(), workflowFile);

      try {
        // 1. Parse
        const parser = new WorkflowParser();
        const raw = await parser.parseFile(filePath);

        // 2. Validate
        const validator = new WorkflowValidator();
        const config = validator.validate(raw);

        // 3. Discover and register nodes
        const registry = new NodeRegistry();
        const uniqueUses = [...new Set(config.steps.map(step => step.uses))];
        await discoverAndRegisterNodes(uniqueUses, registry);

        // 4. Execute
        const executor = new WorkflowExecutor(registry);
        const result = await executor.run(config);

        // 5. Output
        if (options.verbose) {
          const steps = (result.context.toJSON()['steps'] as Record<string, unknown>) ?? {};
          for (const [name, stepResult] of Object.entries(steps)) {
            console.log(`✅ ${name}:`, JSON.stringify(stepResult, null, 2));
          }
        }

        if (result.stepErrors.length > 0) {
          for (const { stepName, error } of result.stepErrors) {
            console.error(`⚠️  Step "${stepName}" failed (continueOnError): ${error.message}`);
          }
        }

        console.log(`✅ Workflow "${config.name}" completed — ${config.steps.length} step(s).`);
        process.exitCode = 0;
      } catch (err) {
        if (isCogniPipeError(err)) {
          console.error(`❌ [${err.code}] ${err.message}`);
          if (err.context) {
            console.error('   Details:', JSON.stringify(err.context, null, 2));
          }
        } else {
          console.error('❌ Unexpected error:', err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });
}

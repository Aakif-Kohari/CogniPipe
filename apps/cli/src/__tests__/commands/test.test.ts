import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCommand } from '../../commands/test.ts';

/**
 * These are integration-style tests: they run the command against real
 * WorkflowParser/WorkflowValidator instances and real fixture files on disk,
 * rather than mocking @cognipipe/core.
 *
 * The "node package is installed" case uses `commander` as a stand-in `uses`
 * value — it's already a dependency of apps/cli, so `import('commander')`
 * genuinely succeeds, exercising the real success path without needing a
 * published @cognipipe/node-* package inside this workspace.
 */

let dir: string;

function writeWorkflow(filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

async function run(
  workflowFile: string,
): Promise<{ exitCode: number | undefined; output: string }> {
  const logs: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });

  process.exitCode = undefined;
  const command = createTestCommand();
  await command.parseAsync([workflowFile], { from: 'user' });
  const exitCode = process.exitCode;

  logSpy.mockRestore();
  process.exitCode = undefined;

  return { exitCode, output: logs.join('\n') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cognipipe-test-cmd-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cognipipe test', () => {
  it('exits 0 and prints ✅ for all checks when the workflow is valid and nodes are available', async () => {
    const file = writeWorkflow(
      'valid.yaml',
      `
name: daily-report
version: 1.0.0
steps:
  - name: fetch-data
    uses: commander
    config: {}
  - name: post-result
    uses: commander
    config: {}
    dependsOn: [fetch-data]
`,
    );
    const { exitCode, output } = await run(file);
    expect(exitCode).toBe(0);
    expect(output).toContain('Structure         ✅ Valid');
    expect(output).toContain('Circular deps     ✅ No cycles detected');
    expect(output).toContain('Result: All checks passed — workflow is ready to run.');
  });

  it('exits 1 and names the missing package when a node package is not installed', async () => {
    const file = writeWorkflow(
      'missing-package.yaml',
      `
name: daily-report
version: 1.0.0
steps:
  - name: fetch-data
    uses: '@cognipipe/node-totally-fake-xyz'
    config: {}
`,
    );
    const { exitCode, output } = await run(file);
    expect(exitCode).toBe(1);
    expect(output).toContain('@cognipipe/node-totally-fake-xyz');
    expect(output).toContain('not installed');
    expect(output).toContain('pnpm add @cognipipe/node-totally-fake-xyz');
  });

  it('exits 1 and names the invalid reference when dependsOn points at a non-existent step', async () => {
    const file = writeWorkflow(
      'bad-ref.yaml',
      `
name: daily-report
version: 1.0.0
steps:
  - name: fetch-data
    uses: commander
    config: {}
    dependsOn: [does-not-exist]
`,
    );
    const { exitCode, output } = await run(file);
    expect(exitCode).toBe(1);
    expect(output).toContain('fetch-data');
    expect(output).toContain('does-not-exist');
  });

  it('exits 1 and shows the cycle path when there is a circular dependency', async () => {
    const file = writeWorkflow(
      'cycle.yaml',
      `
name: daily-report
version: 1.0.0
steps:
  - name: a
    uses: commander
    config: {}
    dependsOn: [b]
  - name: b
    uses: commander
    config: {}
    dependsOn: [a]
`,
    );
    const { exitCode, output } = await run(file);
    expect(exitCode).toBe(1);
    expect(output).toContain('Circular dependency');
    expect(output).toContain('a → b → a');
  });

  it('exits 1 with a parse error message when the file does not exist', async () => {
    const { exitCode, output } = await run(join(dir, 'does-not-exist.yaml'));
    expect(exitCode).toBe(1);
    expect(output).toContain('Failed to read workflow file');
  });

  it('exits 1 with a validation error message when the workflow structure is invalid', async () => {
    const file = writeWorkflow(
      'invalid-structure.yaml',
      `
name: daily-report
steps:
  - name: fetch-data
    uses: commander
    config: {}
`,
    );
    const { exitCode, output } = await run(file);
    expect(exitCode).toBe(1);
    expect(output).toContain('Structure');
    expect(output).toContain('❌');
  });
});

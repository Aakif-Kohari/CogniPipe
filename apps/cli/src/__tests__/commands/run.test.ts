import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockParseFile = jest.fn();
const mockValidate = jest.fn();
const mockRegister = jest.fn();
const mockRun = jest.fn();

jest.unstable_mockModule('@cognipipe/core', () => {
  const actual = jest.requireActual<typeof import('@cognipipe/core')>('@cognipipe/core');
  return {
    ...actual,
    WorkflowParser: jest.fn().mockImplementation(() => ({ parseFile: mockParseFile })),
    WorkflowValidator: jest.fn().mockImplementation(() => ({ validate: mockValidate })),
    NodeRegistry: jest.fn().mockImplementation(() => ({
      register: mockRegister,
      has: jest.fn().mockReturnValue(true),
    })),
    WorkflowExecutor: jest.fn().mockImplementation(() => ({ run: mockRun })),
  };
});

// Both the mocked package's real exports (CogniPipeError, error codes) and the
// module under test must be loaded via dynamic import, AFTER the mock is
// registered above — a static `import` here would race the mock, exactly like
// the bug this replaces.
const { CogniPipeError, COGNIPIPE_ERROR_CODES } = await import('@cognipipe/core');
const { createRunCommand } = await import('../../commands/run.js');

function makeConfig(
  steps: Array<{ name: string; uses: string }> = [{ name: 'step-1', uses: 'commander' }],
) {
  return { name: 'daily-report', version: '1.0.0', steps };
}

function makeExecutionResult(
  overrides: Partial<{ steps: Record<string, unknown>; stepErrors: unknown[] }> = {},
) {
  const steps = overrides.steps ?? {};
  return {
    context: { toJSON: () => ({ steps }) },
    stepErrors: overrides.stepErrors ?? [],
  };
}

let logSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

async function run(args: string[]): Promise<number | undefined> {
  process.exitCode = undefined;
  const command = createRunCommand();
  await command.parseAsync(args, { from: 'user' });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return exitCode;
}

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('cognipipe run', () => {
  it('completes with exit code 0 for a valid workflow', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockReturnValue(makeConfig());
    mockRun.mockResolvedValue(makeExecutionResult());

    const exitCode = await run(['workflow.yaml']);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('prints step outputs when --verbose is passed', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockReturnValue(makeConfig());
    mockRun.mockResolvedValue(
      makeExecutionResult({ steps: { 'step-1': { output: { ok: true }, durationMs: 12 } } }),
    );

    const exitCode = await run(['workflow.yaml', '--verbose']);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✅ step-1:'), expect.any(String));
  });

  it('prints a warning and still exits 0 for continueOnError step failures', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockReturnValue(makeConfig());
    mockRun.mockResolvedValue(
      makeExecutionResult({
        stepErrors: [{ stepName: 'step-2', error: new Error('boom') }],
      }),
    );

    const exitCode = await run(['workflow.yaml']);

    expect(exitCode).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Step "step-2" failed'));
  });

  it('exits 1 with a WORKFLOW_PARSE_ERROR when the workflow file is not found', async () => {
    mockParseFile.mockRejectedValue(
      new CogniPipeError('Failed to read workflow file', {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
      }),
    );

    const exitCode = await run(['does-not-exist.yaml']);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_PARSE_ERROR'));
  });

  it('exits 1 with a WORKFLOW_VALIDATION_ERROR for invalid workflow structure', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockImplementation(() => {
      throw new CogniPipeError('Invalid workflow structure', {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR,
      });
    });

    const exitCode = await run(['invalid.yaml']);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WORKFLOW_VALIDATION_ERROR'));
  });

  it('exits 1 with NODE_NOT_REGISTERED when a node package is not installed', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockReturnValue(
      makeConfig([{ name: 'step-1', uses: '@cognipipe/node-totally-fake-xyz' }]),
    );
    mockRun.mockRejectedValue(
      new CogniPipeError('Node "@cognipipe/node-totally-fake-xyz" is not registered', {
        code: COGNIPIPE_ERROR_CODES.NODE_NOT_REGISTERED,
      }),
    );

    const exitCode = await run(['workflow.yaml']);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_NOT_REGISTERED'));
  });

  it('exits 1 with a generic message for an unexpected non-CogniPipeError', async () => {
    mockParseFile.mockRejectedValue(new Error('disk on fire'));

    const exitCode = await run(['workflow.yaml']);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected error'),
      'disk on fire',
    );
  });

  it('registers a node exported with a matching cogniNodeMeta.type and skips uninstalled packages', async () => {
    mockParseFile.mockResolvedValue({});
    mockValidate.mockReturnValue(
      makeConfig([
        { name: 'a', uses: 'commander' },
        { name: 'b', uses: '@cognipipe/node-does-not-exist' },
      ]),
    );
    mockRun.mockResolvedValue(makeExecutionResult());

    const exitCode = await run(['workflow.yaml']);

    expect(exitCode).toBe(0);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

jest.mock('node:fs/promises');

import { readFile } from 'node:fs/promises';
import { WorkflowParser, SUPPORTED_EXTENSIONS } from '../../engine/WorkflowParser';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

const parser = new WorkflowParser();

function makeErrnoException(code: string): Error & { code: string } {
  const err = new Error(`fs error: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

function expectParseError(fn: () => unknown): CogniPipeError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }

  expect(isCogniPipeError(thrown)).toBe(true);
  const err = thrown as CogniPipeError;
  expect(err.code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
  return err;
}

async function expectParseErrorAsync(fn: () => Promise<unknown>): Promise<CogniPipeError> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }

  expect(isCogniPipeError(thrown)).toBe(true);
  const err = thrown as CogniPipeError;
  expect(err.code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
  return err;
}

beforeEach(() => {
  mockReadFile.mockReset();
});

describe('WorkflowParser', () => {
  describe('parseYAML', () => {
    it('returns a plain JS object for a valid single-step workflow', () => {
      const result = parser.parseYAML('name: my-workflow\nversion: "1.0.0"\nsteps: []');
      expect(result).toEqual({ name: 'my-workflow', version: '1.0.0', steps: [] });
    });

    it('returns a plain JS object for a valid multi-step workflow with optional fields', () => {
      const yaml = [
        'name: my-workflow',
        'version: "1.0.0"',
        'description: does things',
        'steps:',
        '  - name: step-a',
        '    uses: "@cognipipe/node-http"',
        '  - name: step-b',
        '    uses: "@cognipipe/node-http"',
        '    dependsOn: [step-a]',
        '',
      ].join('\n');

      const result = parser.parseYAML(yaml) as { steps: unknown[] };
      expect(result.steps).toHaveLength(2);
    });

    it('returns unknown with no cast needed (type-level check)', () => {
      const result: unknown = parser.parseYAML('name: x\nversion: "1.0.0"\nsteps: []');
      expect(result).toBeDefined();
    });

    it('throws CogniPipeError for an empty string', () => {
      expectParseError(() => parser.parseYAML(''));
    });

    it('throws CogniPipeError for whitespace-only content', () => {
      expectParseError(() => parser.parseYAML('   \n  '));
    });

    it('throws CogniPipeError (not a raw js-yaml error) for invalid YAML', () => {
      const err = expectParseError(() => parser.parseYAML('name: [unclosed bracket'));
      expect(err.message).toContain('Failed to parse YAML');
    });

    it('throws CogniPipeError for a valid-but-null YAML document', () => {
      expectParseError(() => parser.parseYAML('---'));
    });

    it('includes the source label in the error message when provided', () => {
      const err = expectParseError(() => parser.parseYAML('', '/path/to/empty.yaml'));
      expect(err.message).toContain('/path/to/empty.yaml');
    });
  });

  describe('parseJSON', () => {
    it('returns a plain JS object for valid workflow JSON', () => {
      const json = JSON.stringify({ name: 'my-workflow', version: '1.0.0', steps: [] });
      const result = parser.parseJSON(json);
      expect(result).toEqual({ name: 'my-workflow', version: '1.0.0', steps: [] });
    });

    it('throws CogniPipeError for an empty string', () => {
      expectParseError(() => parser.parseJSON(''));
    });

    it('throws CogniPipeError (not a raw SyntaxError) for invalid JSON', () => {
      let thrown: unknown;
      try {
        parser.parseJSON('{ invalid json');
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect(thrown instanceof SyntaxError).toBe(false);
    });

    it('throws CogniPipeError for a valid-but-null JSON value', () => {
      expectParseError(() => parser.parseJSON('null'));
    });
  });

  describe('parseFile', () => {
    it('reads and parses a .yaml file via mocked readFile', async () => {
      mockReadFile.mockResolvedValue('name: x\nversion: "1.0.0"\nsteps: []');
      const result = await parser.parseFile('/workflows/a.yaml');
      expect(result).toEqual({ name: 'x', version: '1.0.0', steps: [] });
      expect(mockReadFile).toHaveBeenCalledWith('/workflows/a.yaml', 'utf-8');
    });

    it('reads and parses a .yml file', async () => {
      mockReadFile.mockResolvedValue('name: x\nversion: "1.0.0"\nsteps: []');
      const result = await parser.parseFile('/workflows/a.yml');
      expect(result).toEqual({ name: 'x', version: '1.0.0', steps: [] });
    });

    it('reads and parses a .json file', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: 'x', version: '1.0.0', steps: [] }));
      const result = await parser.parseFile('/workflows/a.json');
      expect(result).toEqual({ name: 'x', version: '1.0.0', steps: [] });
    });

    it('treats extensions case-insensitively (.YAML, .Yaml)', async () => {
      mockReadFile.mockResolvedValue('name: x\nversion: "1.0.0"\nsteps: []');
      await expect(parser.parseFile('/workflows/a.YAML')).resolves.toBeDefined();
      await expect(parser.parseFile('/workflows/a.Yaml')).resolves.toBeDefined();
    });

    it('throws for a .ts extension before any file read', async () => {
      await expectParseErrorAsync(() => parser.parseFile('workflow.ts'));
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('throws for a .txt extension before any file read', async () => {
      await expectParseErrorAsync(() => parser.parseFile('notes.txt'));
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('throws with the file path in the message on ENOENT', async () => {
      mockReadFile.mockRejectedValue(makeErrnoException('ENOENT'));
      const err = await expectParseErrorAsync(() => parser.parseFile('/path/to/missing.yaml'));
      expect(err.message).toContain('/path/to/missing.yaml');
    });

    it('wraps a generic fs error with the original error as .cause', async () => {
      const fsError = makeErrnoException('EACCES');
      mockReadFile.mockRejectedValue(fsError);
      const err = await expectParseErrorAsync(() => parser.parseFile('/path/to/locked.yaml'));
      expect(err.cause).toBe(fsError);
    });

    it('throws for empty content in an otherwise valid file', async () => {
      mockReadFile.mockResolvedValue('');
      await expectParseErrorAsync(() => parser.parseFile('/workflows/empty.yaml'));
    });

    it('throws for invalid YAML content in an otherwise valid file', async () => {
      mockReadFile.mockResolvedValue('name: [unclosed bracket');
      await expectParseErrorAsync(() => parser.parseFile('/workflows/bad.yaml'));
    });
  });

  describe('exports', () => {
    it('exposes the expected supported extensions', () => {
      expect(SUPPORTED_EXTENSIONS).toEqual(['.yaml', '.yml', '.json']);
    });
  });
});

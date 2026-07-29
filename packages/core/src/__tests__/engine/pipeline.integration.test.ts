// Integration tests — no mocking. Uses real WorkflowParser + WorkflowValidator.
// No jest.mock() calls belong in this file — that would defeat the purpose of
// integration testing the real parse → validate boundary.

import { WorkflowParser } from '../../engine/WorkflowParser';
import { WorkflowValidator } from '../../engine/WorkflowValidator';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

// Shared instances — created once, not per test, to mirror real engine usage.
const parser = new WorkflowParser();
const validator = new WorkflowValidator();

// Spy (not a mock): records validate() calls while still delegating to the real
// implementation. Used to assert the parser's raw unknown output reaches validate(),
// and that a parse failure never invokes validate() at all.
const validateSpy = jest.spyOn(validator, 'validate');

beforeEach(() => {
  validateSpy.mockClear();
});

afterAll(() => {
  validateSpy.mockRestore();
});

describe('YAML → validate happy path', () => {
  it('returns a WorkflowConfig with the correct name, version, and first step fields for a single-step workflow', () => {
    const yaml = [
      'name: fetch-workflow',
      'version: "1.0.0"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(config.name).toBe('fetch-workflow');
    expect(config.version).toBe('1.0.0');
    expect(config.steps[0].name).toBe('fetch-data');
    expect(config.steps[0].uses).toBe('@cognipipe/node-http');
  });

  it('preserves dependsOn and retry across steps, with steps[1].dependsOn referencing the first step name', () => {
    const yaml = [
      'name: multi-step-workflow',
      'version: "1.0.0"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '  - name: process-data',
      '    uses: "@cognipipe/node-transform"',
      '    dependsOn: [fetch-data]',
      '    retry:',
      '      attempts: 3',
      '      delayMs: 500',
      '      backoff: exponential',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(config.steps[1].dependsOn).toContain('fetch-data');
    expect(config.steps[1].retry).toEqual({ attempts: 3, delayMs: 500, backoff: 'exponential' });
  });

  it('surfaces the optional description as a string when present in YAML', () => {
    const yaml = [
      'name: described-workflow',
      'version: "1.0.0"',
      'description: "Fetches and processes data"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(typeof config.description).toBe('string');
    expect(config.description).toBe('Fetches and processes data');
  });

  it('passes continueOnError: true through to the validated step unchanged', () => {
    const yaml = [
      'name: resilient-workflow',
      'version: "1.0.0"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '    continueOnError: true',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(config.steps[0].continueOnError).toBe(true);
  });

  it('defaults an absent step config to an empty object via the Zod schema default', () => {
    const yaml = [
      'name: default-config-workflow',
      'version: "1.0.0"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(config.steps[0].config).toEqual({});
  });
});

describe('JSON → validate happy path', () => {
  it('returns a WorkflowConfig with both steps present for a two-step JSON workflow', () => {
    const json = JSON.stringify({
      name: 'json-workflow',
      version: '1.0.0',
      steps: [
        { name: 'fetch-data', uses: '@cognipipe/node-http' },
        { name: 'process-data', uses: '@cognipipe/node-transform' },
      ],
    });

    const raw = parser.parseJSON(json);
    const config = validator.validate(raw);

    expect(validateSpy).toHaveBeenCalledWith(raw);
    expect(config.steps).toHaveLength(2);
    expect(config.steps.map(step => step.name)).toEqual(['fetch-data', 'process-data']);
  });

  it('produces structurally equal WorkflowConfigs for equivalent YAML and JSON inputs', () => {
    // The same workflow expressed in both formats — parsing + validating each must
    // yield identical WorkflowConfig structures, proving parser format-neutrality.
    const yaml = [
      'name: parity-workflow',
      'version: "1.0.0"',
      'description: "Same workflow in two formats"',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '  - name: process-data',
      '    uses: "@cognipipe/node-transform"',
      '    dependsOn: [fetch-data]',
      '',
    ].join('\n');
    const json = JSON.stringify({
      name: 'parity-workflow',
      version: '1.0.0',
      description: 'Same workflow in two formats',
      steps: [
        { name: 'fetch-data', uses: '@cognipipe/node-http' },
        { name: 'process-data', uses: '@cognipipe/node-transform', dependsOn: ['fetch-data'] },
      ],
    });

    const rawYaml = parser.parseYAML(yaml);
    const configYaml = validator.validate(rawYaml);
    expect(validateSpy).toHaveBeenCalledWith(rawYaml);

    const rawJson = parser.parseJSON(json);
    const configJson = validator.validate(rawJson);
    expect(validateSpy).toHaveBeenCalledWith(rawJson);

    expect(configJson).toEqual(configYaml);
  });
});

describe('parse failure short-circuits pipeline', () => {
  it('throws WORKFLOW_PARSE_ERROR for an empty YAML string before validate runs', () => {
    expect.assertions(4);
    try {
      parser.parseYAML('');
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
      expect((err as CogniPipeError).message).toContain('empty');
    }
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('throws WORKFLOW_PARSE_ERROR for a null YAML document ("---") before validate runs', () => {
    expect.assertions(4);
    try {
      parser.parseYAML('---');
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
      expect((err as CogniPipeError).message).toContain('empty');
    }
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('throws WORKFLOW_PARSE_ERROR for a JSON null literal before validate runs', () => {
    expect.assertions(4);
    try {
      parser.parseJSON('null');
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
      expect((err as CogniPipeError).message).toContain('empty');
    }
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('throws WORKFLOW_PARSE_ERROR for syntactically invalid JSON before validate runs', () => {
    expect.assertions(4);
    try {
      parser.parseJSON('{ bad json');
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR);
      expect((err as CogniPipeError).message).toContain('Failed to parse JSON');
    }
    expect(validateSpy).not.toHaveBeenCalled();
  });
});

describe('parse succeeds, validate fails', () => {
  it('throws WORKFLOW_VALIDATION_ERROR with "version" in the message when version is absent', () => {
    expect.assertions(4);
    const yaml = [
      'name: missing-version-workflow',
      'steps:',
      '  - name: fetch-data',
      '    uses: "@cognipipe/node-http"',
      '',
    ].join('\n');

    // Parsing is schema-agnostic and must succeed — only validate enforces required fields.
    const raw = parser.parseYAML(yaml);

    try {
      validator.validate(raw);
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((err as CogniPipeError).message).toContain('"version"');
    }
    expect(validateSpy).toHaveBeenCalledWith(raw);
  });

  it('throws WORKFLOW_VALIDATION_ERROR when steps is an empty array', () => {
    expect.assertions(4);
    const yaml = ['name: empty-steps-workflow', 'version: "1.0.0"', 'steps: []', ''].join('\n');

    const raw = parser.parseYAML(yaml);

    try {
      validator.validate(raw);
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((err as CogniPipeError).message).toContain('"steps"');
    }
    expect(validateSpy).toHaveBeenCalledWith(raw);
  });

  it('throws WORKFLOW_VALIDATION_ERROR with "steps[0].name" in the message for an uppercase step name', () => {
    expect.assertions(4);
    const yaml = [
      'name: bad-step-name-workflow',
      'version: "1.0.0"',
      'steps:',
      '  - name: BadName',
      '    uses: "@cognipipe/node-http"',
      '',
    ].join('\n');

    const raw = parser.parseYAML(yaml);

    try {
      validator.validate(raw);
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((err as CogniPipeError).message).toContain('"steps[0].name"');
    }
    expect(validateSpy).toHaveBeenCalledWith(raw);
  });

  it('throws WORKFLOW_VALIDATION_ERROR with "steps[0].name" in the message when a step uses id instead of name', () => {
    expect.assertions(4);
    const json = JSON.stringify({
      name: 'id-instead-of-name-workflow',
      version: '1.0.0',
      steps: [{ id: 'fetch-data', uses: '@cognipipe/node-http' }],
    });

    // parseJSON is schema-agnostic: it returns the object with `id` verbatim — the
    // missing `name` is only caught once validate() runs the Zod schema.
    const raw = parser.parseJSON(json);

    try {
      validator.validate(raw);
    } catch (err) {
      expect(isCogniPipeError(err)).toBe(true);
      expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((err as CogniPipeError).message).toContain('"steps[0].name"');
    }
    expect(validateSpy).toHaveBeenCalledWith(raw);
  });
});

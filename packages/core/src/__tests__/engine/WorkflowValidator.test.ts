import { WorkflowValidator } from '../../engine/WorkflowValidator';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

const validator = new WorkflowValidator();

/** A minimal valid workflow object used as a baseline across tests. */
const validWorkflow = {
  name: 'my-workflow',
  version: '1.0.0',
  steps: [
    {
      name: 'fetch-data',
      uses: '@cognipipe/node-http',
    },
  ],
};

describe('WorkflowValidator', () => {
  describe('happy path', () => {
    it('returns a typed WorkflowConfig for a minimal valid config (name + version + one step with name + uses)', () => {
      const result = validator.validate(validWorkflow);

      expect(result.name).toBe('my-workflow');
      expect(result.version).toBe('1.0.0');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({ name: 'fetch-data', uses: '@cognipipe/node-http' });
    });

    it('accepts a full config with all optional fields (description, dependsOn, continueOnError, retry)', () => {
      const input = {
        name: 'my-workflow',
        version: '1.0.0',
        description: 'Fetches data and forwards it downstream',
        steps: [
          {
            name: 'fetch-data',
            uses: '@cognipipe/node-http',
            config: { url: 'https://example.com' },
            dependsOn: [],
            continueOnError: true,
            retry: { attempts: 3, delayMs: 1000, backoff: 'exponential' as const },
          },
        ],
      };

      const result = validator.validate(input);

      expect(result.description).toBe('Fetches data and forwards it downstream');
      expect(result.steps[0].continueOnError).toBe(true);
      expect(result.steps[0].retry).toMatchObject({
        attempts: 3,
        delayMs: 1000,
        backoff: 'exponential',
      });
    });

    it('fills in an empty object for config when the step has no config field (Zod default)', () => {
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch-data', uses: '@cognipipe/node-http' }],
      };

      const result = validator.validate(input);

      expect(result.steps[0].config).toEqual({});
    });

    it('accepts a step with config: {} explicitly set', () => {
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch-data', uses: '@cognipipe/node-http', config: {} }],
      };

      const result = validator.validate(input);

      expect(result.steps[0].config).toEqual({});
    });

    it('accepts multiple steps in sequence', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'step-a', uses: '@cognipipe/node-http' },
          { name: 'step-b', uses: '@cognipipe/node-openai' },
          { name: 'step-c', uses: '@cognipipe/node-slack' },
        ],
      };

      const result = validator.validate(input);

      expect(result.steps).toHaveLength(3);
      expect(result.steps.map(s => s.name)).toEqual(['step-a', 'step-b', 'step-c']);
    });

    it('accepts a workflow where description is omitted (it is optional)', () => {
      const input = { name: 'my-workflow', version: '1.0.0', steps: validWorkflow.steps };

      expect(() => validator.validate(input)).not.toThrow();
    });

    it('accepts a step with dependsOn: [] (empty array)', () => {
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch-data', uses: '@cognipipe/node-http', dependsOn: [] }],
      };

      const result = validator.validate(input);

      expect(result.steps[0].dependsOn).toEqual([]);
    });

    it('accepts a step where retry.backoff is omitted (it is optional)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          {
            name: 'fetch-data',
            uses: '@cognipipe/node-http',
            retry: { attempts: 3, delayMs: 500 },
          },
        ],
      };

      expect(() => validator.validate(input)).not.toThrow();
    });
  });

  describe('WorkflowConfig top-level failures', () => {
    it('throws with "name" in the message when name is an empty string', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, name: '' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'name' });
      }
    });

    it('throws with "name" in the message when the name key is missing entirely', () => {
      expect.assertions(4);
      const input = { version: '1.0.0', steps: validWorkflow.steps };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'name' });
      }
    });

    it('throws with "version" in the message when version is missing', () => {
      expect.assertions(4);
      const input = { name: 'my-workflow', steps: validWorkflow.steps };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"version"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'version' });
      }
    });

    it('throws with "version" in the message for a two-part version string ("1.0")', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, version: '1.0' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"version"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'version' });
      }
    });

    it('throws with "version" in the message for a "v"-prefixed version string ("v1.0.0")', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, version: 'v1.0.0' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"version"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'version' });
      }
    });

    it('throws with "version" in the message for a version with a pre-release tag ("1.0.0-alpha")', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, version: '1.0.0-alpha' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"version"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'version' });
      }
    });

    it('throws with "steps" in the message when steps is an empty array', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, steps: [] };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps' });
      }
    });

    it('throws with "steps" in the message when steps is missing', () => {
      expect.assertions(4);
      const input = { name: 'my-workflow', version: '1.0.0' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps' });
      }
    });
  });

  describe('StepConfig failures', () => {
    it('throws with "steps[0].name" and "FetchData" in the message when the step name is uppercase', () => {
      expect.assertions(5);
      const input = {
        ...validWorkflow,
        steps: [{ name: 'FetchData', uses: '@cognipipe/node-http' }],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).message).toContain('FetchData');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].name" in the message when the step name starts with a digit ("1-fetch")', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [{ name: '1-fetch', uses: '@cognipipe/node-http' }],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].name" in the message when the step name contains a space ("fetch data")', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch data', uses: '@cognipipe/node-http' }],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].name" in the message when the step name has mixed case after an underscore ("fetch_Data")', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch_Data', uses: '@cognipipe/node-http' }],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].name" in the message when the step name is an empty string', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, steps: [{ name: '', uses: '@cognipipe/node-http' }] };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].name" in the message when the step name key is missing', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, steps: [{ uses: '@cognipipe/node-http' }] };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].name' });
      }
    });

    it('throws with "steps[0].uses" in the message when uses is an empty string', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, steps: [{ name: 'fetch-data', uses: '' }] };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].uses"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].uses' });
      }
    });

    it('throws with "steps[0].uses" in the message when the uses key is missing', () => {
      expect.assertions(4);
      const input = { ...validWorkflow, steps: [{ name: 'fetch-data' }] };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].uses"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].uses' });
      }
    });

    it('throws with "steps[1].name" in the message when the second step has an invalid name (array index is correct)', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'step-a', uses: '@cognipipe/node-http' },
          { name: 'BAD', uses: '@cognipipe/node-http' },
        ],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[1].name"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[1].name' });
      }
    });

    it('throws with "steps[0].dependsOn" in the message when dependsOn is an array of numbers instead of strings', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [{ name: 'fetch-data', uses: '@cognipipe/node-http', dependsOn: [123] }],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].dependsOn');
        expect(String((err as CogniPipeError).context?.['path'])).toContain('steps[0].dependsOn');
      }
    });
  });

  describe('RetryConfig', () => {
    it('accepts retry.attempts: 1 (minimum boundary — inclusive)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 1, delayMs: 0 } },
        ],
      };

      expect(() => validator.validate(input)).not.toThrow();
    });

    it('accepts retry.attempts: 10 (maximum boundary — inclusive)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 10, delayMs: 0 } },
        ],
      };

      expect(() => validator.validate(input)).not.toThrow();
    });

    it('accepts retry.delayMs: 0 (minimum boundary — inclusive)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 1, delayMs: 0 } },
        ],
      };

      expect(() => validator.validate(input)).not.toThrow();
    });

    it('throws with "steps[0].retry.attempts" in the message when retry.attempts is 0 (below minimum)', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 0, delayMs: 0 } },
        ],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].retry.attempts"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].retry.attempts' });
      }
    });

    it('throws with "steps[0].retry.attempts" in the message when retry.attempts is 11 (above maximum)', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 11, delayMs: 0 } },
        ],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].retry.attempts"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].retry.attempts' });
      }
    });

    it('throws with "steps[0].retry.delayMs" in the message when retry.delayMs is -1', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'fetch-data', uses: '@cognipipe/node-http', retry: { attempts: 1, delayMs: -1 } },
        ],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].retry.delayMs"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].retry.delayMs' });
      }
    });

    it('throws with "steps[0].retry.backoff" in the message when retry.backoff is an invalid enum value ("quadratic")', () => {
      expect.assertions(4);
      const input = {
        ...validWorkflow,
        steps: [
          {
            name: 'fetch-data',
            uses: '@cognipipe/node-http',
            retry: { attempts: 1, delayMs: 0, backoff: 'quadratic' },
          },
        ],
      };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect((err as CogniPipeError).message).toContain('"steps[0].retry.backoff"');
        expect((err as CogniPipeError).context).toMatchObject({ path: 'steps[0].retry.backoff' });
      }
    });
  });

  describe('input type failures', () => {
    it('throws CogniPipeError — not a raw TypeError or ZodError — for null', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate(null);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });

    it('throws CogniPipeError — not a raw TypeError or ZodError — for undefined', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate(undefined);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });

    it('throws CogniPipeError — not a raw TypeError or ZodError — for a plain string', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate('not-a-workflow');
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });

    it('throws CogniPipeError — not a raw TypeError or ZodError — for a number', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate(42);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });

    it('throws CogniPipeError — not a raw TypeError or ZodError — for an array instead of an object', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate([]);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });

    it('throws CogniPipeError — not a raw TypeError or ZodError — for a boolean', () => {
      expect.assertions(2);
      let thrown: unknown;

      try {
        validator.validate(true);
      } catch (err) {
        thrown = err;
      }

      expect(isCogniPipeError(thrown)).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
    });
  });

  describe('error structure', () => {
    it('produces a fully-shaped, serialisable CogniPipeError for a representative failure', () => {
      expect.assertions(6);
      // Representative failing input: empty top-level name. Chosen because it produces
      // a non-undefined `received` value, so the full context shape can be asserted.
      const input = { ...validWorkflow, name: '' };

      try {
        validator.validate(input);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect(err instanceof Error).toBe(true);
        expect((err as CogniPipeError).name).toBe('CogniPipeError');
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
        expect(Object.keys((err as CogniPipeError).context ?? {})).toEqual(
          expect.arrayContaining(['path', 'received']),
        );
        expect(() => JSON.stringify((err as CogniPipeError).toJSON())).not.toThrow();
      }
    });
  });
});

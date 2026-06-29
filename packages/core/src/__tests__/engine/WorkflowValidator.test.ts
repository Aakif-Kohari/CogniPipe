import { WorkflowValidator } from '../../engine/WorkflowValidator';
import { CogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

const validator = new WorkflowValidator();

/** A fully valid workflow object used as a baseline across tests. */
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
  describe('valid inputs', () => {
    it('returns a validated WorkflowConfig for a fully valid object', () => {
      const result = validator.validate(validWorkflow);

      expect(result.name).toBe('my-workflow');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe('fetch-data');
    });

    it('accepts a workflow where description is omitted (it is optional)', () => {
      const input = { name: 'my-workflow', version: '1.0.0', steps: validWorkflow.steps };

      expect(() => validator.validate(input)).not.toThrow();
    });

    it('accepts a step where dependsOn references another step name', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'step-a', uses: '@cognipipe/node-http' },
          { name: 'step-b', uses: '@cognipipe/node-http', dependsOn: ['step-a'] },
        ],
      };

      expect(() => validator.validate(input)).not.toThrow();
    });
  });

  describe('top-level field failures', () => {
    it('throws CogniPipeError with WORKFLOW_VALIDATION_ERROR when name is missing', () => {
      const input = { version: '1.0.0', steps: validWorkflow.steps };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((thrown as CogniPipeError).message).toContain('"name"');
    });

    it('throws CogniPipeError with "steps" in the message when steps is missing', () => {
      const input = { name: 'my-workflow', version: '1.0.0' };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.WORKFLOW_VALIDATION_ERROR);
      expect((thrown as CogniPipeError).message).toContain('"steps"');
    });

    it('throws CogniPipeError with "steps" in the message when steps is an empty array', () => {
      const input = { name: 'my-workflow', version: '1.0.0', steps: [] };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).message).toContain('"steps"');
    });

    it('throws with "version" in the message for a non-semver version string', () => {
      const input = { ...validWorkflow, version: '1.0' };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).message).toContain('"version"');
    });
  });

  describe('step-level field failures', () => {
    it('throws with "steps[0].name" and "MyStep" in the message when step name is uppercase', () => {
      const input = {
        ...validWorkflow,
        steps: [{ name: 'MyStep', uses: '@cognipipe/node-http' }],
      };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).message).toContain('"steps[0].name"');
      expect((thrown as CogniPipeError).message).toContain('MyStep');
    });

    it('throws with "steps[0].name" in the message when step name starts with a number', () => {
      const input = {
        ...validWorkflow,
        steps: [{ name: '1-invalid', uses: '@cognipipe/node-http' }],
      };
      let thrown: unknown;

      try {
        validator.validate(input);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect((thrown as CogniPipeError).message).toContain('"steps[0].name"');
    });
  });

  describe('retry config failures', () => {
    it('throws CogniPipeError when retry.attempts is 0 (minimum is 1)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'step-a', uses: '@cognipipe/node-http', retry: { attempts: 0, delayMs: 0 } },
        ],
      };

      expect(() => validator.validate(input)).toThrow(CogniPipeError);
    });

    it('throws CogniPipeError when retry.attempts is 11 (maximum is 10)', () => {
      const input = {
        ...validWorkflow,
        steps: [
          { name: 'step-a', uses: '@cognipipe/node-http', retry: { attempts: 11, delayMs: 0 } },
        ],
      };

      expect(() => validator.validate(input)).toThrow(CogniPipeError);
    });
  });

  describe('non-object inputs', () => {
    it('throws CogniPipeError — not TypeError — for null input', () => {
      let thrown: unknown;

      try {
        validator.validate(null);
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect(thrown instanceof TypeError).toBe(false);
    });

    it('throws CogniPipeError — not TypeError — for a plain string input', () => {
      let thrown: unknown;

      try {
        validator.validate('not-a-workflow');
      } catch (err) {
        thrown = err;
      }

      expect(thrown instanceof CogniPipeError).toBe(true);
      expect(thrown instanceof TypeError).toBe(false);
    });
  });
});

import { z } from 'zod';
import { CogniPipeError, isCogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { defineConfig } from '../defineConfig';

describe('defineConfig', () => {
  describe('happy path', () => {
    it('parses a valid config and returns the typed result', () => {
      const Config = defineConfig(z.object({ url: z.string() }));

      const result = Config.parse({ url: 'https://example.com' });

      expect(result).toEqual({ url: 'https://example.com' });
    });

    it('applies Zod defaults for omitted fields', () => {
      const Config = defineConfig(z.object({ n: z.number().default(5000) }));

      const result = Config.parse({});

      expect(result).toEqual({ n: 5000 });
    });

    it('exposes the exact schema instance passed in via .schema', () => {
      const mySchema = z.object({ url: z.string() });
      const Config = defineConfig(mySchema);

      expect(Config.schema).toBe(mySchema);
    });

    it('produces independent parsers for two different defineConfig() calls', () => {
      const ConfigA = defineConfig(z.object({ a: z.string() }));
      const ConfigB = defineConfig(z.object({ b: z.number() }));

      const resultA = ConfigA.parse({ a: 'hello' });

      expect(resultA).toEqual({ a: 'hello' });
      expect(() => ConfigB.parse({ a: 'hello' })).toThrow(CogniPipeError);
    });

    it('returns an object with both .parse (function) and .schema (object) properties', () => {
      const Config = defineConfig(z.object({ url: z.string() }));

      expect(typeof Config.parse).toBe('function');
      expect(typeof Config.schema).toBe('object');
    });
  });

  describe('error cases', () => {
    it('throws NODE_CONFIG_INVALID with "url" in the message when a required field is missing', () => {
      expect.assertions(3);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse({});
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        expect((err as CogniPipeError).message).toContain('url');
      }
    });

    it('throws NODE_CONFIG_INVALID with "url" in the message on a type mismatch', () => {
      expect.assertions(3);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse({ url: 123 });
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
        expect((err as CogniPipeError).message).toContain('url');
      }
    });

    it('formats a nested object failure as "nested.count" in the message', () => {
      expect.assertions(1);
      const Config = defineConfig(z.object({ nested: z.object({ count: z.number() }) }));

      try {
        Config.parse({ nested: { count: 'string' } });
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('nested.count');
      }
    });

    it('formats an array index failure as "items[1]" in the message', () => {
      expect.assertions(1);
      const Config = defineConfig(z.object({ items: z.array(z.number()) }));

      try {
        Config.parse({ items: [1, 'bad'] });
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('items[1]');
      }
    });

    it('throws CogniPipeError(NODE_CONFIG_INVALID), not a raw ZodError, when raw is null', () => {
      expect.assertions(2);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse(null);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('throws CogniPipeError(NODE_CONFIG_INVALID) when raw is undefined', () => {
      expect.assertions(2);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse(undefined);
      } catch (err) {
        expect(isCogniPipeError(err)).toBe(true);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('includes "path" and "received" in err.context for a type-mismatch failure', () => {
      expect.assertions(3);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse({ url: 123 });
      } catch (err) {
        expect((err as CogniPipeError).context).toHaveProperty('path', 'url');
        expect((err as CogniPipeError).context).toHaveProperty('received', 123);
        expect((err as CogniPipeError).context).toBeDefined();
      }
    });

    it('includes "path" and "received" in err.context when raw is null (root-level failure)', () => {
      expect.assertions(2);
      const Config = defineConfig(z.object({ url: z.string() }));

      try {
        Config.parse(null);
      } catch (err) {
        expect((err as CogniPipeError).context).toHaveProperty('path', '');
        expect((err as CogniPipeError).context).toHaveProperty('received', null);
      }
    });
  });
});

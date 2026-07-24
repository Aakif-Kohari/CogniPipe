/**
 * @module WorkflowParser
 *
 * WorkflowParser reads workflow definition files (.yaml, .yml, .json) from disk
 * or from raw strings and parses them into plain unknown JavaScript objects.
 * This module has zero knowledge of WorkflowConfig's shape — it produces `unknown`
 * and delegates all structural validation to WorkflowValidator.
 *
 * @example
 * ```typescript
 * const parser = new WorkflowParser();
 * const validator = new WorkflowValidator();
 *
 * const raw = await parser.parseFile('./workflow.yaml'); // → unknown
 * const config = validator.validate(raw);                // → WorkflowConfig
 * ```
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { load as loadYAML } from 'js-yaml';
import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';

/** File extensions accepted by WorkflowParser.parseFile(). */
export const SUPPORTED_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/** Union of accepted file extension strings. */
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/**
 * Minimal shape of a Node.js filesystem error. Defined locally instead of
 * referencing the global `NodeJS.ErrnoException` ambient type, which trips
 * this repo's `no-undef` rule (core ESLint doesn't resolve TS ambient globals).
 */
interface FsErrnoException extends Error {
  code?: string;
}

/**
 * Type guard narrowing an unknown thrown value to an {@link FsErrnoException},
 * so `.code` (e.g. 'ENOENT') can be read safely without an `any` cast.
 */
function isErrnoException(err: unknown): err is FsErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Shared empty-content message used by parseYAML, parseJSON, and parseFile. */
function emptyContentMessage(source: string): string {
  return `Workflow file is empty: "${source}". A valid workflow must have at least a name, version, and one step.`;
}

/**
 * Reads workflow definition files (.yaml, .yml, .json) from disk or raw strings
 * and parses them into plain unknown JavaScript objects. Has zero knowledge of
 * WorkflowConfig's shape — pass the result to WorkflowValidator.validate() next.
 *
 * @example
 * ```typescript
 * const parser = new WorkflowParser();
 * const validator = new WorkflowValidator();
 *
 * const raw = await parser.parseFile('/path/to/workflow.yaml');
 * const config = validator.validate(raw);
 * ```
 */
export class WorkflowParser {
  /**
   * Reads a workflow file from disk and parses it based on its extension.
   * Supports .yaml, .yml, and .json.
   *
   * @param filePath - Absolute or relative path to the workflow file.
   * @returns The parsed content as `unknown`. Pass to WorkflowValidator.validate() next.
   * @throws {CogniPipeError} WORKFLOW_PARSE_ERROR if:
   *   - The file extension is not .yaml, .yml, or .json
   *   - The file does not exist or cannot be read
   *   - The file content is empty or whitespace-only
   *   - The YAML or JSON is syntactically invalid
   *   - The YAML document parses to null (empty document)
   *
   * @example
   * ```typescript
   * const raw = await parser.parseFile('/path/to/workflow.yaml');
   * const config = validator.validate(raw);
   * ```
   */
  async parseFile(filePath: string): Promise<unknown> {
    const ext = extname(filePath).toLowerCase();

    if (!SUPPORTED_EXTENSIONS.includes(ext as SupportedExtension)) {
      throw new CogniPipeError(
        `Unsupported workflow file extension "${ext}". Expected one of: ${SUPPORTED_EXTENSIONS.join(
          ', ',
        )}. Got: "${filePath}"`,
        { code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR },
      );
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        throw new CogniPipeError(
          `Workflow file not found: "${filePath}". Check the path and try again.`,
          { code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR, cause: err },
        );
      }

      throw new CogniPipeError(`Failed to read workflow file "${filePath}".`, {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
        cause: err instanceof Error ? err : undefined,
      });
    }

    return ext === '.json' ? this.parseJSON(content, filePath) : this.parseYAML(content, filePath);
  }

  /**
   * Parses a raw YAML string without reading from disk.
   * Useful for testing, stdin input, or remote workflow sources.
   *
   * @param content - Raw YAML string.
   * @param source - Label used in error messages to identify the input origin.
   *   Defaults to '<input>'. Pass the file path when calling from parseFile().
   * @returns The parsed content as `unknown`.
   * @throws {CogniPipeError} WORKFLOW_PARSE_ERROR if content is empty,
   *   syntactically invalid YAML, or parses to null.
   */
  parseYAML(content: string, source = '<input>'): unknown {
    if (content.trim() === '') {
      throw new CogniPipeError(emptyContentMessage(source), {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
      });
    }

    let parsed: unknown;
    try {
      parsed = loadYAML(content);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new CogniPipeError(
        `Failed to parse YAML from "${source}": ${cause?.message ?? String(err)}`,
        { code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR, cause },
      );
    }

    if (parsed === null) {
      throw new CogniPipeError(emptyContentMessage(source), {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
      });
    }

    return parsed;
  }

  /**
   * Parses a raw JSON string without reading from disk.
   * Useful for testing or reading from API responses.
   *
   * @param content - Raw JSON string.
   * @param source - Label used in error messages. Defaults to '<input>'.
   * @returns The parsed content as `unknown`.
   * @throws {CogniPipeError} WORKFLOW_PARSE_ERROR if content is empty,
   *   syntactically invalid JSON, or parses to null.
   */
  parseJSON(content: string, source = '<input>'): unknown {
    if (content.trim() === '') {
      throw new CogniPipeError(emptyContentMessage(source), {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw new CogniPipeError(
        `Failed to parse JSON from "${source}": ${cause?.message ?? String(err)}`,
        { code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR, cause },
      );
    }

    if (parsed === null) {
      throw new CogniPipeError(emptyContentMessage(source), {
        code: COGNIPIPE_ERROR_CODES.WORKFLOW_PARSE_ERROR,
      });
    }

    return parsed;
  }
}

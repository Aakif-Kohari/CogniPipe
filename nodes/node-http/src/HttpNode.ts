/**
 * @module HttpNode
 *
 * Generic HTTP node for CogniPipe workflows.
 * Supports GET, POST, PUT, DELETE, PATCH with configurable headers, body, and timeout.
 * Uses Node.js 22's built-in fetch — no external HTTP library required.
 */

import type { IExecutionContext, NodeConfig, NodeOutput } from '@cognipipe/types';
import { BaseNode, CogniNode } from '@cognipipe/sdk';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';
import { z } from 'zod';

/**
 * Zod schema for HttpNode config.
 * Zod v4 requires TWO type arguments for z.record(): keyType and valueType.
 */
const HttpNodeConfigSchema = z.object({
  /** Target URL — must be a valid http or https URL. */
  url: z.string().url('url must be a valid http or https URL'),
  /** HTTP method. Defaults to GET when omitted. */
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET'),
  /** Request headers as key-value string pairs. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Request body as a serialised string. Ignored for GET and DELETE. */
  body: z.string().optional(),
  /** Request timeout in milliseconds. Minimum 100ms, maximum 30,000ms. */
  timeout: z.number().int().min(100).max(30_000).default(5_000),
});

// type HttpNodeConfig = z.infer<typeof HttpNodeConfigSchema>;

/** Shape of the output stored in ExecutionContext after a successful HTTP step. */
export interface HttpNodeOutput extends NodeOutput {
  /** HTTP status code, e.g. 200, 404, 500. */
  status: number;
  /** HTTP status text, e.g. "OK", "Not Found". */
  statusText: string;
  /** true when status is 200–299. */
  ok: boolean;
  /** Response headers as a plain key-value object. */
  headers: Record<string, string>;
  /**
   * Response body. Parsed as JSON when Content-Type contains "application/json",
   * returned as a raw string otherwise.
   */
  body: unknown;
}

/**
 * Generic HTTP node for CogniPipe workflows.
 * Supports GET, POST, PUT, DELETE, and PATCH with configurable headers,
 * body, and timeout. Uses Node.js 22's built-in fetch — no external library.
 *
 * @example
 * ```yaml
 * steps:
 *   - name: fetch-data
 *     uses: '@cognipipe/node-http'
 *     config:
 *       url: 'https://api.example.com/data'
 *       method: GET
 *       timeout: 10000
 * ```
 */
@CogniNode({ type: '@cognipipe/node-http', version: '1.0.0' })
export class HttpNode extends BaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<HttpNodeOutput> {
    const { url, method, headers, body, timeout } = this.validateConfig(
      HttpNodeConfigSchema,
      config,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions = {
        method,
        headers,
        signal: controller.signal,
      } as NonNullable<Parameters<typeof fetch>[1]>;
      if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
        fetchOptions.body = body;
      }

      const response = await fetch(url, fetchOptions);

      const contentType = response.headers.get('content-type') ?? '';
      const parsedBody: unknown = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsedBody,
      };
    } catch (err) {
      // AbortController fires a DOMException with name 'AbortError' on timeout
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new CogniPipeError(`HTTP request to "${url}" timed out after ${timeout}ms.`, {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { url, method, timeout },
        });
      }

      throw new CogniPipeError(
        `HTTP request to "${url}" failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED,
          context: { url, method },
          cause: err instanceof Error ? err : undefined,
        },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

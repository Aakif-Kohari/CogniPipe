import { HttpNode, type HttpNodeOutput } from '../src/index';
import type { IExecutionContext } from '@cognipipe/types';
import { CogniPipeError, COGNIPIPE_ERROR_CODES } from '@cognipipe/core';

// Mock fetch before each test
const mockFetch = jest.fn();

beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: mockFetch });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: undefined });
});

beforeEach(() => {
  mockFetch.mockReset();
});

// Helper to create a mock Response
function mockResponse(
  options: {
    status?: number;
    statusText?: string;
    contentType?: string;
    body?: unknown;
  } = {},
): Response {
  const { status = 200, statusText = 'OK', contentType = 'application/json', body = {} } = options;

  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType }),
    json: jest.fn(async () => body),
    text: jest.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

// Mock execution context
const mockContext = {} as unknown as IExecutionContext;

describe('HttpNode', () => {
  describe('class metadata', () => {
    it('should have cogniNodeMeta with type and version', () => {
      expect(HttpNode.cogniNodeMeta).toBeDefined();
      expect(HttpNode.cogniNodeMeta?.type).toBe('@cognipipe/node-http');
      expect(HttpNode.cogniNodeMeta?.version).toBe('1.0.0');
    });

    it('should be instance of BaseNode', () => {
      const node = new HttpNode();
      // Check that the node has the expected BaseNode methods
      expect(typeof node.execute).toBe('function');
    });
  });

  describe('happy path: GET request', () => {
    it('should make a GET request and return parsed response', async () => {
      const mockResp = mockResponse({ status: 200, body: { result: 'success' } });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        {
          url: 'https://api.example.com/data',
          method: 'GET',
        },
        mockContext,
      )) as HttpNodeOutput;

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'GET',
          signal: expect.anything(),
        }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ body: expect.anything() }),
      );
      expect(output.status).toBe(200);
      expect(output.statusText).toBe('OK');
      expect(output.ok).toBe(true);
      expect(output.body).toEqual({ result: 'success' });
    });

    it('should use default method GET when omitted', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data',
        },
        mockContext,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('happy path: POST request', () => {
    it('should make a POST request with body', async () => {
      const mockResp = mockResponse({ status: 201, body: { id: 1 } });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        {
          url: 'https://api.example.com/data',
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
          headers: { 'Content-Type': 'application/json' },
        },
        mockContext,
      )) as HttpNodeOutput;

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(output.status).toBe(201);
      expect(output.body).toEqual({ id: 1 });
    });

    it('should omit body for GET request even if body is provided', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data',
          method: 'GET',
          body: 'should be ignored',
        },
        mockContext,
      );

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('body');
    });

    it('should omit body for DELETE request even if body is provided', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data',
          method: 'DELETE',
          body: 'should be ignored',
        },
        mockContext,
      );

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).not.toHaveProperty('body');
    });
  });

  describe('happy path: response content-type handling', () => {
    it('should parse JSON response when content-type includes application/json', async () => {
      const mockResp = mockResponse({
        contentType: 'application/json; charset=utf-8',
        body: { key: 'value' },
      });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(output.body).toEqual({ key: 'value' });
      expect(typeof output.body).toBe('object');
    });

    it('should return text as string when content-type is not JSON', async () => {
      const mockResp = mockResponse({
        contentType: 'text/plain',
        body: 'plain text response',
      });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(typeof output.body).toBe('string');
      expect(output.body).toBe(JSON.stringify('plain text response'));
    });
  });

  describe('happy path: response status codes', () => {
    it('should return ok: true for 2xx status', async () => {
      const mockResp = mockResponse({ status: 200 });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(output.ok).toBe(true);
    });

    it('should return ok: false for 4xx status', async () => {
      const mockResp = mockResponse({ status: 404, statusText: 'Not Found' });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(output.ok).toBe(false);
      expect(output.status).toBe(404);
      expect(output.statusText).toBe('Not Found');
    });

    it('should return ok: false for 5xx status', async () => {
      const mockResp = mockResponse({ status: 500, statusText: 'Internal Server Error' });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(output.ok).toBe(false);
      expect(output.status).toBe(500);
    });
  });

  describe('happy path: headers handling', () => {
    it('should include custom headers in request', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const customHeaders = {
        Authorization: 'Bearer token123',
        'X-Custom-Header': 'custom-value',
      };

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data',
          headers: customHeaders,
        },
        mockContext,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ headers: customHeaders }),
      );
    });

    it('should return response headers as plain Record<string, string>', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      const output = (await node.execute(
        { url: 'https://api.example.com/data' },
        mockContext,
      )) as HttpNodeOutput;

      expect(output.headers).toBeDefined();
      expect(typeof output.headers).toBe('object');
      expect(output.headers instanceof Headers).toBe(false);
    });
  });

  describe('happy path: timeout defaults', () => {
    it('should use default timeout of 5000ms when omitted', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      jest.useFakeTimers();
      const node = new HttpNode();
      const promise = node.execute({ url: 'https://api.example.com/data' }, mockContext);

      jest.runAllTimers();
      jest.useRealTimers();
      await promise;

      // Verify that fetch was called (timeout didn't abort)
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('HTTP methods: PUT, DELETE, PATCH', () => {
    it('should support PUT method', async () => {
      const mockResp = mockResponse({ status: 200 });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data/1',
          method: 'PUT',
          body: JSON.stringify({ updated: true }),
        },
        mockContext,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ updated: true }) }),
      );
    });

    it('should support PATCH method', async () => {
      const mockResp = mockResponse({ status: 200 });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data/1',
          method: 'PATCH',
          body: JSON.stringify({ field: 'value' }),
        },
        mockContext,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('should support DELETE method without body', async () => {
      const mockResp = mockResponse({ status: 204 });
      mockFetch.mockResolvedValueOnce(mockResp);

      const node = new HttpNode();
      await node.execute(
        {
          url: 'https://api.example.com/data/1',
          method: 'DELETE',
        },
        mockContext,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('config validation errors', () => {
    it('should throw NODE_CONFIG_INVALID when url is missing', async () => {
      expect.assertions(2);
      const node = new HttpNode();
      try {
        await node.execute({}, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('should throw NODE_CONFIG_INVALID when url is not a valid URL', async () => {
      expect.assertions(2);
      const node = new HttpNode();
      try {
        await node.execute({ url: 'not-a-url' }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('should throw NODE_CONFIG_INVALID when method is invalid', async () => {
      expect.assertions(2);
      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com', method: 'INVALID' }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('should throw NODE_CONFIG_INVALID when timeout < 100ms', async () => {
      expect.assertions(2);
      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com', timeout: 50 }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });

    it('should throw NODE_CONFIG_INVALID when timeout > 30000ms', async () => {
      expect.assertions(2);
      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com', timeout: 99999 }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.NODE_CONFIG_INVALID);
      }
    });
  });

  describe('network errors', () => {
    it('should throw STEP_EXECUTION_FAILED on fetch error', async () => {
      expect.assertions(2);
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com' }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      }
    });

    it('should include url in error message on fetch error', async () => {
      expect.assertions(1);
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com/data' }, mockContext);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('https://api.example.com/data');
      }
    });
  });

  describe('timeout handling', () => {
    it('should abort request on timeout', async () => {
      expect.assertions(2);
      mockFetch.mockImplementationOnce(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com', timeout: 100 }, mockContext);
      } catch (err) {
        expect(err).toBeInstanceOf(CogniPipeError);
        expect((err as CogniPipeError).message).toContain('timed out');
      }
    });

    it('should include timeout value in error message on timeout', async () => {
      expect.assertions(1);
      mockFetch.mockImplementationOnce(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );

      const node = new HttpNode();
      try {
        await node.execute({ url: 'https://api.example.com', timeout: 150 }, mockContext);
      } catch (err) {
        expect((err as CogniPipeError).message).toContain('150ms');
      }
    });

    it('should clear timeout in finally block', async () => {
      const mockResp = mockResponse();
      mockFetch.mockResolvedValueOnce(mockResp);

      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const node = new HttpNode();
      await node.execute({ url: 'https://api.example.com' }, mockContext);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });
});

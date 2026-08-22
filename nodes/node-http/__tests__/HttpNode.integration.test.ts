import { HttpNode, type HttpNodeOutput } from '../src/index';
import type { IExecutionContext, NodeConfig } from '@cognipipe/types';

const mockFetch = jest.fn();
const mockContext = {} as IExecutionContext;

beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: mockFetch });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'fetch', { writable: true, value: undefined });
});

beforeEach(() => {
  mockFetch.mockReset();
});

function mockResponse({
  status = 200,
  statusText = 'OK',
  contentType = 'application/json',
  body = {},
  headers = {},
}: {
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Response {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType, ...headers }),
    json: jest.fn(async () => body),
    text: jest.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body))),
  } as unknown as Response;
}

async function execute(config: NodeConfig): Promise<HttpNodeOutput> {
  return new HttpNode().execute(config, mockContext);
}

describe('HttpNode integration request/response cycles', () => {
  it('returns the complete GET output shape for downstream consumption', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: { someField: 'ready', items: [{ id: 7 }] },
        headers: { 'x-request-id': 'req-42' },
      }),
    );

    const output = await execute({
      url: 'https://api.example.com/resources',
      method: 'GET',
      headers: {
        Authorization: 'Bearer workflow-token',
        'X-Trace-Id': 'workflow-42',
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/resources',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer workflow-token',
          'X-Trace-Id': 'workflow-42',
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(output).toEqual({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-42',
      },
      body: { someField: 'ready', items: [{ id: 7 }] },
    });
    expect((output.body as { someField: string }).someField).toBe('ready');
  });

  it('sends and parses a complete JSON POST cycle', async () => {
    const requestBody = JSON.stringify({ name: 'Ada', role: 'admin' });
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 201,
        statusText: 'Created',
        body: { id: 'user-9', created: true },
      }),
    );

    const output = await execute({
      url: 'https://api.example.com/users',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/users',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      }),
    );
    expect(output).toEqual({
      status: 201,
      statusText: 'Created',
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: { id: 'user-9', created: true },
    });
  });

  it('handles PUT then DELETE against the same resource without a DELETE body', async () => {
    const target = 'https://api.example.com/resources/7';
    mockFetch
      .mockResolvedValueOnce(mockResponse({ body: { id: 7, state: 'updated' } }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 204,
          statusText: 'No Content',
          contentType: 'text/plain',
          body: '',
        }),
      );

    const putOutput = await execute({
      url: target,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'updated' }),
    });
    const deleteOutput = await execute({
      url: target,
      method: 'DELETE',
      body: 'must-not-be-sent',
    });

    expect(mockFetch.mock.calls[0]).toEqual([
      target,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ state: 'updated' }),
      }),
    ]);
    const deleteRequest = mockFetch.mock.calls[1];
    expect(deleteRequest[0]).toBe(target);
    expect(deleteRequest[1]).not.toHaveProperty('body');
    expect(putOutput.body).toEqual({ id: 7, state: 'updated' });
    expect(deleteOutput).toEqual({
      status: 204,
      statusText: 'No Content',
      ok: true,
      headers: { 'content-type': 'text/plain' },
      body: '',
    });
  });

  it('keeps non-JSON response bodies as raw strings', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        contentType: 'text/plain; charset=utf-8',
        body: 'service is warming up',
      }),
    );

    const output = await execute({ url: 'https://api.example.com/health' });

    expect(output).toEqual({
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'service is warming up',
    });
  });

  it.each([
    [404, 'Not Found'],
    [503, 'Service Unavailable'],
  ])('returns HTTP %i as non-throwing output', async (status, statusText) => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status,
        statusText,
        body: { error: statusText },
      }),
    );

    await expect(execute({ url: 'https://api.example.com/failure' })).resolves.toEqual({
      status,
      statusText,
      ok: false,
      headers: { 'content-type': 'application/json' },
      body: { error: statusText },
    });
  });

  it('feeds a parsed GET field into a follow-up request config', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ body: { someField: 'source-17' } }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 202,
          statusText: 'Accepted',
          body: { queued: true },
        }),
      );

    const lookupOutput = await execute({
      url: 'https://api.example.com/lookup',
      method: 'GET',
    });
    const source = (lookupOutput.body as { someField: string }).someField;
    const followUpBody = JSON.stringify({ source });

    const followUpOutput = await execute({
      url: 'https://api.example.com/jobs',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: followUpBody,
    });

    expect(mockFetch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: '{"source":"source-17"}',
      }),
    );
    expect(followUpOutput.body).toEqual({ queued: true });
  });
});

# @cognipipe/node-http

Generic HTTP request node for CogniPipe workflows. Supports GET, POST, PUT, DELETE, and PATCH with configurable headers, body, and timeout.

Uses Node.js 22's built-in `fetch` — no external HTTP library required.

## Installation

```bash
pnpm add @cognipipe/node-http
```

## Usage

Add an HTTP step to your workflow:

```yaml
steps:
  - name: fetch-user
    uses: '@cognipipe/node-http'
    config:
      url: 'https://api.example.com/users/123'
      method: GET
      timeout: 10000

  - name: create-post
    uses: '@cognipipe/node-http'
    config:
      url: 'https://api.example.com/posts'
      method: POST
      headers:
        Content-Type: 'application/json'
        Authorization: 'Bearer {{ steps.get-token.output.token }}'
      body: '{"title":"Hello","content":"World"}'
      timeout: 15000
```

> **Note:** `node-http` does not currently read environment variables directly.
> If you need to inject a secret, either interpolate it from an upstream step's
> output (as shown above), or wait for a future node/feature that supports
> reading `process.env` directly (see `AiProviderConfig.apiKeyEnv` for the
> pattern used by AI provider nodes).

## Configuration

### `url` (required)

**Type:** `string`

The target URL. Must be a valid HTTP or HTTPS URL.

```yaml
config:
  url: 'https://api.example.com/data'
```

### `method` (optional)

**Type:** `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'`

**Default:** `'GET'`

HTTP method for the request.

```yaml
config:
  method: POST
```

### `headers` (optional)

**Type:** `Record<string, string>`

**Default:** `{}`

Request headers as key-value pairs. Supports interpolation with `{{ }}` syntax.

```yaml
config:
  headers:
    Authorization: 'Bearer {{ steps.get-token.output.token }}'
    Content-Type: 'application/json'
    X-Custom-Header: 'custom-value'
```

### `body` (optional)

**Type:** `string`

Request body. Ignored for GET and DELETE requests. Supports interpolation.

```yaml
config:
  method: POST
  body: '{"name":"{{ steps.upstream-step.output.name }}","active":true}'
```

### `timeout` (optional)

**Type:** `number`

**Default:** `5000`

Request timeout in milliseconds. Must be between 100 and 30,000.

```yaml
config:
  timeout: 10000
```

## Output

The node returns an object with the following shape:

```typescript
interface HttpNodeOutput {
  /** HTTP status code (e.g., 200, 404, 500) */
  status: number;

  /** HTTP status text (e.g., "OK", "Not Found") */
  statusText: string;

  /** true if status is 200–299, false otherwise */
  ok: boolean;

  /** Response headers as Record<string, string> */
  headers: Record<string, string>;

  /**
   * Response body.
   * Parsed as JSON if Content-Type includes "application/json",
   * otherwise returned as a string.
   */
  body: unknown;
}
```

### Example Usage

Reference the output in downstream steps:

```yaml
steps:
  - name: fetch-data
    uses: '@cognipipe/node-http'
    config:
      url: 'https://api.example.com/data'

  - name: log-result
    uses: '@cognipipe/node-log'
    config:
      message: 'Status: {{ steps.fetch-data.output.status }} — Body: {{ steps.fetch-data.output.body }}'
```

## Error Handling

The node throws `CogniPipeError` with code `STEP_EXECUTION_FAILED` for:

- Network failures (DNS, connection refused, etc.)
- Request timeouts
- Invalid configuration (caught before execution)

All errors include the target URL and method in the error context for debugging.

## Notes

- **No external dependencies:** Uses Node.js 22's built-in `fetch`.
- **Timeout safety:** Uses `AbortController` to cancel hung requests.
- **Content-type aware:** Automatically parses JSON responses based on Content-Type header.
- **Headers safety:** GET and DELETE requests never include a body, even if configured.

Copy this folder to `nodes/node-<service>`, then:

1. Rename `name`, `description`, `repository.directory` and `homepage` in `package.json`, the `type` in `@CogniNode()`, and the `MyNode` class/file.
2. Run `pnpm install` and commit the updated `pnpm-lock.yaml` (CI uses `--frozen-lockfile`).
3. Delete this block (everything above the title).

---

# @cognipipe/node-CHANGEME

<!-- Replace this with a one-line description of what this node does -->

## Installation

```bash
pnpm add @cognipipe/node-CHANGEME
```

## Usage

​```yaml
steps:

- name: my-step
  uses: '@cognipipe/node-CHANGEME'
  config:
  message: hello
  ​```

## Configuration

| Option    | Type     | Required | Description                  |
| --------- | -------- | -------- | ---------------------------- |
| `message` | `string` | ✅       | Non-empty text to echo back. |

## Output

| Field    | Type     | Description              |
| -------- | -------- | ------------------------ |
| `echoed` | `string` | The `message` you passed |

## Environment Variables

| Variable     | Description          |
| ------------ | -------------------- |
| `MY_API_KEY` | API key for CHANGEME |

## License

MIT © [Aakif Kohari](https://github.com/Aakif-Kohari)

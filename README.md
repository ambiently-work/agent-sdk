# @ambiently-work/agent-sdk

A TypeScript SDK for running LLM agent loops with typed tools, multiple provider backends, a workerd-based sandbox for untrusted tool code, and an opt-in planning layer for long-horizon work.

Target runtime is [Bun](https://bun.sh). The sandbox guest runs under [workerd](https://github.com/cloudflare/workerd) — via [`miniflare`](https://miniflare.dev) locally, or Cloudflare's Worker Loader binding when deployed inside a Worker.

## Install

```bash
bun add @ambiently-work/agent-sdk
```

Peer dep: `typescript ^5`. Zod, the MCP SDK, and provider SDKs (Ollama, Anthropic, Gemini, LM Studio, Codex) ship as direct dependencies.

## Quick start

```ts
import { z } from "zod";
import {
  Agent,
  OllamaProvider,
  Tool,
  ToolRegistry,
} from "@ambiently-work/agent-sdk";

class AddTool extends Tool<{ a: number; b: number }, number> {
  readonly id = "add";
  readonly description = "Add two numbers";
  readonly schema = z.object({ a: z.number(), b: z.number() });
  async run({ a, b }) {
    return { ok: true, value: a + b };
  }
}

const agent = new Agent(
  new OllamaProvider({ host: "http://localhost:11434" }),
  new ToolRegistry([new AddTool()]),
);

for await (const event of agent.run({
  model: "llama3.1",
  messages: [{ role: "user", content: "What is 2 + 3?" }],
})) {
  if (event.type === "assistant_text") console.log(event.text);
}
```

## Architecture

Four layers compose the SDK. Each is useful on its own.

### 1. Tools — `Tool`, `ToolRegistry`

- `Tool<I, O>` is an abstract class with `id`, `description`, a zod `schema`, and `run(inputs)` returning `ToolResult<O>`.
- `ToolRegistry` validates inputs against the schema and dispatches calls. Errors are returned, not thrown — `ToolResult<T> = { ok: true, value } | { ok: false, error }`.
- Error shapes are a discriminated `ToolError` union covering unknown tools, validation failures, tool failures, and every sandbox failure mode.

### 2. Providers — `Provider`, `Agent`

Streaming, tool-aware chat providers. Each exposes:

```ts
abstract class Provider {
  listModels(): Promise<ProviderResult<ModelInfo[]>>;
  run(input: RunInput): AsyncIterable<ProviderEvent>;
}
```

Events: `assistant_text_delta`, `assistant_text`, `tool_call`, `tool_result`, `done`, `error`. The provider runs the tool-use loop itself — it collects tool calls per turn, dispatches them via the supplied `ToolRegistry` (parallel by default, configurable via `parallelToolCalls`), feeds results back into chat history, and repeats until the model stops calling tools or `maxToolIterations` is hit (default 16).

Built-in providers:

| Provider               | Backend                          |
| ---------------------- | -------------------------------- |
| `OllamaProvider`       | `ollama` SDK                     |
| `ClaudeAgentProvider`  | `@anthropic-ai/claude-agent-sdk` |
| `GeminiProvider`       | `@google/genai`                  |
| `LMStudioProvider`     | `@lmstudio/sdk`                  |
| `CodexProvider`        | `@openai/codex-sdk`              |

`Agent` is a thin façade that pairs a `Provider` with a `ToolRegistry`. Two adapters work on the same registry:

- `toolRegistryToChatTools(registry)` → OpenAI/Ollama `{ type: "function", function: {...} }` specs.
- `toolRegistryToMcpServer(registry)` → a `@modelcontextprotocol/sdk` server exposing the same tools over MCP.

### 3. Sandbox — `Sandbox`

Runs user-supplied tool code (authored as TS, compiled to JS) inside a fresh workerd module worker with no ambient network access. The host↔guest protocol:

- `buildRemoteGuestModule(userSource)` concatenates a pre-bundled zod, a `globalThis.host` proxy, a `defineTool` preamble, the user's source, and an HTTP entrypoint exposing `/loadTool` and `/runTool`.
- User code calls `defineTool({ id, description, schema, run })` at module top level. `schema` must be a zod schema.
- Host capability calls are forwarded from the guest over a service binding and dispatched by `dispatchHostInvoke` against `flattenCapabilities(capabilities)`.
- Bounds: `timeoutMs` (5s default), `memoryBytes` (32 MiB default), `maxStackBytes`. Timeouts race `setTimeout` per call.

Backends:

- `WorkerdBackend` — local dev and tests; spins up a `miniflare` instance with a `HOST` service binding.
- `WorkerLoaderBackend` — Cloudflare Workers; uses `env.LOADER` plus a `hostFetcher` factory wrapping `dispatchHostInvoke`.
- `selectBackend()` picks `worker-loader` when both `loader` and `hostFetcher` are provided, otherwise `workerd`.

### 4. Capabilities

Host-provided functions that guest code can call. Ships four:

- `fetchCapability({ allow, timeoutMs, maxResponseBytes, fetchImpl })` — allow-list gated outgoing fetches with a response-size cap. Denials surface as `sandbox_capability_denied`.
- `logCapability({ sinks })` — structured logging from the guest.
- `shellCapability` — gated access to a [faux](https://www.npmjs.com/package/@ambiently-work/faux) in-process shell.
- `fsCapability({ fs, allow })` — per-op gated access to a [`@ambiently-work/mirage`](https://www.npmjs.com/package/@ambiently-work/mirage) filesystem (read/write/stat/glob/etc.).

Implement your own by conforming to `Capability = { name, functions, dispose? }` and passing it via `SandboxOptions.capabilities`.

### DynamicTool — sandboxed tools in a registry

`DynamicTool.fromSource(js, options)` wraps a compiled sandbox module as a regular `Tool`, so sandboxed tools coexist with native tools in one `ToolRegistry`. Use `compileTool(tsSource)` ahead of time to transpile TS and probe the module's `ToolMeta`. `dispose()` when done — the sandbox is long-lived.

### ShellTool

`ShellTool` wraps a long-lived `@ambiently-work/faux` shell session and exposes it as a single-tool unit. Cwd, env, and virtual filesystem state persist across calls for the life of the agent.

## Planning (optional)

`@ambiently-work/agent-sdk/planning` adds a structured planning layer on top of the core agent for multi-step work that benefits from up-front decomposition. Exposed via `import { planning } from "@ambiently-work/agent-sdk"`:

- **Plan / PlanNode** — typed DAG of research, discover, decide, do, verify nodes, with a `GatedOn` dependency model and a `PlanRevision` history.
- **Planner** — runs an LLM through structured phases to produce a `Plan`.
- **Executor** — single-step interpreter with approvals, checkpoints, and retry policies.
- **AgentNodeRunner** — default node runner that delegates to an `Agent`.
- **Budget / ModelRouter / Memoization / Severity** — cost tracking with a default price table, per-tier model selection, tool-call caching, and severity grading for approvals.

## Scripts

- `bun install` — install deps
- `bun test` — run the full suite. Pinned to `--max-concurrency 1` because sandbox tests start miniflare instances.
- `bun test path/to/file.test.ts` — run a single file
- `bun test -t "pattern"` — filter by test name
- `bun run check` — Biome lint + format check
- `bun run check:fix` — Biome with `--write`
- `bun run build:preamble` — regenerate `src/sandbox/protocol/preamble/zod.bundle.ts` (run after zod upgrades)

## Conventions

- `Result` types over exceptions. New error variants go in the relevant discriminated union (`ToolError`, `ProviderError`).
- Biome formatting (tabs, double quotes, organize-imports).
- Tests live next to the code they cover (`foo.ts` + `foo.test.ts`) and use `bun:test`.
- `src/index.ts` is the public surface.

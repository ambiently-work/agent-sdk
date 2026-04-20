# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@ambiently/agent` — a library for running an LLM agent loop with tools that can be authored as TypeScript and executed inside a workerd sandbox. Target runtime is Bun; the sandbox guest runs under workerd (via `miniflare` locally, or Cloudflare's Worker Loader binding in a Worker).

## Commands

- `bun install` — install deps
- `bun run src/index.ts` — run the (currently empty) entrypoint
- `bun test` — run the full test suite. The `test` script in `package.json` pins `--max-concurrency 1` because sandbox tests start miniflare instances and are not safe to run in parallel. Prefer `bun test` (via the script) over raw `bun test` when running everything.
- `bun test path/to/file.test.ts` — run a single test file
- `bun test -t "pattern"` — run tests whose name matches `pattern`
- `bun run check` — lint + format check with Biome
- `bun run check:fix` — Biome with `--write` to apply fixes
- `bun run build:preamble` — regenerate `src/sandbox/protocol/preamble/zod.bundle.ts` from `zod-entry.ts`. Run this whenever zod is upgraded or the preamble entry changes. The bundled source is committed and is excluded from Biome via `biome.json`. Note: `scripts/build-preamble.ts` currently references paths under `src/lib/sandbox/...` — the real tree lives at `src/sandbox/...`, so the script needs fixing before this works.

## Architecture

The library composes four layers. Understanding how they fit together is the fastest way to be productive.

### 1. `Tool` + `ToolRegistry` (`src/tools/`)

- `Tool<I, O>` is an abstract class: `id`, `description`, a zod `schema`, and `run(inputs)` that returns `ToolResult<O>`.
- `ToolRegistry` holds tools by id, validates inputs against the schema in `run()`, and returns a `ToolResult` — never throws for expected failures.
- Everything returns `Result<T, E> = { ok: true, value } | { ok: false, error }`. Tool errors use the discriminated `ToolError` union in `tools.ts`. Follow this pattern for new code; only throw at true system boundaries.

### 2. `Provider` + `Agent` (`src/providers/`, `src/agent/`)

- `Provider` is an abstract class with `listModels()` and `run(input): AsyncIterable<ProviderEvent>`. Events are streamed: `assistant_text_delta`, `assistant_text`, `tool_call`, `tool_result`, `done`, `error`.
- `OllamaProvider` implements the contract against the Ollama SDK. It runs the tool-use loop itself: for each model turn it collects tool calls, dispatches them via the provided `ToolRegistry`, feeds results back into the chat history, and repeats until there are no tool calls or `maxToolIterations` (default 16) is hit.
- `Agent` is a thin façade that pairs a `Provider` with a `ToolRegistry`.
- Two adapters on the same `ToolRegistry`:
  - `toolRegistryToChatTools(registry)` → OpenAI/Ollama-style `{type: "function", function: {...}}` specs.
  - `toolRegistryToMcpServer(registry)` → an `@modelcontextprotocol/sdk` server exposing the same tools over MCP.

### 3. `Sandbox` (`src/sandbox/`)

The sandbox runs user-supplied tool code (authored as TS, compiled to JS) inside a fresh workerd module worker with no network access by default. There is a host↔guest protocol:

- `buildRemoteGuestModule(userSource)` (`protocol/remote-guest.ts`) concatenates a pre-bundled zod (`preamble/zod.bundle.ts`), a `globalThis.host` proxy, the `defineTool` preamble (`preamble/defineTool.ts`), the user's source, and an HTTP entrypoint exposing `/loadTool` and `/runTool`.
- The user's code calls `defineTool({ id, description, schema, run })` at module top-level. `schema` must be a zod schema.
- The guest's `host` proxy forwards capability calls to the host over a service binding by POSTing `{fn, args}` to `http://_/invoke`. The host side is `dispatchHostInvoke` (`protocol/remote-host.ts`), which looks up the function in `flattenCapabilities(capabilities)`.
- Backends (`backend/`) implement `SandboxBackend.create(opts) → SandboxInstance`:
  - `WorkerdBackend` (local dev / tests): spins up a `miniflare` instance with a `HOST` service binding. Lazily imports `miniflare`.
  - `WorkerLoaderBackend` (Cloudflare Workers): uses the `env.LOADER` worker-loader binding and a `hostFetcher` factory that wraps `dispatchHostInvoke` into a `Fetcher`. `createAmbientHostEntrypoint` / `makeHostFetcher` in `backend/worker-loader-host.ts` are the helpers for this path.
  - `selectBackend()` picks `worker-loader` when both `loader` and `hostFetcher` are provided, otherwise falls back to `workerd`.
- `SandboxOptions.timeoutMs` (default 5s), `memoryBytes` (default 32MiB), and `maxStackBytes` bound execution. Timeouts are enforced per `callJson` via `setTimeout` races.
- `Sandbox.load(js)` loads and calls `__loadTool` (returns `ToolMeta`); `Sandbox.invoke(inputs)` calls `__runTool` with a stringified JSON payload and expects a `Result`-shaped response.

### 4. Capabilities (`src/sandbox/capabilities/`)

- `Capability = { name, functions: Record<string, HostFn>, dispose? }` — each capability contributes named functions to the host-side registry.
- `fetchCapability({ allow, timeoutMs, maxResponseBytes, fetchImpl })` gates outgoing fetches through an `allow(url)` predicate and caps the response size. Denials throw `FetchDeniedError` on the guest side, which the preamble maps to `sandbox_capability_denied`. Oversize responses throw `FetchOversizeError`.
- `logCapability({ sinks })` exposes `log` to the guest. Add new capabilities by implementing the `Capability` interface and passing them via `SandboxOptions.capabilities`.

### 5. `DynamicTool` (`src/tools/dynamic-tool.ts`) + authoring (`src/sandbox/authoring.ts`)

- `compileTool(tsSource)` transpiles TS to JS (via `Bun.Transpiler` in `transpile.ts`) and probes it with a throwaway sandbox to extract `ToolMeta`. Use this to validate and persist tool JS ahead of time — `transpileTs` requires the Bun runtime and is not available inside the sandbox.
- `DynamicTool.fromSource(js, options)` creates a long-lived sandbox and wraps it as a `Tool` that can be registered into a `ToolRegistry` alongside native tools. Because inputs are re-validated by zod inside the sandbox, `DynamicTool.parse` is a no-op. Always `dispose()` when done.

## Conventions

- `Result` types over exceptions. New error variants go in the relevant discriminated union (`ToolError`, `ProviderError`).
- Biome (tabs, double quotes, organize-imports) — run `bun run check:fix` before committing.
- Tests live next to the code they cover (`foo.ts` + `foo.test.ts`) and use `bun:test` (`describe`, `test`, `expect`).
- `src/index.ts` is the package's public surface — add new exports there.

## Bun defaults

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` / `yarn install` / `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` / `yarn run <script>` / `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't use dotenv.

### Bun APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- `` Bun.$`ls` `` instead of execa.

For more, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

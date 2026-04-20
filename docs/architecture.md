# Architecture

How the ambient-agent harness composes a turn: from `RunInput` → `Provider` → `AsyncIterable<ProviderEvent>` → renderer.

```mermaid
flowchart TB
    subgraph Entry["Entry points"]
        direction LR
        CLI["CLI<br/>src/cli/bin.ts"]
        Lib[["Library embedder<br/>new Agent(provider, tools)"]]
    end

    subgraph Core["Core harness"]
        direction TB
        Agent["Agent<br/>thin façade: pairs Provider + ToolRegistry"]
        Registry["ToolRegistry<br/>zod-validated Tool[]"]
        Adapters["Adapters<br/>toolRegistryToChatTools (JSON Schema)<br/>toolRegistryToMcpServer (MCP)"]
        Registry --- Adapters
    end

    subgraph Dynamic["Dynamic tools"]
        direction TB
        DT["DynamicTool<br/>compiled at authoring"]
        SB["Sandbox<br/>workerd via miniflare /<br/>Cloudflare Worker Loader"]
        Caps["Capabilities<br/>fetch · log · …<br/>allowlist + size/time caps"]
        DT --> SB
        SB --- Caps
    end
    Registry -.holds.-> DT

    subgraph P["Provider contract"]
        direction TB
        PA["abstract Provider<br/>listModels(): ModelInfo[]<br/>run(RunInput): AsyncIterable&lt;ProviderEvent&gt;"]
        subgraph Shapes["Two implementation shapes"]
            direction LR
            Chat["Chat-style<br/>harness drives the tool loop"]
            Meta["Meta-agent<br/>SDK drives its own loop"]
        end
        PA --- Shapes
    end

    Entry -->|RunInput<br/>model, messages, tools,<br/>systemPrompt, signal,<br/>maxToolIterations| Agent
    Agent -->|tools injected| Registry
    Agent -->|delegate run| PA

    PA ==>|AsyncIterable&lt;ProviderEvent&gt;| Agent
    Agent ==> Entry

    Chat -. calls .-> Registry
    Meta -. exposes via .-> Adapters
    Adapters -. MCP / JSON Schema .-> Meta

    Entry --> Out["Consumer<br/>EventRenderer (CLI)<br/>or embedder code"]

    classDef core fill:#0f172a,stroke:#38bdf8,color:#e2e8f0;
    classDef prov fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe;
    classDef dyn fill:#064e3b,stroke:#34d399,color:#d1fae5;
    classDef entry fill:#1e293b,stroke:#64748b,color:#e2e8f0;
    class Agent,Registry,Adapters core;
    class PA,Chat,Meta prov;
    class DT,SB,Caps dyn;
    class CLI,Lib,Out entry;
```

## Event stream

Every provider produces the same normalized events, so the consumer (CLI renderer, embedder loop, logger) doesn't need to know the backend.

```mermaid
sequenceDiagram
    participant C as Consumer (CLI / embedder)
    participant A as Agent
    participant P as Provider
    participant R as ToolRegistry

    C->>A: run(RunInput)
    A->>P: run({...input, tools: registry})
    loop streaming
        P-->>C: assistant_text_delta (repeat)
        P-->>C: assistant_text (turn complete)
        alt tool requested
            P-->>C: tool_call
            P->>R: run(tool, inputs)
            R-->>P: ToolResult
            P-->>C: tool_result
        end
    end
    P-->>C: done { stopReason, usage? }
```

Events:

| event                    | emitted when                                        |
| ------------------------ | --------------------------------------------------- |
| `assistant_text_delta`   | streaming token / chunk from the model              |
| `assistant_text`         | a complete assistant message after streaming closes |
| `tool_call`              | model asked for a tool (normalized shape)           |
| `tool_result`            | tool finished (`ToolResult<unknown>` from registry) |
| `done`                   | turn ended — `stop`, `tool_limit`, `length`, `aborted` |
| `error`                  | provider-level failure (`ProviderError` variant)    |

## Chat-style vs meta-agent providers

The two shapes differ in **who runs the tool loop** — everything else is identical from the consumer's point of view.

```mermaid
flowchart LR
    subgraph CS["Chat-style"]
        direction TB
        C1[harness sends<br/>messages + tool schemas] --> C2[model streams text<br/>+ tool_calls]
        C2 --> C3{tool_calls?}
        C3 -->|yes| C4[harness calls<br/>ToolRegistry.run]
        C4 --> C5[append tool result<br/>to message history]
        C5 --> C1
        C3 -->|no / maxIter| C6[emit done]
    end

    subgraph MA["Meta-agent"]
        direction TB
        M1[harness sends<br/>prompt + MCP-exposed tools] --> M2[SDK subprocess runs<br/>its own agent loop]
        M2 --> M3[SDK invokes built-in tools<br/>+ MCP-bridged ToolRegistry tools]
        M3 --> M4[SDK streams typed events:<br/>assistant messages, tool uses,<br/>tool results, turn completion]
        M4 --> M5[provider maps events<br/>to ProviderEvent stream]
    end

    classDef a fill:#064e3b,stroke:#34d399,color:#d1fae5;
    classDef b fill:#4c1d95,stroke:#a78bfa,color:#ede9fe;
    class C1,C2,C3,C4,C5,C6 a;
    class M1,M2,M3,M4,M5 b;
```

**Chat-style**: the harness is the agent. The provider sends `messages + tools` to the model, intercepts tool calls, dispatches them through `ToolRegistry`, and feeds results back. `maxToolIterations` caps the loop.

**Meta-agent**: the SDK is the agent. It has its own agent loop, its own built-in tools (filesystem, shell, etc.), and its own subprocess. The harness just hands it a prompt and mirrors the SDK's typed event stream back to the consumer. Our `ToolRegistry` is bridged in through MCP so the SDK's agent can also call our tools.

## Why this split matters

- **Consumers stay simple**: the `EventRenderer` (or any embedder loop) reads one event type and doesn't care whether we're talking to a local Ollama server, a cloud API, or a full coding-agent CLI subprocess.
- **Swappable backends**: the CLI's `--provider` flag picks at runtime. The `Agent` class is identical for all of them.
- **Tools work everywhere**: register a `Tool` once; it's exposed as JSON-Schema function-calling for chat-style providers and as an in-process MCP server for meta-agent providers — same `ToolRegistry`, same `run()` path.
- **Sandbox where it matters**: tools whose code you don't trust go through `DynamicTool` → workerd, with capability-gated host access. The provider layer is unaware.

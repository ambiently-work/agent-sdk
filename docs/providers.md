# Providers

How the five `Provider` implementations plug into the agent harness and how events flow from each backend back to the CLI.

```mermaid
flowchart TB
    subgraph Host["Ambient Host (Bun process)"]
        CLI["CLI: src/cli/bin.ts<br/>parseArgs → runCli → EventRenderer"]
        Agent["Agent<br/>pairs Provider + ToolRegistry"]
        Registry["ToolRegistry<br/>zod-validated Tool[]"]
        Sandbox["Sandbox (workerd)<br/>DynamicTool isolation"]
        Registry -.runs.-> Sandbox
    end

    CLI -->|RunInput<br/>messages, model, signal| Agent
    Agent -->|delegate| P{Provider<br/>by --provider flag}

    P -->|id=ollama| Ollama
    P -->|id=lmstudio| LMStudio
    P -->|id=gemini| Gemini
    P -->|id=claude-agent| Claude
    P -->|id=codex| Codex

    subgraph Chat["Chat-style providers (manual tool loop)"]
        direction TB
        Ollama["OllamaProvider<br/>ollama SDK"]
        LMStudio["LMStudioProvider<br/>@lmstudio/sdk"]
        Gemini["GeminiProvider<br/>@google/genai"]
    end

    subgraph Meta["Meta-agent providers (SDK owns loop)"]
        direction TB
        Claude["ClaudeAgentProvider<br/>@anthropic-ai/claude-agent-sdk"]
        Codex["CodexProvider<br/>@openai/codex-sdk"]
    end

    Ollama -->|chat stream=true| OllamaSrv[("Ollama server<br/>local/self-hosted")]
    OllamaSrv -->|msg.content deltas<br/>msg.tool_calls[]| Ollama

    LMStudio -->|llm.model().act| LMSrv[("LM Studio<br/>desktop/WS")]
    LMStudio -->|rawFunctionTool wraps<br/>each Tool in Registry| LMTools[LM Studio runs<br/>tool impl]
    LMTools -.calls.-> Registry
    LMSrv -->|onPredictionFragment<br/>tool callbacks| LMStudio

    Gemini -->|generateContentStream<br/>functionDeclarations| GemSrv[("Gemini API /<br/>Vertex AI")]
    GemSrv -->|chunk.text<br/>chunk.functionCalls| Gemini

    Claude -->|query prompt+options| ClaudeCLI[["Claude Code CLI<br/>subprocess"]]
    Claude -->|createSdkMcpServer<br/>exposes Registry| MCP[In-proc MCP server]
    ClaudeCLI -.mcpServers.-> MCP
    MCP -.calls.-> Registry
    ClaudeCLI -->|SDKMessage stream:<br/>assistant / user / stream_event / result| Claude

    Codex -->|startThread.runStreamed| CodexCLI[["Codex CLI<br/>subprocess"]]
    CodexCLI -->|ThreadEvent:<br/>item.started/completed<br/>turn.completed/failed| Codex

    subgraph Loop["Per-turn tool loop (chat providers only)"]
        direction LR
        LoopA[model response] --> LoopB{tool_calls?}
        LoopB -->|yes| LoopC[ToolRegistry.run<br/>emit tool_result]
        LoopC --> LoopA
        LoopB -->|no, or maxIter| LoopD[done]
    end
    Ollama -.-> Loop
    Gemini -.-> Loop

    Ollama & LMStudio & Gemini & Claude & Codex ==>|"AsyncIterable&lt;ProviderEvent&gt;<br/>assistant_text_delta · assistant_text<br/>tool_call · tool_result · done · error"| Agent
    Agent ==> CLI
    CLI -->|ANSI-painted stream| User(["stdout / TTY"])

    classDef ext fill:#1e293b,stroke:#64748b,color:#e2e8f0;
    classDef core fill:#0f172a,stroke:#38bdf8,color:#e2e8f0;
    classDef chat fill:#064e3b,stroke:#34d399,color:#d1fae5;
    classDef meta fill:#4c1d95,stroke:#a78bfa,color:#ede9fe;
    class OllamaSrv,LMSrv,GemSrv,ClaudeCLI,CodexCLI ext;
    class CLI,Agent,Registry,Sandbox,MCP core;
    class Ollama,LMStudio,Gemini chat;
    class Claude,Codex meta;
```

## Two provider shapes

**Chat providers** (Ollama, LM Studio, Gemini) — the provider owns the tool-use loop. Each iteration: stream chunks → collect `tool_calls` → dispatch through `ToolRegistry` → feed results back as a new message → repeat until the model emits no tool calls or `maxToolIterations` is hit.

**Meta-agent providers** (Claude Agent SDK, Codex SDK) — the SDK owns the loop and runs built-in tools (Bash/Read/Edit for Claude; `command_execution` / `mcp_tool_call` for Codex) inside its own subprocess. The provider hooks our `ToolRegistry` in via MCP (Claude, through `createSdkMcpServer`) or just surfaces the SDK's tool items as `tool_call` / `tool_result` events (Codex).

Both shapes funnel into the same normalized `AsyncIterable<ProviderEvent>` that the CLI's `EventRenderer` paints to the TTY.

export { Agent } from "./agent/agent";
export * as planning from "./planning";
export {
	ClaudeAgentProvider,
	type ClaudeAgentProviderOptions,
	type ClaudeAgentQueryFn,
} from "./providers/claude-agent";
export {
	type CodexClientLike,
	CodexProvider,
	type CodexProviderOptions,
} from "./providers/codex";
export {
	type GeminiClientLike,
	GeminiProvider,
	type GeminiProviderOptions,
} from "./providers/gemini";
export {
	type LMStudioClientLike,
	LMStudioProvider,
	type LMStudioProviderOptions,
} from "./providers/lmstudio";
export {
	type OllamaClientLike,
	OllamaProvider,
	type OllamaProviderOptions,
} from "./providers/ollama";
export {
	type ChatToolSpec,
	type McpServerHandle,
	type Message,
	type ModelInfo,
	type NormalizedToolCall,
	Provider,
	type ProviderError,
	type ProviderEvent,
	ProviderRegistry,
	type ProviderResult,
	type RunInput,
	toolRegistryToChatTools,
	toolRegistryToMcpServer,
	type Usage,
} from "./providers/provider";
export {
	type Capability,
	type FetchCapabilityOptions,
	FetchDeniedError,
	FetchOversizeError,
	type FsCapabilityOptions,
	FsDeniedError,
	type FsOp,
	fetchCapability,
	fsCapability,
	type GuestFetchResponse,
	type GuestStats,
	type LogCapabilityOptions,
	type LogSink,
	logCapability,
	SANDBOX_DEFAULTS,
	Sandbox,
	type SandboxBackend,
	type SandboxCreateOptions,
	type SandboxInstance,
	type SandboxOptions,
	type ShellCapabilityOptions,
	ShellDeniedError,
	shellCapability,
	type ToolMeta,
} from "./sandbox";
export {
	type CompileToolOptions,
	type CompileToolResult,
	compileTool,
} from "./sandbox/authoring";
export { transpileTs } from "./sandbox/transpile";
export {
	createDefaultTools,
	type DefaultToolsOptions,
	EditTool,
	type EditToolOptions,
	type EditToolResult,
	GlobTool,
	type GlobToolOptions,
	type GlobToolResult,
	type GrepMatch,
	GrepTool,
	type GrepToolOptions,
	type GrepToolResult,
	type LsEntry,
	LsTool,
	type LsToolOptions,
	type LsToolResult,
	type LspDiagnostic,
	LspTool,
	type LspToolOptions,
	type LspToolResult,
	ReadTool,
	type ReadToolOptions,
	type ReadToolResult,
	type Result,
	ShellSession,
	ShellTool,
	type ShellToolOptions,
	Tool,
	type ToolCall,
	type ToolError,
	ToolRegistry,
	type ToolResult,
	WriteTool,
	type WriteToolOptions,
	type WriteToolResult,
} from "@ambiently-work/faux";
export { DynamicTool, type DynamicToolOptions } from "./tools/dynamic-tool";

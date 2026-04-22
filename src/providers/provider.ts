import { Server as McpServerImpl } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Result, ToolRegistry } from "@ambiently-work/faux";

export interface ModelInfo {
	id: string;
	name: string;
	contextWindow?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
	supportsStreaming?: boolean;
}

export type ProviderError =
	| { code: "unknown_model"; message: string }
	| { code: "unreachable"; message: string; cause?: unknown }
	| { code: "auth_failed"; message: string }
	| { code: "rate_limited"; message: string; retryAfterMs?: number }
	| { code: "invalid_request"; message: string }
	| { code: "provider_error"; message: string; cause?: unknown }
	| { code: "aborted"; message: string }
	| { code: "duplicate_provider"; message: string };

export type ProviderResult<T> = Result<T, ProviderError>;

export interface Usage {
	inputTokens?: number;
	outputTokens?: number;
}

export interface NormalizedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string;
			toolCalls?: NormalizedToolCall[];
	  }
	| {
			role: "tool";
			toolCallId: string;
			toolName: string;
			content: string;
	  };

export interface RunInput {
	model: string;
	messages: Message[];
	tools?: ToolRegistry;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	maxToolIterations?: number;
	/**
	 * When true (default), tool calls emitted in the same model turn run
	 * concurrently via `Promise.all`. Set to false to execute them sequentially
	 * in the order the model produced them.
	 */
	parallelToolCalls?: boolean;
}

export type ProviderEvent =
	| { type: "assistant_text_delta"; text: string }
	| { type: "assistant_text"; text: string }
	| { type: "tool_call"; call: NormalizedToolCall }
	| {
			type: "tool_result";
			id: string;
			result: import("@ambiently-work/faux").ToolResult<unknown>;
	  }
	| {
			type: "done";
			stopReason: "stop" | "tool_limit" | "length" | "aborted";
			usage?: Usage;
	  }
	| { type: "error"; error: ProviderError };

export abstract class Provider {
	abstract readonly id: string;
	abstract listModels(): Promise<ProviderResult<ModelInfo[]>>;
	abstract run(input: RunInput): AsyncIterable<ProviderEvent>;
	dispose?(): Promise<void>;
}

export class ProviderRegistry {
	private readonly providers = new Map<string, Provider>();

	constructor(providers: Provider[] = []) {
		for (const p of providers) this.register(p);
	}

	register(provider: Provider): ProviderResult<Provider> {
		if (this.providers.has(provider.id)) {
			return {
				ok: false,
				error: {
					code: "duplicate_provider",
					message: `Provider "${provider.id}" is already registered`,
				},
			};
		}
		this.providers.set(provider.id, provider);
		return { ok: true, value: provider };
	}

	get(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	list(): Provider[] {
		return [...this.providers.values()];
	}
}

export interface ChatToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
}

export function toolRegistryToChatTools(
	registry: ToolRegistry,
): ChatToolSpec[] {
	return registry.list().map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.id,
			description: tool.description,
			parameters: z.toJSONSchema(tool.schema),
		},
	}));
}

export interface McpServerHandle {
	readonly server: McpServerImpl;
	close(): Promise<void>;
}

export function toolRegistryToMcpServer(
	registry: ToolRegistry,
	opts: { name?: string; version?: string } = {},
): McpServerHandle {
	const server = new McpServerImpl(
		{
			name: opts.name ?? "ambient-agent-tools",
			version: opts.version ?? "0.0.0",
		},
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: registry.list().map((tool) => ({
			name: tool.id,
			description: tool.description,
			inputSchema: z.toJSONSchema(tool.schema) as {
				type: "object";
				[key: string]: unknown;
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const result = await registry.run({
			tool: request.params.name,
			inputs: (request.params.arguments ?? {}) as Record<string, unknown>,
		});
		if (result.ok) {
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(result.value) },
				],
			};
		}
		return {
			content: [{ type: "text" as const, text: result.error.message }],
			isError: true,
		};
	});

	return {
		server,
		close: () => server.close(),
	};
}

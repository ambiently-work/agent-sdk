import {
	type Options as ClaudeAgentOptions,
	createSdkMcpServer,
	type Query,
	query,
	type SDKMessage,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Tool as AmbientTool, ToolRegistry } from "@ambiently-work/faux";
import {
	type Message,
	type ModelInfo,
	type NormalizedToolCall,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "./provider";

export type ClaudeAgentQueryFn = (params: {
	prompt: string | AsyncIterable<unknown>;
	options?: ClaudeAgentOptions;
}) => Query;

export interface ClaudeAgentProviderOptions {
	query?: ClaudeAgentQueryFn;
	/**
	 * Extra options passed to every `query()` call — e.g. `tools`, `agents`, `cwd`,
	 * `permissionMode`, `mcpServers`, `executable`. Per-run values set via `RunInput`
	 * (model, systemPrompt, maxToolIterations) override these.
	 */
	defaults?: ClaudeAgentOptions;
	/**
	 * MCP server name used when exposing our `ToolRegistry` to the Claude Agent SDK.
	 * Defaults to `"ambient-tools"`.
	 */
	toolsServerName?: string;
	/**
	 * When true, emit token-level deltas by enabling `includePartialMessages` and
	 * mapping `text_delta` events. Default: true.
	 */
	streamDeltas?: boolean;
}

export class ClaudeAgentProvider extends Provider {
	readonly id = "claude-agent";
	private readonly queryFn: ClaudeAgentQueryFn;
	private readonly defaults?: ClaudeAgentOptions;
	private readonly toolsServerName: string;
	private readonly streamDeltas: boolean;

	constructor(opts: ClaudeAgentProviderOptions = {}) {
		super();
		this.queryFn = opts.query ?? (query as ClaudeAgentQueryFn);
		this.defaults = opts.defaults;
		this.toolsServerName = opts.toolsServerName ?? "ambient-tools";
		this.streamDeltas = opts.streamDeltas ?? true;
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		return {
			ok: true,
			value: [
				{
					id: "claude-opus-4-7",
					name: "Claude Opus 4.7",
					supportsTools: true,
					supportsStreaming: true,
				},
				{
					id: "claude-sonnet-4-6",
					name: "Claude Sonnet 4.6",
					supportsTools: true,
					supportsStreaming: true,
				},
				{
					id: "claude-haiku-4-5",
					name: "Claude Haiku 4.5",
					supportsTools: true,
					supportsStreaming: true,
				},
			],
		};
	}

	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		const prompt = lastUserPrompt(input.messages);
		if (!prompt) {
			yield {
				type: "error",
				error: {
					code: "invalid_request",
					message: "Claude Agent provider requires a trailing user message",
				},
			};
			yield { type: "done", stopReason: "stop" };
			return;
		}

		const abortController = new AbortController();
		const onAbort = () => abortController.abort();
		input.signal?.addEventListener("abort", onAbort, { once: true });

		const mcpServers: NonNullable<ClaudeAgentOptions["mcpServers"]> = {
			...(this.defaults?.mcpServers ?? {}),
		};
		if (input.tools && input.tools.list().length > 0) {
			mcpServers[this.toolsServerName] = createSdkMcpServer({
				name: this.toolsServerName,
				tools: toolRegistryToSdkTools(input.tools),
			});
		}

		const options: ClaudeAgentOptions = {
			...this.defaults,
			abortController,
			model: input.model || this.defaults?.model,
			systemPrompt: input.systemPrompt ?? this.defaults?.systemPrompt,
			maxTurns: input.maxToolIterations ?? this.defaults?.maxTurns,
			mcpServers,
			includePartialMessages:
				this.streamDeltas || this.defaults?.includePartialMessages,
		};

		let stream: Query;
		try {
			stream = this.queryFn({ prompt, options });
		} catch (err) {
			input.signal?.removeEventListener("abort", onAbort);
			yield {
				type: "error",
				error: {
					code: "provider_error",
					message: err instanceof Error ? err.message : String(err),
					cause: err,
				},
			};
			yield { type: "done", stopReason: "stop" };
			return;
		}

		try {
			for await (const msg of stream) {
				for (const event of mapClaudeEvent(msg, this.streamDeltas)) {
					yield event;
				}
			}
			yield { type: "done", stopReason: "stop" };
		} catch (err) {
			if (abortController.signal.aborted) {
				yield { type: "done", stopReason: "aborted" };
				return;
			}
			yield {
				type: "error",
				error: {
					code: "provider_error",
					message: err instanceof Error ? err.message : String(err),
					cause: err,
				},
			};
			yield { type: "done", stopReason: "stop" };
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
		}
	}
}

function lastUserPrompt(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") return m.content;
	}
	return null;
}

function toolRegistryToSdkTools(
	registry: ToolRegistry,
): Array<SdkMcpToolDefinition<Record<string, z.ZodType>>> {
	return registry.list().map((tool) => toSdkTool(tool));
}

function toSdkTool(
	tool: AmbientTool,
): SdkMcpToolDefinition<Record<string, z.ZodType>> {
	const shape =
		tool.schema instanceof z.ZodObject
			? (tool.schema.shape as Record<string, z.ZodType>)
			: { input: z.unknown() as unknown as z.ZodType };
	return {
		name: tool.id,
		description: tool.description,
		inputSchema: shape,
		handler: async (args) => {
			const inputs =
				tool.schema instanceof z.ZodObject
					? (args as Record<string, unknown>)
					: ((args as { input: unknown }).input as Record<string, unknown>);
			const result = await tool.run(inputs as never);
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
		},
	};
}

function mapClaudeEvent(
	msg: SDKMessage,
	streamDeltas: boolean,
): ProviderEvent[] {
	switch (msg.type) {
		case "assistant": {
			const events: ProviderEvent[] = [];
			let fullText = "";
			for (const block of msg.message.content) {
				if (block.type === "text") {
					fullText += block.text;
					if (!streamDeltas) {
						events.push({ type: "assistant_text_delta", text: block.text });
					}
				} else if (block.type === "tool_use") {
					events.push({
						type: "tool_call",
						call: normalizeToolUse(block),
					});
				}
			}
			if (fullText && !streamDeltas) {
				events.push({ type: "assistant_text", text: fullText });
			} else if (fullText) {
				events.push({ type: "assistant_text", text: fullText });
			}
			return events;
		}
		case "user": {
			const events: ProviderEvent[] = [];
			const content = msg.message.content;
			if (typeof content === "string") return events;
			for (const block of content) {
				if (
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "tool_result"
				) {
					const toolResult = block as {
						tool_use_id: string;
						is_error?: boolean;
						content?: unknown;
					};
					const textContent = stringifyToolResult(toolResult.content);
					events.push({
						type: "tool_result",
						id: toolResult.tool_use_id,
						result: toolResult.is_error
							? {
									ok: false,
									error: { code: "tool_failed", message: textContent },
								}
							: { ok: true, value: textContent },
					});
				}
			}
			return events;
		}
		case "stream_event": {
			if (!streamDeltas) return [];
			const ev = msg.event;
			if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
				return [{ type: "assistant_text_delta", text: ev.delta.text }];
			}
			return [];
		}
		case "result": {
			if (msg.subtype === "success") return [];
			return [
				{
					type: "error",
					error: {
						code: "provider_error",
						message: msg.errors?.[0] ?? msg.subtype,
					},
				},
			];
		}
		default:
			return [];
	}
}

function normalizeToolUse(block: {
	id: string;
	name: string;
	input: unknown;
}): NormalizedToolCall {
	return {
		id: block.id,
		name: block.name,
		input: (block.input ?? {}) as Record<string, unknown>,
	};
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (typeof part === "object" && part !== null && "text" in part) {
					return String((part as { text: unknown }).text);
				}
				return JSON.stringify(part);
			})
			.join("");
	}
	return JSON.stringify(content);
}

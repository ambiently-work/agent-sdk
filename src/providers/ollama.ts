import type {
	ChatRequest as OllamaChatRequest,
	Tool as OllamaChatTool,
	Message as OllamaMessage,
	ToolCall as OllamaToolCall,
} from "ollama";
import { Ollama } from "ollama";
import type { ToolRegistry, ToolResult } from "../tools/tools";
import {
	type Message,
	type ModelInfo,
	type NormalizedToolCall,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
	toolRegistryToChatTools,
} from "./provider";

export interface OllamaClientLike {
	list(): Promise<{ models: Array<{ name: string; details?: unknown }> }>;
	chat(request: OllamaChatRequest & { stream: true }): Promise<
		AsyncIterable<{
			message?: OllamaMessage;
			done?: boolean;
		}> & { abort?: () => void }
	>;
}

export interface OllamaProviderOptions {
	host?: string;
	client?: OllamaClientLike;
}

export class OllamaProvider extends Provider {
	readonly id = "ollama";
	private readonly client: OllamaClientLike;

	constructor(opts: OllamaProviderOptions = {}) {
		super();
		this.client =
			opts.client ??
			(new Ollama({
				host: opts.host ?? process.env.OLLAMA_BASE_URL,
			}) as unknown as OllamaClientLike);
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		try {
			const res = await this.client.list();
			return {
				ok: true,
				value: res.models.map((m) => ({
					id: m.name,
					name: m.name,
					supportsTools: true,
					supportsStreaming: true,
				})),
			};
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "unreachable",
					message: `Failed to list Ollama models: ${
						err instanceof Error ? err.message : String(err)
					}`,
					cause: err,
				},
			};
		}
	}

	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		const history = toOllamaMessages(input.messages, input.systemPrompt);
		const tools = input.tools
			? (toolRegistryToChatTools(input.tools) as unknown as OllamaChatTool[])
			: undefined;
		const maxIters = input.maxToolIterations ?? 16;

		for (let iter = 0; iter < maxIters; iter++) {
			if (input.signal?.aborted) {
				yield { type: "done", stopReason: "aborted" };
				return;
			}

			let stream: Awaited<ReturnType<OllamaClientLike["chat"]>>;
			try {
				stream = await this.client.chat({
					model: input.model,
					messages: history,
					tools,
					stream: true,
					options:
						input.temperature !== undefined
							? { temperature: input.temperature }
							: undefined,
				});
			} catch (err) {
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

			let fullText = "";
			const rawToolCalls: OllamaToolCall[] = [];
			let aborted = false;

			for await (const chunk of stream) {
				if (input.signal?.aborted) {
					stream.abort?.();
					aborted = true;
					break;
				}
				const msg = chunk.message;
				if (msg?.content) {
					yield { type: "assistant_text_delta", text: msg.content };
					fullText += msg.content;
				}
				if (msg?.tool_calls?.length) {
					rawToolCalls.push(...msg.tool_calls);
				}
			}

			if (aborted) {
				yield { type: "done", stopReason: "aborted" };
				return;
			}

			yield { type: "assistant_text", text: fullText };

			if (rawToolCalls.length === 0) {
				yield { type: "done", stopReason: "stop" };
				return;
			}

			const normalizedCalls = rawToolCalls.map(normalizeOllamaToolCall);
			history.push({
				role: "assistant",
				content: fullText,
				tool_calls: rawToolCalls,
			});

			for (const call of normalizedCalls) {
				yield { type: "tool_call", call };
			}

			const parallel = input.parallelToolCalls ?? true;
			const results: ToolResult<unknown>[] = parallel
				? await Promise.all(
						normalizedCalls.map((call) => dispatchTool(input.tools, call)),
					)
				: await (async () => {
						const out: ToolResult<unknown>[] = [];
						for (const call of normalizedCalls) {
							out.push(await dispatchTool(input.tools, call));
						}
						return out;
					})();

			for (let i = 0; i < normalizedCalls.length; i++) {
				const call = normalizedCalls[i];
				const result = results[i];
				if (!call || !result) continue;
				yield { type: "tool_result", id: call.id, result };
				history.push({
					role: "tool",
					tool_name: call.name,
					content: result.ok
						? JSON.stringify(result.value)
						: `error: ${result.error.message}`,
				});
			}
		}

		yield { type: "done", stopReason: "tool_limit" };
	}
}

function toOllamaMessages(
	messages: Message[],
	systemPrompt?: string,
): OllamaMessage[] {
	const out: OllamaMessage[] = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });
	for (const m of messages) {
		if (m.role === "tool") {
			out.push({ role: "tool", tool_name: m.toolName, content: m.content });
		} else if (m.role === "assistant") {
			out.push({
				role: "assistant",
				content: m.content,
				tool_calls: m.toolCalls?.map((c) => ({
					function: { name: c.name, arguments: c.input },
				})),
			});
		} else {
			out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}

function normalizeOllamaToolCall(call: OllamaToolCall): NormalizedToolCall {
	return {
		id: crypto.randomUUID(),
		name: call.function.name,
		input: (call.function.arguments ?? {}) as Record<string, unknown>,
	};
}

async function dispatchTool(
	registry: ToolRegistry | undefined,
	call: NormalizedToolCall,
): Promise<ToolResult<unknown>> {
	if (!registry) {
		return {
			ok: false,
			error: {
				code: "tool_failed",
				message: "Model requested a tool but no ToolRegistry was provided",
			},
		};
	}
	return registry.run({ tool: call.name, inputs: call.input });
}

import {
	type ChatMessageInput,
	type LLM,
	LMStudioClient,
	type Tool as LMStudioTool,
	rawFunctionTool,
} from "@lmstudio/sdk";
import { z } from "zod";
import type { ToolRegistry } from "@ambiently-work/faux";
import {
	type Message,
	type ModelInfo,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "./provider";

export interface LMStudioClientLike {
	llm: {
		model(identifier?: string): Promise<LLM> | LLM;
		listLoaded?: () => Promise<Array<{ identifier: string }>>;
	};
}

export interface LMStudioProviderOptions {
	baseUrl?: string;
	client?: LMStudioClientLike;
}

export class LMStudioProvider extends Provider {
	readonly id = "lmstudio";
	private readonly client: LMStudioClientLike;

	constructor(opts: LMStudioProviderOptions = {}) {
		super();
		this.client =
			opts.client ??
			(new LMStudioClient({
				baseUrl: opts.baseUrl ?? process.env.LMSTUDIO_BASE_URL,
			}) as unknown as LMStudioClientLike);
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		try {
			const loaded = (await this.client.llm.listLoaded?.()) ?? [];
			return {
				ok: true,
				value: loaded.map((m) => ({
					id: m.identifier,
					name: m.identifier,
					supportsTools: true,
					supportsStreaming: true,
				})),
			};
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "unreachable",
					message: `Failed to list LM Studio models: ${err instanceof Error ? err.message : String(err)}`,
					cause: err,
				},
			};
		}
	}

	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		let model: LLM;
		try {
			model = await this.client.llm.model(input.model);
		} catch (err) {
			yield {
				type: "error",
				error: {
					code: "unknown_model",
					message: err instanceof Error ? err.message : String(err),
				},
			};
			yield { type: "done", stopReason: "stop" };
			return;
		}

		const chat = messagesToLMStudioChat(input.messages, input.systemPrompt);
		const queue = new EventQueue<ProviderEvent>();
		const textPerRound: string[] = [];
		const lmTools: LMStudioTool[] = input.tools
			? buildToolsForQueue(input.tools, queue)
			: [];

		const actPromise = model
			.act(chat, lmTools, {
				signal: input.signal,
				temperature: input.temperature,
				maxTokens: input.maxTokens,
				onPredictionFragment: (fragment) => {
					if (fragment.reasoningType !== "none") return;
					const idx = fragment.roundIndex;
					textPerRound[idx] = (textPerRound[idx] ?? "") + fragment.content;
					queue.push({ type: "assistant_text_delta", text: fragment.content });
				},
				onRoundEnd: (roundIndex) => {
					queue.push({
						type: "assistant_text",
						text: textPerRound[roundIndex] ?? "",
					});
				},
			})
			.then(
				() => {
					queue.push({ type: "done", stopReason: "stop" });
					queue.close();
				},
				(err: unknown) => {
					if (input.signal?.aborted) {
						queue.push({ type: "done", stopReason: "aborted" });
					} else {
						queue.push({
							type: "error",
							error: {
								code: "provider_error",
								message: err instanceof Error ? err.message : String(err),
								cause: err,
							},
						});
						queue.push({ type: "done", stopReason: "stop" });
					}
					queue.close();
				},
			);

		try {
			for await (const event of queue) yield event;
		} finally {
			await actPromise;
		}
	}
}

function messagesToLMStudioChat(
	messages: Message[],
	systemPrompt?: string,
): ChatMessageInput[] {
	const out: ChatMessageInput[] = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });
	for (const m of messages) {
		if (m.role === "tool") {
			out.push({ role: "user", content: `tool-result: ${m.content}` });
		} else if (m.role === "assistant") {
			out.push({ role: "assistant", content: m.content });
		} else if (m.role === "user" || m.role === "system") {
			out.push({ role: m.role, content: m.content });
		}
	}
	return out;
}

function buildToolsForQueue(
	registry: ToolRegistry,
	queue: EventQueue<ProviderEvent>,
): LMStudioTool[] {
	return registry.list().map((tool) =>
		rawFunctionTool({
			name: tool.id,
			description: tool.description,
			parametersJsonSchema: z.toJSONSchema(tool.schema),
			implementation: async (params) => {
				const callId = crypto.randomUUID();
				queue.push({
					type: "tool_call",
					call: {
						id: callId,
						name: tool.id,
						input: params as Record<string, unknown>,
					},
				});
				const result = await registry.run({ tool: tool.id, inputs: params });
				queue.push({ type: "tool_result", id: callId, result });
				if (result.ok) return result.value;
				throw new Error(result.error.message);
			},
		}),
	);
}

class EventQueue<T> implements AsyncIterable<T> {
	private readonly buffer: T[] = [];
	private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.buffer.push(item);
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.({ value: undefined as T, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: (): Promise<IteratorResult<T>> => {
				if (this.buffer.length > 0) {
					return Promise.resolve({
						value: this.buffer.shift() as T,
						done: false,
					});
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined as T, done: true });
				}
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

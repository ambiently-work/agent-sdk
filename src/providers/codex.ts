import {
	Codex,
	type CodexOptions,
	type Thread,
	type ThreadEvent,
	type ThreadItem,
	type ThreadOptions,
} from "@openai/codex-sdk";
import {
	type ModelInfo,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "./provider";

export interface CodexClientLike {
	startThread(options?: ThreadOptions): Thread;
	resumeThread?(id: string, options?: ThreadOptions): Thread;
}

export interface CodexProviderOptions extends CodexOptions {
	client?: CodexClientLike;
	/**
	 * Default thread options applied to every `run()`. Fields like `sandboxMode`,
	 * `workingDirectory`, `approvalPolicy`, and `networkAccessEnabled` shape how
	 * the Codex CLI executes tools on the host.
	 */
	threadDefaults?: ThreadOptions;
	/**
	 * When true (default), the provider resumes the same thread across successive
	 * `run()` calls so the Codex CLI can benefit from persisted context. Set to
	 * false to start a fresh thread every turn.
	 */
	persistThread?: boolean;
}

export class CodexProvider extends Provider {
	readonly id = "codex";
	private readonly client: CodexClientLike;
	private readonly threadDefaults?: ThreadOptions;
	private readonly persistThread: boolean;
	private currentThread: Thread | null = null;

	constructor(opts: CodexProviderOptions = {}) {
		super();
		const { client, threadDefaults, persistThread, ...codexOpts } = opts;
		this.client = client ?? (new Codex(codexOpts) as CodexClientLike);
		this.threadDefaults = threadDefaults;
		this.persistThread = persistThread ?? true;
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		// Codex CLI does not expose a model listing endpoint. Surface the models the
		// CLI accepts today as a static hint.
		return {
			ok: true,
			value: [
				{
					id: "gpt-5-codex",
					name: "gpt-5-codex",
					supportsTools: true,
					supportsStreaming: true,
				},
				{
					id: "gpt-5",
					name: "gpt-5",
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
					message: "Codex provider requires a trailing user message",
				},
			};
			yield { type: "done", stopReason: "stop" };
			return;
		}

		const threadOpts: ThreadOptions = {
			...this.threadDefaults,
			model: input.model || this.threadDefaults?.model,
		};

		const thread =
			this.persistThread && this.currentThread
				? this.currentThread
				: this.client.startThread(threadOpts);
		this.currentThread = this.persistThread ? thread : null;

		let streamed: Awaited<ReturnType<Thread["runStreamed"]>>;
		try {
			streamed = await thread.runStreamed(prompt, { signal: input.signal });
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

		let finalText = "";
		const emitted = new Set<string>();

		try {
			for await (const event of streamed.events) {
				const mapped = mapCodexEvent(event, emitted);
				for (const e of mapped) {
					if (e.type === "assistant_text") finalText = e.text;
					yield e;
				}
			}
		} catch (err) {
			if (input.signal?.aborted) {
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
			return;
		}

		if (!emitted.has("turn.completed")) {
			yield { type: "done", stopReason: "stop" };
		}
		void finalText;
	}
}

function lastUserPrompt(messages: RunInput["messages"]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") return m.content;
	}
	return null;
}

function mapCodexEvent(
	event: ThreadEvent,
	emitted: Set<string>,
): ProviderEvent[] {
	switch (event.type) {
		case "thread.started":
		case "turn.started":
			return [];
		case "item.started":
			return startItem(event.item);
		case "item.updated":
			return updateItem(event.item);
		case "item.completed":
			return completeItem(event.item);
		case "turn.completed": {
			emitted.add("turn.completed");
			return [
				{
					type: "done",
					stopReason: "stop",
					usage: {
						inputTokens: event.usage.input_tokens,
						outputTokens: event.usage.output_tokens,
					},
				},
			];
		}
		case "turn.failed":
			return [
				{
					type: "error",
					error: {
						code: "provider_error",
						message: event.error.message,
					},
				},
				{ type: "done", stopReason: "stop" },
			];
		case "error":
			return [
				{
					type: "error",
					error: { code: "provider_error", message: event.message },
				},
				{ type: "done", stopReason: "stop" },
			];
		default:
			return [];
	}
}

function startItem(item: ThreadItem): ProviderEvent[] {
	if (item.type === "command_execution") {
		return [
			{
				type: "tool_call",
				call: {
					id: item.id,
					name: "exec",
					input: { command: item.command },
				},
			},
		];
	}
	if (item.type === "mcp_tool_call") {
		return [
			{
				type: "tool_call",
				call: {
					id: item.id,
					name: `${item.server}/${item.tool}`,
					input: (item.arguments ?? {}) as Record<string, unknown>,
				},
			},
		];
	}
	return [];
}

function updateItem(_item: ThreadItem): ProviderEvent[] {
	return [];
}

function completeItem(item: ThreadItem): ProviderEvent[] {
	if (item.type === "agent_message") {
		return [
			{ type: "assistant_text_delta", text: item.text },
			{ type: "assistant_text", text: item.text },
		];
	}
	if (item.type === "command_execution") {
		return [
			{
				type: "tool_result",
				id: item.id,
				result:
					item.status === "completed" && item.exit_code === 0
						? { ok: true, value: item.aggregated_output }
						: {
								ok: false,
								error: {
									code: "tool_failed",
									message: `exit=${item.exit_code ?? "?"}: ${item.aggregated_output.slice(0, 500)}`,
								},
							},
			},
		];
	}
	if (item.type === "mcp_tool_call") {
		return [
			{
				type: "tool_result",
				id: item.id,
				result: item.error
					? {
							ok: false,
							error: { code: "tool_failed", message: item.error.message },
						}
					: { ok: true, value: item.result?.structured_content ?? null },
			},
		];
	}
	if (item.type === "error") {
		return [
			{
				type: "error",
				error: { code: "provider_error", message: item.message },
			},
		];
	}
	return [];
}

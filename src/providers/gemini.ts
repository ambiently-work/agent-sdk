import {
	type Content,
	type FunctionCall,
	type FunctionDeclaration,
	type GenerateContentParameters,
	type GenerateContentResponse,
	GoogleGenAI,
} from "@google/genai";
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "../tools/tools";
import {
	type Message,
	type ModelInfo,
	type NormalizedToolCall,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "./provider";

export interface GeminiClientLike {
	models: {
		generateContentStream(
			params: GenerateContentParameters,
		): Promise<AsyncGenerator<GenerateContentResponse>>;
		list?: (params?: unknown) => Promise<AsyncIterable<{ name?: string }>>;
	};
}

export interface GeminiProviderOptions {
	apiKey?: string;
	client?: GeminiClientLike;
	vertexai?: boolean;
}

export class GeminiProvider extends Provider {
	readonly id = "gemini";
	private readonly client: GeminiClientLike;

	constructor(opts: GeminiProviderOptions = {}) {
		super();
		this.client =
			opts.client ??
			(new GoogleGenAI({
				apiKey:
					opts.apiKey ??
					process.env.GOOGLE_API_KEY ??
					process.env.GEMINI_API_KEY,
				vertexai: opts.vertexai,
			}) as unknown as GeminiClientLike);
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		if (!this.client.models.list) {
			return { ok: true, value: [] };
		}
		try {
			const pager = await this.client.models.list();
			const out: ModelInfo[] = [];
			for await (const model of pager) {
				const id = (model.name ?? "").replace(/^models\//, "");
				if (!id) continue;
				out.push({
					id,
					name: id,
					supportsTools: true,
					supportsStreaming: true,
				});
			}
			return { ok: true, value: out };
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "unreachable",
					message: `Failed to list Gemini models: ${err instanceof Error ? err.message : String(err)}`,
					cause: err,
				},
			};
		}
	}

	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		const contents: Content[] = messagesToGeminiContents(input.messages);
		const functionDeclarations = input.tools
			? toolRegistryToFunctionDeclarations(input.tools)
			: undefined;
		const maxIters = input.maxToolIterations ?? 16;

		for (let iter = 0; iter < maxIters; iter++) {
			if (input.signal?.aborted) {
				yield { type: "done", stopReason: "aborted" };
				return;
			}

			let stream: AsyncGenerator<GenerateContentResponse>;
			try {
				stream = await this.client.models.generateContentStream({
					model: input.model,
					contents,
					config: {
						systemInstruction: input.systemPrompt,
						temperature: input.temperature,
						maxOutputTokens: input.maxTokens,
						abortSignal: input.signal,
						...(functionDeclarations?.length
							? { tools: [{ functionDeclarations }] }
							: {}),
					},
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
			const functionCalls: FunctionCall[] = [];
			let aborted = false;
			let finishReason: string | undefined;

			for await (const chunk of stream) {
				if (input.signal?.aborted) {
					aborted = true;
					break;
				}
				const text = chunk.text;
				if (text) {
					yield { type: "assistant_text_delta", text };
					fullText += text;
				}
				const calls = chunk.functionCalls;
				if (calls?.length) functionCalls.push(...calls);
				const reason = chunk.candidates?.[0]?.finishReason;
				if (reason) finishReason = reason;
			}

			if (aborted) {
				yield { type: "done", stopReason: "aborted" };
				return;
			}

			yield { type: "assistant_text", text: fullText };

			if (functionCalls.length === 0) {
				const stop = finishReason === "MAX_TOKENS" ? "length" : "stop";
				yield { type: "done", stopReason: stop };
				return;
			}

			contents.push({
				role: "model",
				parts: [
					...(fullText ? [{ text: fullText }] : []),
					...functionCalls.map((c) => ({ functionCall: c })),
				],
			});

			const normalizedCalls = functionCalls.map(normalizeGeminiCall);
			for (const normalized of normalizedCalls) {
				yield { type: "tool_call", call: normalized };
			}

			const parallel = input.parallelToolCalls ?? true;
			const results: ToolResult<unknown>[] = parallel
				? await Promise.all(normalizedCalls.map((c) => runTool(input.tools, c)))
				: await (async () => {
						const out: ToolResult<unknown>[] = [];
						for (const c of normalizedCalls) {
							out.push(await runTool(input.tools, c));
						}
						return out;
					})();

			const responses: Array<{
				name: string;
				response: Record<string, unknown>;
			}> = [];
			for (let i = 0; i < normalizedCalls.length; i++) {
				const normalized = normalizedCalls[i];
				const result = results[i];
				if (!normalized || !result) continue;
				yield { type: "tool_result", id: normalized.id, result };
				responses.push({
					name: normalized.name,
					response: result.ok
						? { output: result.value }
						: { error: result.error.message },
				});
			}

			contents.push({
				role: "user",
				parts: responses.map((r) => ({ functionResponse: r })),
			});
		}

		yield { type: "done", stopReason: "tool_limit" };
	}
}

function messagesToGeminiContents(messages: Message[]): Content[] {
	const out: Content[] = [];
	for (const m of messages) {
		if (m.role === "system") continue;
		if (m.role === "user") {
			out.push({ role: "user", parts: [{ text: m.content }] });
		} else if (m.role === "assistant") {
			const parts: Content["parts"] = [];
			if (m.content) parts?.push({ text: m.content });
			if (m.toolCalls) {
				for (const c of m.toolCalls) {
					parts?.push({
						functionCall: { id: c.id, name: c.name, args: c.input },
					});
				}
			}
			out.push({ role: "model", parts });
		} else if (m.role === "tool") {
			out.push({
				role: "user",
				parts: [
					{
						functionResponse: {
							name: m.toolName,
							response: { output: m.content },
						},
					},
				],
			});
		}
	}
	return out;
}

function toolRegistryToFunctionDeclarations(
	registry: ToolRegistry,
): FunctionDeclaration[] {
	return registry.list().map((tool) => ({
		name: tool.id,
		description: tool.description,
		parametersJsonSchema: z.toJSONSchema(tool.schema),
	}));
}

function normalizeGeminiCall(call: FunctionCall): NormalizedToolCall {
	return {
		id: call.id ?? crypto.randomUUID(),
		name: call.name ?? "unknown",
		input: (call.args ?? {}) as Record<string, unknown>,
	};
}

async function runTool(
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
	return await registry.run({ tool: call.name, inputs: call.input });
}

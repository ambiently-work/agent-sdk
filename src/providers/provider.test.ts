import { describe, expect, test } from "bun:test";
import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { Agent } from "../agent/agent";
import { type OllamaClientLike, OllamaProvider } from "./ollama";
import {
	type ModelInfo,
	Provider,
	type ProviderEvent,
	ProviderRegistry,
	type ProviderResult,
	type RunInput,
	toolRegistryToChatTools,
	toolRegistryToMcpServer,
} from "./provider";

class EchoTool extends Tool<{ message: string }, string> {
	readonly id = "echo";
	readonly description = "Echoes the input message";
	readonly schema = z.object({ message: z.string() });

	async run(inputs: { message: string }): Promise<ToolResult<string>> {
		return { ok: true, value: inputs.message };
	}
}

class AddTool extends Tool<{ a: number; b: number }, number> {
	readonly id = "add";
	readonly description = "Adds two numbers";
	readonly schema = z.object({ a: z.number(), b: z.number() });

	async run(inputs: { a: number; b: number }): Promise<ToolResult<number>> {
		return { ok: true, value: inputs.a + inputs.b };
	}
}

class MockProvider extends Provider {
	readonly id = "mock";
	constructor(
		private readonly models: ModelInfo[],
		private readonly script: ProviderEvent[],
	) {
		super();
	}

	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		return { ok: true, value: this.models };
	}

	async *run(_input: RunInput): AsyncIterable<ProviderEvent> {
		for (const event of this.script) yield event;
	}
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

describe("ProviderRegistry", () => {
	test("registers and lists providers", () => {
		const p = new MockProvider([], []);
		const registry = new ProviderRegistry([p]);
		expect(registry.list().map((x) => x.id)).toEqual(["mock"]);
		expect(registry.get("mock")).toBe(p);
	});

	test("register rejects duplicate ids", () => {
		const registry = new ProviderRegistry([new MockProvider([], [])]);
		const result = registry.register(new MockProvider([], []));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("duplicate_provider");
	});
});

describe("MockProvider", () => {
	test("listModels returns scripted models", async () => {
		const provider = new MockProvider([{ id: "m1", name: "Model 1" }], []);
		const result = await provider.listModels();
		expect(result).toEqual({
			ok: true,
			value: [{ id: "m1", name: "Model 1" }],
		});
	});

	test("run replays scripted events", async () => {
		const provider = new MockProvider(
			[],
			[
				{ type: "assistant_text_delta", text: "hi" },
				{ type: "assistant_text", text: "hi" },
				{ type: "done", stopReason: "stop" },
			],
		);
		const events = await collect(provider.run({ model: "m", messages: [] }));
		expect(events.map((e) => e.type)).toEqual([
			"assistant_text_delta",
			"assistant_text",
			"done",
		]);
	});
});

describe("toolRegistryToChatTools", () => {
	test("emits OpenAI-shaped tools with JSON Schema parameters", () => {
		const registry = new ToolRegistry([new EchoTool(), new AddTool()]);
		const tools = toolRegistryToChatTools(registry);
		expect(tools).toHaveLength(2);

		const echo = tools.find((t) => t.function.name === "echo");
		expect(echo).toBeDefined();
		expect(echo?.type).toBe("function");
		expect(echo?.function.description).toBe("Echoes the input message");
		const params = echo?.function.parameters as {
			type: string;
			properties: Record<string, { type: string }>;
			required: string[];
		};
		expect(params.type).toBe("object");
		expect(params.properties.message?.type).toBe("string");
		expect(params.required).toEqual(["message"]);
	});
});

describe("toolRegistryToMcpServer", () => {
	test("exposes tools/list and tools/call over in-process MCP", async () => {
		const registry = new ToolRegistry([new EchoTool(), new AddTool()]);
		const handle = toolRegistryToMcpServer(registry);

		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const client = new Client(
			{ name: "test-client", version: "0.0.0" },
			{ capabilities: {} },
		);

		await handle.server.connect(serverTransport);
		await client.connect(clientTransport);

		const listed = await client.listTools();
		expect(listed.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);
		const echoTool = listed.tools.find((t) => t.name === "echo");
		expect(echoTool?.description).toBe("Echoes the input message");
		expect(echoTool?.inputSchema.type).toBe("object");

		const ok = await client.callTool({
			name: "echo",
			arguments: { message: "hello mcp" },
		});
		expect(ok.isError).toBeFalsy();
		const okContent = ok.content as Array<{ type: string; text: string }>;
		expect(JSON.parse(okContent[0]?.text ?? "")).toBe("hello mcp");

		const missing = await client.callTool({
			name: "does-not-exist",
			arguments: {},
		});
		expect(missing.isError).toBe(true);

		await client.close();
		await handle.close();
	});
});

describe("Agent", () => {
	test("run delegates to provider and injects the tool registry", async () => {
		let seen: RunInput | undefined;

		class SpyProvider extends Provider {
			readonly id = "spy";
			async listModels(): Promise<ProviderResult<ModelInfo[]>> {
				return { ok: true, value: [] };
			}
			async *run(input: RunInput): AsyncIterable<ProviderEvent> {
				seen = input;
				yield { type: "done", stopReason: "stop" };
			}
		}

		const tools = new ToolRegistry([new EchoTool()]);
		const agent = new Agent(new SpyProvider(), tools);

		const events = await collect(
			agent.run({
				model: "m",
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		expect(events).toEqual([{ type: "done", stopReason: "stop" }]);
		expect(seen?.tools).toBe(tools);
		expect(seen?.messages).toEqual([{ role: "user", content: "hi" }]);
	});
});

function makeFakeOllama(
	scripts: Array<{
		content?: string;
		toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
	}>,
): OllamaClientLike {
	let call = 0;
	return {
		async list() {
			return { models: [{ name: "llama3.2:1b" }] };
		},
		async chat(_req) {
			const script = scripts[call++];
			if (!script) throw new Error("no more scripted chat responses");
			const { content, toolCalls } = script;
			async function* gen() {
				if (content) {
					yield { message: { role: "assistant", content } };
				}
				if (toolCalls?.length) {
					yield {
						message: {
							role: "assistant",
							content: "",
							tool_calls: toolCalls.map((c) => ({
								function: { name: c.name, arguments: c.input },
							})),
						},
					};
				}
				yield { done: true };
			}
			const iter = gen();
			return Object.assign(iter, { abort: () => {} }) as never;
		},
	};
}

describe("OllamaProvider", () => {
	test("listModels maps ollama.list response to ModelInfo", async () => {
		const provider = new OllamaProvider({
			client: {
				list: async () => ({ models: [{ name: "llama3.2:1b" }] }),
				chat: async () => {
					throw new Error("unused");
				},
			},
		});
		const result = await provider.listModels();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual([
				{
					id: "llama3.2:1b",
					name: "llama3.2:1b",
					supportsTools: true,
					supportsStreaming: true,
				},
			]);
		}
	});

	test("listModels returns unreachable error when client throws", async () => {
		const provider = new OllamaProvider({
			client: {
				list: async () => {
					throw new Error("connection refused");
				},
				chat: async () => {
					throw new Error("unused");
				},
			},
		});
		const result = await provider.listModels();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unreachable");
	});

	test("run without tools yields delta + text + done", async () => {
		const provider = new OllamaProvider({
			client: makeFakeOllama([{ content: "hello" }]),
		});
		const events = await collect(
			provider.run({ model: "llama3.2:1b", messages: [] }),
		);
		expect(events).toEqual([
			{ type: "assistant_text_delta", text: "hello" },
			{ type: "assistant_text", text: "hello" },
			{ type: "done", stopReason: "stop" },
		]);
	});

	test("run dispatches tool calls through the ToolRegistry", async () => {
		const tools = new ToolRegistry([new AddTool()]);
		const provider = new OllamaProvider({
			client: makeFakeOllama([
				{
					content: "calling add",
					toolCalls: [{ name: "add", input: { a: 2, b: 3 } }],
				},
				{ content: "the answer is 5" },
			]),
		});

		const events = await collect(
			provider.run({ model: "llama3.2:1b", messages: [], tools }),
		);

		const toolCallEvent = events.find((e) => e.type === "tool_call");
		expect(toolCallEvent).toBeDefined();
		if (toolCallEvent?.type === "tool_call") {
			expect(toolCallEvent.call.name).toBe("add");
			expect(toolCallEvent.call.input).toEqual({ a: 2, b: 3 });
		}

		const toolResultEvent = events.find((e) => e.type === "tool_result");
		expect(toolResultEvent).toBeDefined();
		if (toolResultEvent?.type === "tool_result") {
			expect(toolResultEvent.result).toEqual({ ok: true, value: 5 });
		}

		const last = events.at(-1);
		expect(last).toEqual({ type: "done", stopReason: "stop" });
	});

	test("parallel tool calls execute concurrently by default", async () => {
		let active = 0;
		let maxActive = 0;

		class SlowTool extends Tool<{ id: string; ms: number }, string> {
			readonly id = "slow";
			readonly description = "Sleeps before returning";
			readonly schema = z.object({ id: z.string(), ms: z.number() });
			async run(inputs: {
				id: string;
				ms: number;
			}): Promise<ToolResult<string>> {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, inputs.ms));
				active--;
				return { ok: true, value: inputs.id };
			}
		}

		const tools = new ToolRegistry([new SlowTool()]);
		const provider = new OllamaProvider({
			client: makeFakeOllama([
				{
					content: "",
					toolCalls: [
						{ name: "slow", input: { id: "a", ms: 25 } },
						{ name: "slow", input: { id: "b", ms: 25 } },
						{ name: "slow", input: { id: "c", ms: 25 } },
					],
				},
				{ content: "done" },
			]),
		});

		await collect(provider.run({ model: "llama3.2:1b", messages: [], tools }));
		expect(maxActive).toBe(3);
	});

	test("parallelToolCalls=false runs tools sequentially", async () => {
		let active = 0;
		let maxActive = 0;

		class SlowTool extends Tool<{ id: string; ms: number }, string> {
			readonly id = "slow";
			readonly description = "Sleeps before returning";
			readonly schema = z.object({ id: z.string(), ms: z.number() });
			async run(inputs: {
				id: string;
				ms: number;
			}): Promise<ToolResult<string>> {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, inputs.ms));
				active--;
				return { ok: true, value: inputs.id };
			}
		}

		const tools = new ToolRegistry([new SlowTool()]);
		const provider = new OllamaProvider({
			client: makeFakeOllama([
				{
					content: "",
					toolCalls: [
						{ name: "slow", input: { id: "a", ms: 20 } },
						{ name: "slow", input: { id: "b", ms: 20 } },
					],
				},
				{ content: "done" },
			]),
		});

		await collect(
			provider.run({
				model: "llama3.2:1b",
				messages: [],
				tools,
				parallelToolCalls: false,
			}),
		);
		expect(maxActive).toBe(1);
	});

	test("unknown tool names surface a ToolRegistry error in tool_result", async () => {
		const tools = new ToolRegistry();
		const provider = new OllamaProvider({
			client: makeFakeOllama([
				{
					content: "",
					toolCalls: [{ name: "missing", input: {} }],
				},
				{ content: "done" },
			]),
		});

		const events = await collect(
			provider.run({ model: "llama3.2:1b", messages: [], tools }),
		);

		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.result.ok).toBe(false);
			if (!toolResult.result.ok) {
				expect(toolResult.result.error.code).toBe("unknown_tool");
			}
		}
	});

	test("aborting the signal stops the stream with aborted reason", async () => {
		const controller = new AbortController();
		const provider = new OllamaProvider({
			client: {
				list: async () => ({ models: [] }),
				async chat(_req) {
					async function* gen() {
						yield { message: { role: "assistant", content: "part " } };
						controller.abort();
						yield { message: { role: "assistant", content: "more" } };
						yield { done: true };
					}
					const iter = gen();
					return Object.assign(iter, { abort: () => {} }) as never;
				},
			},
		});

		const events = await collect(
			provider.run({
				model: "llama3.2:1b",
				messages: [],
				signal: controller.signal,
			}),
		);

		const last = events.at(-1);
		expect(last).toEqual({ type: "done", stopReason: "aborted" });
	});

	test("hits tool_limit when the model loops forever", async () => {
		const tools = new ToolRegistry([new EchoTool()]);
		const scripts = Array.from({ length: 5 }, () => ({
			content: "keep going",
			toolCalls: [{ name: "echo", input: { message: "again" } }],
		}));
		const provider = new OllamaProvider({
			client: makeFakeOllama(scripts),
		});

		const events = await collect(
			provider.run({
				model: "llama3.2:1b",
				messages: [],
				tools,
				maxToolIterations: 3,
			}),
		);

		const last = events.at(-1);
		expect(last).toEqual({ type: "done", stopReason: "tool_limit" });
	});
});

const OLLAMA_INTEGRATION = process.env.OLLAMA_BASE_URL;

describe.skipIf(!OLLAMA_INTEGRATION)("OllamaProvider integration", () => {
	test("listModels talks to a real Ollama server", async () => {
		const provider = new OllamaProvider({ host: OLLAMA_INTEGRATION });
		const result = await provider.listModels();
		expect(result.ok).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import { GeminiProvider } from "./gemini";
import type { ProviderEvent } from "./provider";

class AddTool extends Tool<{ a: number; b: number }, number> {
	readonly id = "add";
	readonly description = "Adds two numbers";
	readonly schema = z.object({ a: z.number(), b: z.number() });

	async run(inputs: { a: number; b: number }): Promise<ToolResult<number>> {
		return { ok: true, value: inputs.a + inputs.b };
	}
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

function fakeGemini(
	scripts: Array<{
		text?: string;
		calls?: Array<{ name: string; args: Record<string, unknown> }>;
	}>,
) {
	let i = 0;
	return {
		models: {
			async generateContentStream() {
				const script = scripts[i++];
				if (!script) throw new Error("no more scripts");
				async function* gen() {
					if (script.text) {
						yield {
							text: script.text,
							functionCalls: undefined,
							candidates: [{ finishReason: "STOP" }],
						};
					}
					if (script.calls?.length) {
						yield {
							text: undefined,
							functionCalls: script.calls.map((c) => ({
								id: crypto.randomUUID(),
								name: c.name,
								args: c.args,
							})),
							candidates: [{ finishReason: undefined }],
						};
					}
				}
				return gen();
			},
		},
	};
}

describe("GeminiProvider", () => {
	test("streams text and done", async () => {
		const provider = new GeminiProvider({
			client: fakeGemini([{ text: "hello gemini" }]) as never,
		});
		const events = await collect(
			provider.run({ model: "gemini-2.5-flash", messages: [] }),
		);
		expect(events.map((e) => e.type)).toEqual([
			"assistant_text_delta",
			"assistant_text",
			"done",
		]);
		const text = events.find((e) => e.type === "assistant_text");
		if (text?.type === "assistant_text") expect(text.text).toBe("hello gemini");
	});

	test("dispatches tool calls through the ToolRegistry", async () => {
		const tools = new ToolRegistry([new AddTool()]);
		const provider = new GeminiProvider({
			client: fakeGemini([
				{ calls: [{ name: "add", args: { a: 2, b: 3 } }] },
				{ text: "five" },
			]) as never,
		});
		const events = await collect(
			provider.run({
				model: "gemini-2.5-flash",
				messages: [{ role: "user", content: "2+3?" }],
				tools,
			}),
		);
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.result).toEqual({ ok: true, value: 5 });
		}
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	test("aborted signal yields aborted done", async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = new GeminiProvider({
			client: fakeGemini([{ text: "unused" }]) as never,
		});
		const events = await collect(
			provider.run({
				model: "gemini-2.5-flash",
				messages: [],
				signal: controller.signal,
			}),
		);
		expect(events).toEqual([{ type: "done", stopReason: "aborted" }]);
	});
});

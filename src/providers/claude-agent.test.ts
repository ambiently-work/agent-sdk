import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "./claude-agent";
import type { ProviderEvent } from "./provider";

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

function fakeQuery(
	messages: SDKMessage[],
): (params: {
	prompt: string | AsyncIterable<unknown>;
	options?: unknown;
}) => AsyncGenerator<SDKMessage, void> {
	return () => {
		async function* gen() {
			for (const m of messages) yield m;
		}
		return gen() as AsyncGenerator<SDKMessage, void>;
	};
}

describe("ClaudeAgentProvider", () => {
	test("maps assistant message text blocks to assistant_text", async () => {
		const provider = new ClaudeAgentProvider({
			streamDeltas: false,
			query: fakeQuery([
				{
					type: "assistant",
					parent_tool_use_id: null,
					uuid: "u1" as never,
					session_id: "s1",
					message: {
						id: "m1",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-6",
						content: [{ type: "text", text: "hello from claude" }],
						stop_reason: "end_turn",
						stop_sequence: null,
						usage: {
							input_tokens: 1,
							output_tokens: 2,
							cache_creation_input_tokens: null,
							cache_read_input_tokens: null,
							server_tool_use: null,
							service_tier: null,
						},
					} as never,
				},
			]) as never,
		});
		const events = await collect(
			provider.run({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		const text = events.find((e) => e.type === "assistant_text");
		expect(text).toBeDefined();
		if (text?.type === "assistant_text") {
			expect(text.text).toBe("hello from claude");
		}
		expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
	});

	test("maps tool_use blocks to tool_call events", async () => {
		const provider = new ClaudeAgentProvider({
			streamDeltas: false,
			query: fakeQuery([
				{
					type: "assistant",
					parent_tool_use_id: null,
					uuid: "u1" as never,
					session_id: "s1",
					message: {
						id: "m1",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-6",
						content: [
							{
								type: "tool_use",
								id: "toolu_1",
								name: "my_tool",
								input: { foo: "bar" },
							},
						],
						stop_reason: "tool_use",
						stop_sequence: null,
						usage: {
							input_tokens: 1,
							output_tokens: 2,
							cache_creation_input_tokens: null,
							cache_read_input_tokens: null,
							server_tool_use: null,
							service_tier: null,
						},
					} as never,
				},
			]) as never,
		});
		const events = await collect(
			provider.run({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "use tool" }],
			}),
		);
		const call = events.find((e) => e.type === "tool_call");
		expect(call).toBeDefined();
		if (call?.type === "tool_call") {
			expect(call.call.name).toBe("my_tool");
			expect(call.call.input).toEqual({ foo: "bar" });
		}
	});

	test("errors on missing user message", async () => {
		const provider = new ClaudeAgentProvider({
			query: fakeQuery([]) as never,
		});
		const events = await collect(
			provider.run({ model: "claude-sonnet-4-6", messages: [] }),
		);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		if (err?.type === "error") expect(err.error.code).toBe("invalid_request");
	});
});

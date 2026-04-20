import { describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexProvider } from "./codex";
import type { ProviderEvent } from "./provider";

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

function scriptedThread(events: ThreadEvent[]) {
	return {
		async runStreamed() {
			async function* gen() {
				for (const e of events) yield e;
			}
			return { events: gen() };
		},
	};
}

function fakeCodex(events: ThreadEvent[]) {
	return {
		startThread: () => scriptedThread(events) as never,
	};
}

describe("CodexProvider", () => {
	test("maps agent_message items to assistant text", async () => {
		const provider = new CodexProvider({
			client: fakeCodex([
				{ type: "thread.started", thread_id: "t1" },
				{ type: "turn.started" },
				{
					type: "item.completed",
					item: { id: "m1", type: "agent_message", text: "hi from codex" },
				},
				{
					type: "turn.completed",
					usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
				},
			]),
		});
		const events = await collect(
			provider.run({
				model: "gpt-5-codex",
				messages: [{ role: "user", content: "hello" }],
			}),
		);
		const text = events.find((e) => e.type === "assistant_text");
		expect(text).toBeDefined();
		if (text?.type === "assistant_text")
			expect(text.text).toBe("hi from codex");
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.stopReason).toBe("stop");
			expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		}
	});

	test("maps command_execution items to tool_call + tool_result", async () => {
		const provider = new CodexProvider({
			client: fakeCodex([
				{ type: "thread.started", thread_id: "t1" },
				{ type: "turn.started" },
				{
					type: "item.started",
					item: {
						id: "c1",
						type: "command_execution",
						command: "ls",
						aggregated_output: "",
						status: "in_progress",
					},
				},
				{
					type: "item.completed",
					item: {
						id: "c1",
						type: "command_execution",
						command: "ls",
						aggregated_output: "README.md\n",
						exit_code: 0,
						status: "completed",
					},
				},
				{
					type: "turn.completed",
					usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
				},
			]),
		});
		const events = await collect(
			provider.run({
				model: "gpt-5-codex",
				messages: [{ role: "user", content: "ls" }],
			}),
		);
		const call = events.find((e) => e.type === "tool_call");
		expect(call).toBeDefined();
		if (call?.type === "tool_call") {
			expect(call.call.name).toBe("exec");
			expect(call.call.input).toEqual({ command: "ls" });
		}
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toBeDefined();
		if (result?.type === "tool_result") {
			expect(result.result).toEqual({ ok: true, value: "README.md\n" });
		}
	});

	test("turn.failed surfaces an error", async () => {
		const provider = new CodexProvider({
			client: fakeCodex([
				{ type: "thread.started", thread_id: "t1" },
				{ type: "turn.started" },
				{ type: "turn.failed", error: { message: "nope" } },
			]),
		});
		const events = await collect(
			provider.run({
				model: "gpt-5-codex",
				messages: [{ role: "user", content: "x" }],
			}),
		);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		if (err?.type === "error") {
			expect(err.error.message).toBe("nope");
		}
	});

	test("returns invalid_request when no trailing user message", async () => {
		const provider = new CodexProvider({ client: fakeCodex([]) });
		const events = await collect(
			provider.run({ model: "gpt-5-codex", messages: [] }),
		);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		if (err?.type === "error") expect(err.error.code).toBe("invalid_request");
	});
});

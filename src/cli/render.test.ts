import { describe, expect, test } from "bun:test";
import { EventRenderer } from "./render";

function makeStream(): NodeJS.WriteStream & { captured: string } {
	const chunks: string[] = [];
	const stream = {
		isTTY: false,
		captured: "",
		write(data: string): boolean {
			chunks.push(data);
			stream.captured = chunks.join("");
			return true;
		},
	} as unknown as NodeJS.WriteStream & { captured: string };
	return stream;
}

describe("EventRenderer", () => {
	test("streams assistant text deltas and finalizes with newline", () => {
		const stream = makeStream();
		const r = new EventRenderer({ stream, color: false });
		r.handle({ type: "assistant_text_delta", text: "hello" });
		r.handle({ type: "assistant_text_delta", text: " world" });
		r.handle({ type: "assistant_text", text: "hello world" });
		expect(stream.captured).toBe("assistant> hello world\n");
	});

	test("renders tool call and result", () => {
		const stream = makeStream();
		const r = new EventRenderer({ stream, color: false });
		r.handle({
			type: "tool_call",
			call: { id: "1", name: "echo", input: { message: "hi" } },
		});
		r.handle({
			type: "tool_result",
			id: "1",
			result: { ok: true, value: "HI" },
		});
		expect(stream.captured).toContain("→ tool echo");
		expect(stream.captured).toContain("← ok");
		expect(stream.captured).toContain('"HI"');
	});

	test("renders tool error", () => {
		const stream = makeStream();
		const r = new EventRenderer({ stream, color: false });
		r.handle({
			type: "tool_result",
			id: "1",
			result: {
				ok: false,
				error: { code: "tool_failed", message: "nope" },
			},
		});
		expect(stream.captured).toContain("← err");
		expect(stream.captured).toContain("tool_failed: nope");
	});

	test("renders done with usage", () => {
		const stream = makeStream();
		const r = new EventRenderer({ stream, color: false });
		r.handle({
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		expect(stream.captured).toContain("[done]");
		expect(stream.captured).toContain("in=10 out=5");
	});

	test("renders provider error", () => {
		const stream = makeStream();
		const r = new EventRenderer({ stream, color: false });
		r.handle({
			type: "error",
			error: { code: "unreachable", message: "no ollama" },
		});
		expect(stream.captured).toContain("[error]");
		expect(stream.captured).toContain("unreachable: no ollama");
	});
});

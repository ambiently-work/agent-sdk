import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Tool, ToolRegistry, type ToolResult } from "./tools";

class EchoTool extends Tool<{ message: string }, string> {
	readonly id = "echo";
	readonly description = "Echoes the input message";
	readonly schema = z.object({ message: z.string() });

	async run(inputs: { message: string }): Promise<ToolResult<string>> {
		return { ok: true, value: inputs.message };
	}
}

class FailingTool extends Tool<{ reason: string }, never> {
	readonly id = "fail";
	readonly description = "Always fails";
	readonly schema = z.object({ reason: z.string() });

	async run(inputs: { reason: string }): Promise<ToolResult<never>> {
		return {
			ok: false,
			error: { code: "tool_failed", message: inputs.reason },
		};
	}
}

describe("Tool.parse", () => {
	test("returns ok with parsed value for valid input", () => {
		const tool = new EchoTool();
		const result = tool.parse({ message: "hi" });
		expect(result).toEqual({ ok: true, value: { message: "hi" } });
	});

	test("returns invalid_input error for bad input", () => {
		const tool = new EchoTool();
		const result = tool.parse({ message: 42 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("invalid_input");
			if (result.error.code === "invalid_input") {
				expect(result.error.issues.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("ToolRegistry", () => {
	test("registers and lists tools", () => {
		const registry = new ToolRegistry([new EchoTool()]);
		expect(registry.list().map((t) => t.id)).toEqual(["echo"]);
		expect(registry.get("echo")?.id).toBe("echo");
	});

	test("register rejects duplicate ids", () => {
		const registry = new ToolRegistry([new EchoTool()]);
		const result = registry.register(new EchoTool());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("duplicate_tool");
	});

	test("run dispatches to matching tool", async () => {
		const registry = new ToolRegistry([new EchoTool()]);
		const result = await registry.run({
			tool: "echo",
			inputs: { message: "hello" },
		});
		expect(result).toEqual({ ok: true, value: "hello" });
	});

	test("run returns unknown_tool for missing tool", async () => {
		const registry = new ToolRegistry();
		const result = await registry.run({ tool: "missing", inputs: {} });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_tool");
	});

	test("run returns invalid_input for bad inputs", async () => {
		const registry = new ToolRegistry([new EchoTool()]);
		const result = await registry.run({ tool: "echo", inputs: {} });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_input");
	});

	test("run propagates tool_failed result", async () => {
		const registry = new ToolRegistry([new FailingTool()]);
		const result = await registry.run({
			tool: "fail",
			inputs: { reason: "nope" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("tool_failed");
			expect(result.error.message).toBe("nope");
		}
	});
});

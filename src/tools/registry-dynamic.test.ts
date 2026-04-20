import { describe, expect, test } from "bun:test";
import { DynamicTool } from "./dynamic-tool";
import { ToolRegistry } from "./tools";

const echoSource = `
defineTool({
  id: "echo",
  description: "Echoes a message",
  schema: z.object({ message: z.string() }),
  async run({ message }) {
    return { ok: true, value: message };
  },
});
`;

describe("DynamicTool + ToolRegistry", () => {
	test("compiles, registers and runs through ToolRegistry", async () => {
		const compiled = await DynamicTool.fromSource(echoSource);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;

		const registry = new ToolRegistry();
		const registered = registry.register(compiled.value);
		expect(registered.ok).toBe(true);
		expect(registry.list().map((t) => t.id)).toEqual(["echo"]);

		const result = await registry.run({
			tool: "echo",
			inputs: { message: "hi" },
		});
		expect(result).toEqual({ ok: true, value: "hi" });
	}, 30_000);

	test("surfaces duplicate_tool when the registry already has the id", async () => {
		const registry = new ToolRegistry();

		const first = await DynamicTool.fromSource(echoSource);
		expect(first.ok).toBe(true);
		if (first.ok) expect(registry.register(first.value).ok).toBe(true);

		const second = await DynamicTool.fromSource(echoSource);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const dup = registry.register(second.value);
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error.code).toBe("duplicate_tool");
	}, 30_000);

	test("propagates sandbox failure for broken source", async () => {
		const result = await DynamicTool.fromSource("not js {{");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["sandbox_compile_failed", "sandbox_load_failed"]).toContain(
				result.error.code,
			);
		}
	}, 30_000);

	test("propagates sandbox failure when defineTool is never called", async () => {
		const result = await DynamicTool.fromSource("globalThis.x = 1;");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(["sandbox_load_failed", "sandbox_runtime_error"]).toContain(
				result.error.code,
			);
		}
	}, 30_000);
});

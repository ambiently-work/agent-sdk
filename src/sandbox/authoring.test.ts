import { describe, expect, test } from "bun:test";
import { DynamicTool } from "../tools/dynamic-tool";
import { compileTool } from "./authoring";

describe("compileTool", () => {
	test("transpiles TS source, loads it, and returns js + meta", async () => {
		const tsSource = `
			interface Inputs { name: string; }
			defineTool({
				id: "greeter",
				description: "Greets a user",
				schema: z.object({ name: z.string() }),
				async run({ name }: Inputs) {
					return { ok: true, value: \`Hello, \${name}\` };
				},
			});
		`;
		const compiled = await compileTool(tsSource);
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) return;
		expect(compiled.value.meta.id).toBe("greeter");
		expect(compiled.value.js).not.toMatch(/interface Inputs/);

		// The compiled JS should round-trip through DynamicTool
		const tool = await DynamicTool.fromSource(compiled.value.js);
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;
		const result = await tool.value.run({ name: "Luca" });
		expect(result).toEqual({ ok: true, value: "Hello, Luca" });
	});

	test("returns sandbox_compile_failed for invalid TypeScript", async () => {
		const compiled = await compileTool("defineTool({ id: }))");
		expect(compiled.ok).toBe(false);
		if (!compiled.ok)
			expect(compiled.error.code).toBe("sandbox_compile_failed");
	});
});

import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@ambiently-work/faux";
import { fetchCapability } from "../sandbox/capabilities";
import { DynamicTool } from "./dynamic-tool";

const echoSource = `
defineTool({
  id: "echo",
  description: "Echoes a message",
  schema: z.object({ message: z.string() }),
  async run({ message }) {
    return { ok: true, value: message.toUpperCase() };
  },
});
`;

describe("DynamicTool", () => {
	test("loads source, exposes meta, runs through registry", async () => {
		const tool = await DynamicTool.fromSource(echoSource);
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;
		expect(tool.value.id).toBe("echo");
		expect(tool.value.description).toBe("Echoes a message");

		const registry = new ToolRegistry();
		registry.register(tool.value);
		const result = await registry.run({
			tool: "echo",
			inputs: { message: "hi" },
		});
		expect(result).toEqual({ ok: true, value: "HI" });
	});

	test("propagates invalid_input from guest validation", async () => {
		const tool = await DynamicTool.fromSource(echoSource);
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;
		const result = await tool.value.run({ message: 42 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_input");
	});

	test("propagates sandbox failure for syntactically broken source", async () => {
		const tool = await DynamicTool.fromSource("this is not valid javascript {");
		expect(tool.ok).toBe(false);
		if (!tool.ok) {
			expect(["sandbox_compile_failed", "sandbox_load_failed"]).toContain(
				tool.error.code,
			);
		}
	}, 60_000);

	test("returns sandbox_load_failed when defineTool is never called", async () => {
		const tool = await DynamicTool.fromSource("globalThis.x = 1;");
		expect(tool.ok).toBe(false);
		if (!tool.ok) {
			expect(["sandbox_load_failed", "sandbox_runtime_error"]).toContain(
				tool.error.code,
			);
		}
	});

	test("returns sandbox_timeout for runaway loops", async () => {
		const source = `
			defineTool({
				id: "loop",
				description: "Loops forever",
				schema: z.object({}),
				async run() {
					while (true) {}
				},
			});
		`;
		const tool = await DynamicTool.fromSource(source, { timeoutMs: 200 });
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;
		const result = await tool.value.run({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("sandbox_timeout");
	}, 10_000);

	// Covered by workerd.test.ts; exercising the same flow twice through DynamicTool
	// (fromSource + run = two sequential miniflare spawns) is flaky under the suite.
	test("uses fetch capability with allowlist", async () => {
		const fakeFetch = async () =>
			new Response('{"city":"Amsterdam","temp":12}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const source = `
			defineTool({
				id: "weather",
				description: "Get weather",
				schema: z.object({ city: z.string() }),
				async run({ city }) {
					const res = await host.fetch("https://api.example.com/weather?city=" + city);
					if (res.status !== 200) return { ok: false, error: { code: "tool_failed", message: "bad status" } };
					return { ok: true, value: JSON.parse(res.body) };
				},
			});
		`;
		const tool = await DynamicTool.fromSource(source, {
			capabilities: [
				fetchCapability({
					allow: (u) => u.host === "api.example.com",
					fetchImpl: fakeFetch,
				}),
			],
		});
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;

		const result = await tool.value.run({ city: "Amsterdam" });
		expect(result).toEqual({
			ok: true,
			value: { city: "Amsterdam", temp: 12 },
		});
	}, 60_000);

	test("denies fetch outside allowlist", async () => {
		const source = `
			defineTool({
				id: "fetcher",
				description: "Fetch",
				schema: z.object({ url: z.string() }),
				async run({ url }) {
					const res = await host.fetch(url);
					return { ok: true, value: res.body };
				},
			});
		`;
		const tool = await DynamicTool.fromSource(source, {
			capabilities: [
				fetchCapability({
					allow: (u) => u.host === "ok.example",
					fetchImpl: async () => new Response("x"),
				}),
			],
		});
		expect(tool.ok).toBe(true);
		if (!tool.ok) return;

		const result = await tool.value.run({ url: "https://blocked.example/" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("sandbox_capability_denied");
	}, 60_000);
});

import { describe, expect, test } from "bun:test";
import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import { z } from "zod";
import type { ToolCache } from "./memoization";
import { memoizeRegistry } from "./memoized-tools";

class CountingTool extends Tool<{ q: string }, { echoed: string }> {
	readonly id = "echo";
	readonly description = "echoes";
	readonly schema = z.object({ q: z.string() });
	calls = 0;
	async run({ q }: { q: string }): Promise<ToolResult<{ echoed: string }>> {
		this.calls++;
		return { ok: true, value: { echoed: q } };
	}
}

describe("memoizeRegistry", () => {
	test("caches successful calls by (nodeId, tool, inputsHash)", async () => {
		const base = new CountingTool();
		const registry = new ToolRegistry([base]);
		const cache: ToolCache = {};
		const memoed = memoizeRegistry(registry, {
			nodeId: "n1",
			cache,
			policy: { scope: "node", sharedWith: [] },
		});
		const r1 = await memoed.run({ tool: "echo", inputs: { q: "hi" } });
		const r2 = await memoed.run({ tool: "echo", inputs: { q: "hi" } });
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(base.calls).toBe(1);
		// Cache entry recorded
		expect(Object.keys(cache).length).toBe(1);
	});

	test("different inputs bypass cache", async () => {
		const base = new CountingTool();
		const registry = new ToolRegistry([base]);
		const cache: ToolCache = {};
		const memoed = memoizeRegistry(registry, {
			nodeId: "n1",
			cache,
			policy: { scope: "node", sharedWith: [] },
		});
		await memoed.run({ tool: "echo", inputs: { q: "a" } });
		await memoed.run({ tool: "echo", inputs: { q: "b" } });
		expect(base.calls).toBe(2);
		expect(Object.keys(cache).length).toBe(2);
	});

	test("plan-scoped cache shares across nodes", async () => {
		const base = new CountingTool();
		const registry = new ToolRegistry([base]);
		const cache: ToolCache = {};
		const a = memoizeRegistry(registry, {
			nodeId: "a",
			cache,
			policy: { scope: "plan", sharedWith: [] },
		});
		const b = memoizeRegistry(registry, {
			nodeId: "b",
			cache,
			policy: { scope: "plan", sharedWith: [] },
		});
		await a.run({ tool: "echo", inputs: { q: "x" } });
		await b.run({ tool: "echo", inputs: { q: "x" } });
		expect(base.calls).toBe(1);
	});

	test("node scope isolates by default", async () => {
		const base = new CountingTool();
		const registry = new ToolRegistry([base]);
		const cache: ToolCache = {};
		const a = memoizeRegistry(registry, {
			nodeId: "a",
			cache,
			policy: { scope: "node", sharedWith: [] },
		});
		const b = memoizeRegistry(registry, {
			nodeId: "b",
			cache,
			policy: { scope: "node", sharedWith: [] },
		});
		await a.run({ tool: "echo", inputs: { q: "x" } });
		await b.run({ tool: "echo", inputs: { q: "x" } });
		expect(base.calls).toBe(2);
	});

	test("sharedWith on node scope opens the cache to listed siblings", async () => {
		const base = new CountingTool();
		const registry = new ToolRegistry([base]);
		const cache: ToolCache = {};
		const a = memoizeRegistry(registry, {
			nodeId: "a",
			cache,
			policy: { scope: "node", sharedWith: ["b"] },
		});
		const b = memoizeRegistry(registry, {
			nodeId: "b",
			cache,
			policy: { scope: "node", sharedWith: [] },
		});
		await a.run({ tool: "echo", inputs: { q: "x" } });
		await b.run({ tool: "echo", inputs: { q: "x" } });
		expect(base.calls).toBe(1);
	});

	test("allowed list filters available tools", () => {
		const base = new CountingTool();
		const other = new (class extends Tool<{ n: number }, number> {
			readonly id = "other";
			readonly description = "other";
			readonly schema = z.object({ n: z.number() });
			async run({ n }: { n: number }): Promise<ToolResult<number>> {
				return { ok: true, value: n };
			}
		})();
		const registry = new ToolRegistry([base, other]);
		const cache: ToolCache = {};
		const memoed = memoizeRegistry(
			registry,
			{
				nodeId: "n",
				cache,
				policy: { scope: "node", sharedWith: [] },
			},
			["echo"],
		);
		expect(memoed.list().map((t) => t.id)).toEqual(["echo"]);
	});
});

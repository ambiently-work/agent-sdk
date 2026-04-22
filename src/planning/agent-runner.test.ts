import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type ModelInfo,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "../providers/provider";
import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import { AgentNodeRunner } from "./agent-runner";
import type { PlanEvent } from "./events";
import type { ToolCache } from "./memoization";
import { StaticModelRouter } from "./model-router";
import type { PlanNode } from "./plan";
import type { NodeRunContext } from "./runner";

// ---------------------------------------------------------------------------
// Test harness — scripted provider that optionally invokes one or more tools
// then ends with `done`.
// ---------------------------------------------------------------------------

type Script =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; input: Record<string, unknown> };

class ScriptedProvider extends Provider {
	readonly id: string;
	calls: RunInput[] = [];
	constructor(
		id: string,
		private readonly scripts: Script[] | ((input: RunInput) => Script[]),
		private readonly reportUsage: {
			inputTokens: number;
			outputTokens: number;
		} = {
			inputTokens: 100,
			outputTokens: 50,
		},
	) {
		super();
		this.id = id;
	}
	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		return { ok: true, value: [{ id: "m", name: "m", supportsTools: true }] };
	}
	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		this.calls.push(input);
		const scripts =
			typeof this.scripts === "function" ? this.scripts(input) : this.scripts;
		for (const s of scripts) {
			if (s.kind === "text") {
				yield { type: "assistant_text", text: s.text };
			} else {
				const id = `call-${s.name}-${Math.random().toString(36).slice(2, 8)}`;
				yield {
					type: "tool_call",
					call: { id, name: s.name, input: s.input },
				};
				if (input.tools) {
					const result = await input.tools.run({
						tool: s.name,
						inputs: s.input,
					});
					yield { type: "tool_result", id, result };
				}
			}
		}
		yield { type: "done", stopReason: "stop", usage: this.reportUsage };
	}
}

function sev(
	grade: "low" | "medium" | "high" | "critical" = "low",
): PlanNode["severity"] {
	return {
		impact: "local",
		reversibility: "trivial",
		grade,
		rationale: "t",
	};
}

function baseProps(id: string) {
	return {
		id,
		title: id,
		description: "",
		status: "pending" as const,
		dependsOn: [],
		needsExpansion: false,
		severity: sev(),
		attempts: 0,
		annotations: [],
	};
}

function makeContext(node: PlanNode): {
	ctx: NodeRunContext;
	events: PlanEvent[];
	cache: ToolCache;
} {
	const events: PlanEvent[] = [];
	const cache: ToolCache = {};
	const ctx: NodeRunContext = {
		plan: {} as never,
		node,
		inputs: {},
		emit: (e) => events.push(e),
		signal: new AbortController().signal,
		cache,
	};
	return { ctx, events, cache };
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.decide", () => {
	test("routes decide phase to the smart tier", async () => {
		const smart = new ScriptedProvider("smart", [
			{
				kind: "tool",
				name: "submit_decision",
				input: {
					chosenOptionId: "opt-a",
					rationale: "it's simpler",
					confidence: "high",
				},
			},
		]);
		const fast = new ScriptedProvider("fast", []);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("decide-1"),
			type: "decide",
			question: "which path?",
			options: [
				{ id: "opt-a", label: "A" },
				{ id: "opt-b", label: "B" },
			],
			criteria: [],
			forceHuman: false,
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(smart.calls).toHaveLength(1);
		expect(smart.calls[0]?.model).toBe("opus");
		expect(fast.calls).toHaveLength(0);
		const out = result.output as { chosenOptionId: string; source: string };
		expect(out.chosenOptionId).toBe("opt-a");
		expect(out.source).toBe("agent");
	});

	test("rejects chosenOptionId not in options list via schema", async () => {
		const smart = new ScriptedProvider("smart", [
			{
				kind: "tool",
				name: "submit_decision",
				input: {
					chosenOptionId: "nope",
					rationale: "won't work",
				},
			},
		]);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: smart, model: "opus" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("decide-2"),
			type: "decide",
			question: "q",
			options: [{ id: "opt-a", label: "A" }],
			criteria: [],
			forceHuman: false,
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		// Schema rejection means submit_decision's run was invalid → no capture → no_decision
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("no_decision");
	});
});

// ---------------------------------------------------------------------------
// Research — two phases, different tiers
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.research", () => {
	test("gathers with fast tier, concludes with smart tier", async () => {
		const fast = new ScriptedProvider("fast", [
			{ kind: "text", text: "observed foo and bar" },
		]);
		const smart = new ScriptedProvider("smart", [
			{
				kind: "tool",
				name: "submit_findings",
				input: {
					summary: "foo and bar present",
					findings: ["foo", "bar"],
					confidence: "high",
					openQuestions: [],
				},
			},
		]);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("r1"),
			type: "research",
			questions: ["is foo present?"],
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fast.calls).toHaveLength(1);
		expect(smart.calls).toHaveLength(1);
		expect(fast.calls[0]?.model).toBe("haiku");
		expect(smart.calls[0]?.model).toBe("opus");
		const out = result.output as { findings: string[]; summary: string };
		expect(out.findings).toEqual(["foo", "bar"]);
		// Usage is summed across both phases
		expect(result.usage.inputTokens).toBe(200);
		expect(result.usage.outputTokens).toBe(100);
	});

	test("uses memoized base tools during gather", async () => {
		// One base tool the gather agent calls twice with the same inputs.
		class EchoTool extends Tool<{ q: string }, { r: string }> {
			readonly id = "echo";
			readonly description = "echo";
			readonly schema = z.object({ q: z.string() });
			calls = 0;
			async run({ q }: { q: string }): Promise<ToolResult<{ r: string }>> {
				this.calls++;
				return { ok: true, value: { r: q } };
			}
		}
		const echo = new EchoTool();
		const fast = new ScriptedProvider("fast", [
			{ kind: "tool", name: "echo", input: { q: "same" } },
			{ kind: "tool", name: "echo", input: { q: "same" } },
			{ kind: "text", text: "done gathering" },
		]);
		const smart = new ScriptedProvider("smart", [
			{
				kind: "tool",
				name: "submit_findings",
				input: {
					summary: "cached repeat",
					findings: [],
					confidence: "low",
					openQuestions: [],
				},
			},
		]);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const runner = new AgentNodeRunner({
			router,
			tools: new ToolRegistry([echo]),
		});
		const node: PlanNode = {
			...baseProps("r2"),
			type: "research",
			questions: ["q"],
			allowedTools: ["echo"],
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		// Second echo call must hit the cache, base tool only runs once.
		expect(echo.calls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Do
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.do", () => {
	test("executes with fast tier and a submit_action finalize", async () => {
		const fast = new ScriptedProvider("fast", [
			{
				kind: "tool",
				name: "submit_action",
				input: {
					summary: "applied",
					outputs: { id: "42" },
					sideEffects: ["wrote row"],
				},
			},
		]);
		const smart = new ScriptedProvider("smart", []);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("d1"),
			type: "do",
			action: "apply migration",
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fast.calls).toHaveLength(1);
		expect(smart.calls).toHaveLength(0);
		const out = result.output as { summary: string; outputs: { id: string } };
		expect(out.summary).toBe("applied");
		expect(out.outputs.id).toBe("42");
	});
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.verify", () => {
	test("returns passed=false when verification fails", async () => {
		const fast = new ScriptedProvider("fast", [
			{
				kind: "tool",
				name: "submit_verification",
				input: { passed: false, details: "row missing" },
			},
		]);
		const router = new StaticModelRouter({
			smart: { provider: fast, model: "m" },
			fast: { provider: fast, model: "m" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("v1"),
			type: "verify",
			check: "row exists",
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const out = result.output as { passed: boolean; details: string };
		expect(out.passed).toBe(false);
		expect(out.details).toBe("row missing");
	});

	test("surfaces transient errors from the provider", async () => {
		class FailingProvider extends Provider {
			readonly id = "fail";
			async listModels(): Promise<ProviderResult<ModelInfo[]>> {
				return { ok: true, value: [] };
			}
			async *run(_input: RunInput): AsyncIterable<ProviderEvent> {
				yield {
					type: "error",
					error: { code: "rate_limited", message: "slow down" },
				};
			}
		}
		const provider = new FailingProvider();
		const router = new StaticModelRouter({
			smart: { provider, model: "m" },
			fast: { provider, model: "m" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("v2"),
			type: "verify",
			check: "x",
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("rate_limited");
		expect(result.transient).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.discover", () => {
	test("runs gather+conclude with tiered models", async () => {
		const fast = new ScriptedProvider("fast", [
			{ kind: "text", text: "saw 3 undocumented endpoints" },
		]);
		const smart = new ScriptedProvider("smart", [
			{
				kind: "tool",
				name: "submit_discoveries",
				input: {
					summary: "3 unknowns",
					discoveries: ["/x", "/y", "/z"],
					unknowns: [],
					suggestedNextNodes: [],
				},
			},
		]);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("disc1"),
			type: "discover",
			scope: "api surface",
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(fast.calls).toHaveLength(1);
		expect(smart.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Group rejection
// ---------------------------------------------------------------------------

describe("AgentNodeRunner.group", () => {
	test("refuses to run group nodes", async () => {
		const fast = new ScriptedProvider("fast", []);
		const router = new StaticModelRouter({
			smart: { provider: fast, model: "m" },
			fast: { provider: fast, model: "m" },
		});
		const runner = new AgentNodeRunner({ router });
		const node: PlanNode = {
			...baseProps("g1"),
			type: "group",
			mode: "sequence",
			children: [],
		};
		const { ctx } = makeContext(node);
		const result = await runner.run(ctx);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("not_a_leaf");
	});
});

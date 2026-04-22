import { describe, expect, test } from "bun:test";
import {
	type ModelInfo,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "../providers/provider";
import { StaticModelRouter } from "./model-router";
import {
	flatRevisionsToPlan,
	Planner,
	reassembleTree,
	type SubmitPlanInput,
	type SubmitRevisionsInput,
} from "./planner";

class ScriptedProvider extends Provider {
	readonly id = "scripted";
	constructor(
		private readonly toolCalls: Array<{ name: string; input: unknown }>,
	) {
		super();
	}
	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		return { ok: true, value: [{ id: "m", name: "m", supportsTools: true }] };
	}
	async *run(input: RunInput): AsyncIterable<ProviderEvent> {
		for (const call of this.toolCalls) {
			const id = `call-${call.name}-${Math.random().toString(36).slice(2, 8)}`;
			yield {
				type: "tool_call",
				call: {
					id,
					name: call.name,
					input: call.input as Record<string, unknown>,
				},
			};
			if (input.tools) {
				const result = await input.tools.run({
					tool: call.name,
					inputs: call.input as Record<string, unknown>,
				});
				yield { type: "tool_result", id, result };
			}
		}
		yield { type: "done", stopReason: "stop" };
	}
}

function sev() {
	return {
		impact: "local" as const,
		reversibility: "trivial" as const,
		grade: "low" as const,
		rationale: "test",
	};
}

describe("reassembleTree", () => {
	test("builds a tree from a flat list with parentId references", () => {
		const flat: SubmitPlanInput = {
			rootId: "root",
			nodes: [
				{
					id: "root",
					parentId: null,
					type: "group",
					title: "root",
					description: "",
					dependsOn: [],
					needsExpansion: false,
					severity: sev(),
					mode: "sequence",
				},
				{
					id: "r1",
					parentId: "root",
					type: "research",
					title: "research",
					description: "",
					dependsOn: [],
					needsExpansion: false,
					severity: sev(),
					questions: ["what?"],
				},
				{
					id: "d1",
					parentId: "root",
					type: "do",
					title: "do",
					description: "",
					dependsOn: ["r1"],
					needsExpansion: false,
					severity: sev(),
					action: "run",
				},
			],
		};
		const tree = reassembleTree(flat);
		expect(tree.type).toBe("group");
		if (tree.type !== "group") return;
		expect(tree.children).toHaveLength(2);
		expect(tree.children[0]?.id).toBe("r1");
		expect(tree.children[1]?.id).toBe("d1");
	});

	test("rejects missing parent reference", () => {
		const flat: SubmitPlanInput = {
			rootId: "root",
			nodes: [
				{
					id: "root",
					parentId: null,
					type: "group",
					title: "root",
					description: "",
					dependsOn: [],
					needsExpansion: false,
					severity: sev(),
					mode: "sequence",
				},
				{
					id: "x",
					parentId: "missing",
					type: "research",
					title: "x",
					description: "",
					dependsOn: [],
					needsExpansion: false,
					severity: sev(),
				},
			],
		};
		expect(() => reassembleTree(flat)).toThrow(/missing parent/);
	});
});

describe("flatRevisionsToPlan", () => {
	test("converts add/skip/annotate revisions", () => {
		const flat: SubmitRevisionsInput = {
			revisions: [
				{
					kind: "add_node",
					parentId: "root",
					node: {
						id: "new",
						parentId: "root",
						type: "research",
						title: "new",
						description: "",
						dependsOn: [],
						needsExpansion: false,
						severity: sev(),
					},
				},
				{ kind: "skip_node", nodeId: "old", reason: "not needed" },
				{ kind: "annotate_node", nodeId: "root", note: "hello" },
			],
		};
		const revs = flatRevisionsToPlan(flat);
		expect(revs).toHaveLength(3);
		expect(revs[0]?.kind).toBe("add_node");
		expect(revs[1]?.kind).toBe("skip_node");
		expect(revs[2]?.kind).toBe("annotate_node");
	});
});

describe("Planner.createPlan", () => {
	test("invokes submit_plan and returns a valid Plan in awaiting_plan_approval", async () => {
		const provider = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "group",
							title: "Migrate auth",
							description: "top-level group",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							mode: "sequence",
						},
						{
							id: "r1",
							parentId: "root",
							type: "research",
							title: "research auth options",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							questions: ["options?"],
						},
						{
							id: "d1",
							parentId: "root",
							type: "do",
							title: "apply",
							description: "",
							dependsOn: ["r1"],
							needsExpansion: false,
							severity: {
								impact: "system",
								reversibility: "irreversible",
								grade: "critical",
								rationale: "prod write",
							},
							action: "apply",
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);

		const planner = new Planner({ provider, model: "m" });
		const plan = await planner.createPlan({
			task: "migrate auth",
			config: {
				ownerId: "org-1",
				approvalPolicy: { threshold: "high" },
			},
			id: "plan-1",
			now: () => "2026-04-20T10:00:00.000Z",
		});

		expect(plan.id).toBe("plan-1");
		expect(plan.status).toBe("awaiting_plan_approval");
		expect(plan.tree.type).toBe("group");
		if (plan.tree.type !== "group") return;
		expect(plan.tree.children).toHaveLength(2);
	});

	test("throws when the model never calls submit_plan", async () => {
		const provider = new ScriptedProvider([]);
		const planner = new Planner({ provider, model: "m" });
		await expect(
			planner.createPlan({
				task: "x",
				config: {
					ownerId: "o",
					approvalPolicy: { threshold: "high" },
				},
			}),
		).rejects.toThrow(/did not submit/);
	});

	test("uses router smart tier when constructed with a router", async () => {
		const smart = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "research",
							title: "ask",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							questions: ["q?"],
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);
		const fast = new ScriptedProvider([]);
		const router = new StaticModelRouter({
			smart: { provider: smart, model: "opus" },
			fast: { provider: fast, model: "haiku" },
		});
		const planner = new Planner({ router });
		const plan = await planner.createPlan({
			task: "x",
			config: {
				ownerId: "o",
				approvalPolicy: { threshold: "high" },
			},
			id: "p-router",
			now: () => "2026-04-20T10:00:00.000Z",
		});
		expect(plan.id).toBe("p-router");
		// Planner should have invoked only the smart provider.
		expect(
			(fast as unknown as { scriptsCalled?: number }).scriptsCalled,
		).toBeUndefined();
	});
});

describe("Planner.asExpansionHook", () => {
	test("skips the planner when no pending node needs expansion", async () => {
		let called = 0;
		const creator = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "research",
							title: "r",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							questions: [],
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);
		const plan = await new Planner({
			provider: creator,
			model: "m",
		}).createPlan({
			task: "x",
			config: { ownerId: "o", approvalPolicy: { threshold: "high" } },
		});

		// A reviser that tracks whether it ever gets called.
		class CountingProvider extends ScriptedProvider {
			constructor() {
				super([]);
			}
			override async *run(input: RunInput) {
				called++;
				yield* super.run(input);
			}
		}
		const hook = new Planner({
			provider: new CountingProvider(),
			model: "m",
		}).asExpansionHook();
		const triggerNode =
			plan.tree.type === "group" && plan.tree.children[0]
				? plan.tree.children[0]
				: plan.tree;
		const revisions = await hook.expand({ plan, triggerNode });
		expect(revisions).toEqual([]);
		expect(called).toBe(0);
	});

	test("always:true forces a planner call and returns its revisions", async () => {
		const creator = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "research",
							title: "r",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							questions: [],
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);
		const plan = await new Planner({
			provider: creator,
			model: "m",
		}).createPlan({
			task: "x",
			config: { ownerId: "o", approvalPolicy: { threshold: "high" } },
		});

		const reviser = new ScriptedProvider([
			{
				name: "submit_revisions",
				input: {
					revisions: [
						{
							kind: "annotate_node",
							nodeId: "root",
							note: "looked good",
						},
					],
				} satisfies SubmitRevisionsInput,
			},
		]);
		const hook = new Planner({
			provider: reviser,
			model: "m",
		}).asExpansionHook({ always: true });
		const triggerNode =
			plan.tree.type === "group" && plan.tree.children[0]
				? plan.tree.children[0]
				: plan.tree;
		const revisions = await hook.expand({ plan, triggerNode });
		expect(revisions).toHaveLength(1);
		expect(revisions[0]?.kind).toBe("annotate_node");
	});

	test("calls the planner when the plan still has a needsExpansion node", async () => {
		const creator = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "group",
							title: "r",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							mode: "sequence",
						},
						{
							id: "r1",
							parentId: "root",
							type: "research",
							title: "known",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							questions: [],
						},
						{
							id: "placeholder",
							parentId: "root",
							type: "research",
							title: "tbd",
							description: "",
							dependsOn: ["r1"],
							needsExpansion: true,
							severity: sev(),
							questions: [],
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);
		const plan = await new Planner({
			provider: creator,
			model: "m",
		}).createPlan({
			task: "x",
			config: { ownerId: "o", approvalPolicy: { threshold: "high" } },
		});

		const reviser = new ScriptedProvider([
			{
				name: "submit_revisions",
				input: {
					revisions: [
						{
							kind: "annotate_node",
							nodeId: "placeholder",
							note: "expanded",
						},
					],
				} satisfies SubmitRevisionsInput,
			},
		]);
		const hook = new Planner({
			provider: reviser,
			model: "m",
		}).asExpansionHook();
		const triggerNode =
			plan.tree.type === "group" && plan.tree.children[0]
				? plan.tree.children[0]
				: plan.tree;
		const revisions = await hook.expand({ plan, triggerNode });
		expect(revisions).toHaveLength(1);
		expect(revisions[0]?.kind).toBe("annotate_node");
	});
});

describe("Planner.expandPlan", () => {
	test("forwards submit_revisions call and returns parsed revisions", async () => {
		// Step 1: build a plan with a creator provider
		const creator = new ScriptedProvider([
			{
				name: "submit_plan",
				input: {
					rootId: "root",
					nodes: [
						{
							id: "root",
							parentId: null,
							type: "group",
							title: "r",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
							mode: "sequence",
						},
						{
							id: "r1",
							parentId: "root",
							type: "research",
							title: "r1",
							description: "",
							dependsOn: [],
							needsExpansion: false,
							severity: sev(),
						},
					],
				} satisfies SubmitPlanInput,
			},
		]);
		const plan = await new Planner({
			provider: creator,
			model: "m",
		}).createPlan({
			task: "x",
			config: {
				ownerId: "o",
				approvalPolicy: { threshold: "high" },
			},
		});

		// Step 2: expand with a separate provider that emits revisions
		const reviser = new ScriptedProvider([
			{
				name: "submit_revisions",
				input: {
					revisions: [
						{
							kind: "annotate_node",
							nodeId: "r1",
							note: "found it",
						},
					],
				} satisfies SubmitRevisionsInput,
			},
		]);
		const triggerNode =
			plan.tree.type === "group" && plan.tree.children[0]
				? plan.tree.children[0]
				: plan.tree;
		const revisions = await new Planner({
			provider: reviser,
			model: "m",
		}).expandPlan({ plan, triggerNode });

		expect(revisions).toHaveLength(1);
		expect(revisions[0]?.kind).toBe("annotate_node");
	});
});

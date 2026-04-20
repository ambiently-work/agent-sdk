import { describe, expect, test } from "bun:test";
import { applyApproval, runStep, type StepResult } from "./executor";
import { Plan, type PlanNode } from "./plan";
import { type NodeRunner, type NodeRunResult, StubNodeRunner } from "./runner";

const NOW = "2026-04-20T10:00:00.000Z";
const now = () => NOW;

function baseSeverity(grade: "low" | "medium" | "high" | "critical" = "low") {
	const rev =
		grade === "critical"
			? "irreversible"
			: grade === "high"
				? "expensive"
				: grade === "medium"
					? "cheap"
					: "trivial";
	const impact =
		grade === "critical"
			? "system"
			: grade === "high"
				? "branch"
				: grade === "medium"
					? "local"
					: "local";
	return { impact, reversibility: rev, grade, rationale: "test" } as const;
}

function makeSimplePlan(overrides?: Partial<Plan>): Plan {
	const tree: PlanNode = {
		type: "group",
		id: "root",
		title: "root",
		description: "",
		status: "pending",
		dependsOn: [],
		needsExpansion: false,
		severity: baseSeverity("low"),
		attempts: 0,
		annotations: [],
		mode: "sequence",
		children: [
			{
				type: "research",
				id: "r1",
				title: "research",
				description: "find stuff",
				status: "pending",
				dependsOn: [],
				needsExpansion: false,
				severity: baseSeverity("low"),
				attempts: 0,
				annotations: [],
				questions: [],
			},
			{
				type: "do",
				id: "d1",
				title: "do the thing",
				description: "do it",
				status: "pending",
				dependsOn: ["r1"],
				needsExpansion: false,
				severity: baseSeverity("low"),
				attempts: 0,
				annotations: [],
				action: "run",
			},
		],
	};
	return Plan.parse({
		id: "p1",
		version: 0,
		status: "running",
		task: "test",
		config: {
			ownerId: "org",
			approvalPolicy: { threshold: "high" },
		},
		tree,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	});
}

describe("runStep — terminal states", () => {
	test("draft plan returns idle", async () => {
		const plan = makeSimplePlan({ status: "draft" });
		const result = await runStep(plan, { runner: new StubNodeRunner(), now });
		expect(result.outcome).toEqual({ status: "idle", reason: "draft" });
	});

	test("completed plan returns completed outcome, does nothing", async () => {
		const plan = makeSimplePlan({ status: "completed" });
		const result = await runStep(plan, { runner: new StubNodeRunner(), now });
		expect(result.outcome.status).toBe("completed");
		expect(result.events).toHaveLength(0);
	});
});

describe("runStep — plan-level approval gate", () => {
	test("awaiting_plan_approval creates approval + pauses", async () => {
		const plan = makeSimplePlan({ status: "awaiting_plan_approval" });
		const result = await runStep(plan, { runner: new StubNodeRunner(), now });
		expect(result.outcome.status).toBe("paused");
		expect(result.plan.approvals).toHaveLength(1);
		expect(result.plan.approvals[0]?.kind).toBe("plan_approval");
	});

	test("applyApproval(approve) flips to running", () => {
		const plan = makeSimplePlan({ status: "awaiting_plan_approval" });
		// Manually add the approval to simulate post-runStep state
		const approved = applyApproval(
			{
				...plan,
				approvals: [
					{
						id: "a1",
						kind: "plan_approval",
						nodeId: null,
						severity: null,
						prompt: "go?",
						options: [],
						status: "pending",
						requestedAt: NOW,
					},
				],
			},
			"a1",
			{ approve: true, actor: "alice", decidedAt: NOW },
			{ now },
		);
		expect(approved.ok).toBe(true);
		if (!approved.ok) return;
		expect(approved.plan.status).toBe("running");
	});

	test("applyApproval(reject) flips to aborted", () => {
		const plan = makeSimplePlan({ status: "awaiting_plan_approval" });
		const result = applyApproval(
			{
				...plan,
				approvals: [
					{
						id: "a1",
						kind: "plan_approval",
						nodeId: null,
						severity: null,
						prompt: "go?",
						options: [],
						status: "pending",
						requestedAt: NOW,
					},
				],
			},
			"a1",
			{ approve: false, actor: "alice", decidedAt: NOW },
			{ now },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.status).toBe("aborted");
	});
});

describe("runStep — happy path", () => {
	test("runs all nodes to completion with stub runner", async () => {
		const plan = makeSimplePlan();
		const checkpoints: Array<{ version: number; eventCount: number }> = [];
		const result = await runStep(plan, {
			runner: new StubNodeRunner(),
			now,
			onCheckpoint: (p, es) => {
				checkpoints.push({ version: p.version, eventCount: es.length });
			},
		});
		expect(result.outcome.status).toBe("completed");
		expect(result.plan.status).toBe("completed");
		expect(result.plan.tree.type).toBe("group");
		if (result.plan.tree.type !== "group") return;
		for (const child of result.plan.tree.children) {
			expect(child.status).toBe("completed");
		}
		expect(checkpoints.length).toBeGreaterThan(0);
		// Version bumps monotonically
		for (let i = 1; i < checkpoints.length; i++) {
			const prev = checkpoints[i - 1];
			const cur = checkpoints[i];
			if (!prev || !cur) continue;
			expect(cur.version).toBeGreaterThan(prev.version);
		}
	});
});

describe("runStep — severity gating", () => {
	test("high-severity do node pauses and creates approval", async () => {
		const plan = makeSimplePlan();
		// Upgrade d1 to critical
		if (plan.tree.type !== "group") throw new Error("bad test");
		const d1 = plan.tree.children[1];
		if (!d1) throw new Error("no d1");
		(d1 as { severity: ReturnType<typeof baseSeverity> }).severity =
			baseSeverity("critical");

		const result = await runStep(plan, { runner: new StubNodeRunner(), now });
		// First research completes, then on d1 we pause
		expect(result.outcome.status).toBe("paused");
		const pending = result.plan.approvals.filter((a) => a.status === "pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.kind).toBe("do_gate");
		expect(pending[0]?.nodeId).toBe("d1");
		expect(pending[0]?.severity).toBe("critical");
	});

	test("applyApproval(approve) on do_gate flips node to eligible + resumes", async () => {
		const plan = makeSimplePlan();
		if (plan.tree.type !== "group") throw new Error("bad test");
		const d1 = plan.tree.children[1];
		if (!d1) throw new Error("no d1");
		(d1 as { severity: ReturnType<typeof baseSeverity> }).severity =
			baseSeverity("critical");

		const paused = await runStep(plan, { runner: new StubNodeRunner(), now });
		const approvalId = paused.plan.approvals.find(
			(a) => a.status === "pending",
		)?.id;
		expect(approvalId).toBeDefined();
		if (!approvalId) return;

		const approved = applyApproval(
			paused.plan,
			approvalId,
			{ approve: true, actor: "alice", decidedAt: NOW },
			{ now },
		);
		expect(approved.ok).toBe(true);
		if (!approved.ok) return;
		expect(approved.plan.status).toBe("running");

		const resumed = await runStep(approved.plan, {
			runner: new StubNodeRunner(),
			now,
		});
		expect(resumed.outcome.status).toBe("completed");
	});
});

describe("runStep — decide node + gated subtrees", () => {
	test("starves non-chosen option subtree and activates chosen one", async () => {
		const tree: PlanNode = {
			type: "group",
			id: "root",
			title: "root",
			description: "",
			status: "pending",
			dependsOn: [],
			needsExpansion: false,
			severity: baseSeverity("low"),
			attempts: 0,
			annotations: [],
			mode: "sequence",
			children: [
				{
					type: "decide",
					id: "dec",
					title: "pick",
					description: "",
					status: "pending",
					dependsOn: [],
					needsExpansion: false,
					severity: baseSeverity("low"),
					attempts: 0,
					annotations: [],
					question: "A or B?",
					options: [
						{ id: "A", label: "A" },
						{ id: "B", label: "B" },
					],
					criteria: [],
					forceHuman: false,
				},
				{
					type: "group",
					id: "gA",
					title: "A branch",
					description: "",
					status: "pending",
					dependsOn: [],
					gatedOn: { decideNodeId: "dec", optionId: "A" },
					needsExpansion: false,
					severity: baseSeverity("low"),
					attempts: 0,
					annotations: [],
					mode: "sequence",
					children: [
						{
							type: "do",
							id: "aDo",
							title: "do A",
							description: "",
							status: "pending",
							dependsOn: [],
							gatedOn: { decideNodeId: "dec", optionId: "A" },
							needsExpansion: false,
							severity: baseSeverity("low"),
							attempts: 0,
							annotations: [],
							action: "A",
						},
					],
				},
				{
					type: "group",
					id: "gB",
					title: "B branch",
					description: "",
					status: "pending",
					dependsOn: [],
					gatedOn: { decideNodeId: "dec", optionId: "B" },
					needsExpansion: false,
					severity: baseSeverity("low"),
					attempts: 0,
					annotations: [],
					mode: "sequence",
					children: [
						{
							type: "do",
							id: "bDo",
							title: "do B",
							description: "",
							status: "pending",
							dependsOn: [],
							gatedOn: { decideNodeId: "dec", optionId: "B" },
							needsExpansion: false,
							severity: baseSeverity("low"),
							attempts: 0,
							annotations: [],
							action: "B",
						},
					],
				},
			],
		};
		const plan = Plan.parse({
			id: "p1",
			version: 0,
			status: "running",
			task: "choose",
			config: {
				ownerId: "org",
				approvalPolicy: { threshold: "high" },
			},
			tree,
			createdAt: NOW,
			updatedAt: NOW,
		});

		// Stub chooses the first option (A)
		const result = await runStep(plan, { runner: new StubNodeRunner(), now });
		expect(result.outcome.status).toBe("completed");
		if (result.plan.tree.type !== "group") throw new Error("bad tree");
		const [, gA, gB] = result.plan.tree.children;
		expect(gA?.status).toBe("pending"); // group wasn't "run" but children completed
		// aDo should be completed
		if (gA?.type !== "group") throw new Error("bad");
		expect(gA.children[0]?.status).toBe("completed");
		// bDo should be skipped
		if (gB?.type !== "group") throw new Error("bad");
		expect(gB.children[0]?.status).toBe("skipped");
	});
});

describe("runStep — budget yield", () => {
	test("yields with wall_time reason when maxNodes=1 reached", async () => {
		const plan = makeSimplePlan();
		const result = await runStep(plan, {
			runner: new StubNodeRunner(),
			now,
			budget: { maxNodes: 1, safetyMargin: 0 },
		});
		expect(result.outcome.status).toBe("yielded");
		if (result.outcome.status !== "yielded") return;
		expect(result.outcome.reason).toBe("node_count");
	});
});

describe("runStep — retry policy", () => {
	test("transient failures retry up to maxRetries then fail", async () => {
		let calls = 0;
		const flaky: NodeRunner = {
			async run(ctx): Promise<NodeRunResult> {
				calls++;
				if (ctx.node.type === "research") {
					return {
						ok: false,
						error: { message: "boom", code: "transient" },
						usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
						transient: true,
					};
				}
				return {
					ok: true,
					output: null,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
				};
			},
		};
		const plan = makeSimplePlan();
		// Research defaults to maxRetries: 2, so we expect 3 total attempts (1 + 2 retries) before fail
		const result = await runStep(plan, { runner: flaky, now });
		expect(result.outcome.status).toBe("failed");
		expect(calls).toBe(3);
	});

	test("usage_updated emits post-delta cumulative and plan.usage aggregates across nodes", async () => {
		const perNode: Record<
			string,
			{ inputTokens: number; outputTokens: number; costUsd: number }
		> = {
			r1: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
			d1: { inputTokens: 200, outputTokens: 25, costUsd: 0.0025 },
		};
		const runner: NodeRunner = {
			async run(ctx): Promise<NodeRunResult> {
				return {
					ok: true,
					output: `ok:${ctx.node.id}`,
					usage: perNode[ctx.node.id] ?? {
						inputTokens: 0,
						outputTokens: 0,
						costUsd: 0,
					},
				};
			},
		};
		const plan = makeSimplePlan();
		const result = await runStep(plan, { runner, now });
		expect(result.outcome.status).toBe("completed");
		const updates = result.events.filter(
			(e): e is Extract<typeof e, { type: "usage_updated" }> =>
				e.type === "usage_updated",
		);
		expect(updates).toHaveLength(2);
		// First event: cumulative = r1 delta
		expect(updates[0]?.cumulative.inputTokens).toBe(100);
		expect(updates[0]?.cumulative.outputTokens).toBe(50);
		expect(updates[0]?.cumulative.costUsd).toBeCloseTo(0.001);
		// Second event: cumulative = r1 + d1 delta
		expect(updates[1]?.cumulative.inputTokens).toBe(300);
		expect(updates[1]?.cumulative.outputTokens).toBe(75);
		expect(updates[1]?.cumulative.costUsd).toBeCloseTo(0.0035);
		// And plan.usage matches the final cumulative.
		expect(result.plan.usage.inputTokens).toBe(300);
		expect(result.plan.usage.outputTokens).toBe(75);
		expect(result.plan.usage.costUsd).toBeCloseTo(0.0035);
	});

	test("usage seeded from plan.usage continues to aggregate across runStep calls", async () => {
		const runner: NodeRunner = {
			async run(ctx): Promise<NodeRunResult> {
				return {
					ok: true,
					output: ctx.node.id,
					usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
				};
			},
		};
		// Pre-existing usage on the plan from a previous pass.
		const plan = makeSimplePlan({
			usage: { inputTokens: 999, outputTokens: 123, costUsd: 0.42 },
		});
		const result = await runStep(plan, { runner, now });
		expect(result.outcome.status).toBe("completed");
		// Both nodes contributed +10/+5/+0.01 on top of the seed.
		expect(result.plan.usage.inputTokens).toBe(999 + 20);
		expect(result.plan.usage.outputTokens).toBe(123 + 10);
		expect(result.plan.usage.costUsd).toBeCloseTo(0.42 + 0.02);
	});

	test("rate_limited with retryAfterMs yields so the integrator can back off", async () => {
		let calls = 0;
		const rateLimited: NodeRunner = {
			async run(ctx): Promise<NodeRunResult> {
				calls++;
				if (ctx.node.type === "research") {
					return {
						ok: false,
						error: { message: "slow down", code: "rate_limited" },
						usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
						transient: true,
						retryAfterMs: 2500,
					};
				}
				return {
					ok: true,
					output: null,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
				};
			},
		};
		const plan = makeSimplePlan();
		const result = await runStep(plan, { runner: rateLimited, now });
		expect(result.outcome.status).toBe("yielded");
		if (result.outcome.status !== "yielded") return;
		expect(result.outcome.reason).toBe("rate_limited");
		expect(result.outcome.retryAfterMs).toBe(2500);
		// Only one attempt before yielding — the executor doesn't burn retries.
		expect(calls).toBe(1);
		// The node is back to pending so the next runStep picks it up again.
		const research = (
			result.plan.tree as { children: PlanNode[] }
		).children.find((c) => c.id === "r1");
		expect(research?.status).toBe("pending");
		// `step_yielded` event carries the same hint.
		const yielded = result.events.find((e) => e.type === "step_yielded");
		expect(yielded).toBeDefined();
		if (yielded?.type === "step_yielded") {
			expect(yielded.reason).toBe("rate_limited");
			expect(yielded.retryAfterMs).toBe(2500);
		}
	});
});

describe("checkpoint policy", () => {
	test("onCheckpoint receives only events since last checkpoint", async () => {
		const plan = makeSimplePlan();
		const batches: number[] = [];
		await runStep(plan, {
			runner: new StubNodeRunner(),
			now,
			onCheckpoint: (_p, events) => {
				batches.push(events.length);
			},
		});
		// Every batch is non-empty
		for (const n of batches) expect(n).toBeGreaterThan(0);
	});

	test("disabling all checkpoint triggers means zero callbacks", async () => {
		const plan = makeSimplePlan();
		let count = 0;
		await runStep(plan, {
			runner: new StubNodeRunner(),
			now,
			onCheckpoint: () => {
				count++;
			},
			checkpointPolicy: {
				onNodeStart: false,
				onNodeComplete: false,
				onToolResult: false,
				onRevision: false,
				onApprovalRequest: false,
			},
		});
		expect(count).toBe(0);
	});
});

function assertCompleted(r: StepResult): void {
	if (r.outcome.status !== "completed") {
		throw new Error(`expected completed, got ${r.outcome.status}`);
	}
}
void assertCompleted;

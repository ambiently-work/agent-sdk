import { describe, expect, test } from "bun:test";
import {
	deserializePlan,
	findNode,
	Plan,
	type PlanNode,
	type PlanRevision,
	serializePlan,
	validateDag,
} from "./plan";
import { applyRevisions } from "./revisions";
import { DEFAULT_SEVERITY_MATRIX, gradeSeverity } from "./severity";

const NOW = "2026-04-20T10:00:00.000Z";

const sampleTree: PlanNode = {
	type: "group",
	id: "root",
	title: "root",
	description: "root group",
	status: "pending",
	dependsOn: [],
	needsExpansion: false,
	severity: {
		impact: "local",
		reversibility: "trivial",
		grade: "low",
		rationale: "structural",
	},
	attempts: 0,
	annotations: [],
	mode: "sequence",
	children: [
		{
			type: "research",
			id: "r1",
			title: "find docs",
			description: "look up auth patterns",
			status: "pending",
			dependsOn: [],
			needsExpansion: false,
			severity: {
				impact: "local",
				reversibility: "trivial",
				grade: "low",
				rationale: "read-only",
			},
			attempts: 0,
			annotations: [],
			questions: ["what are the options?"],
		},
		{
			type: "do",
			id: "d1",
			title: "apply migration",
			description: "run the migration",
			status: "pending",
			dependsOn: ["r1"],
			needsExpansion: false,
			severity: {
				impact: "system",
				reversibility: "irreversible",
				grade: "critical",
				rationale: "production DB write",
			},
			attempts: 0,
			annotations: [],
			action: "bun drizzle migrate",
		},
	],
};

function makePlan(): Plan {
	return Plan.parse({
		id: "plan-1",
		version: 0,
		status: "draft",
		task: "migrate auth",
		config: {
			ownerId: "org-1",
			externalId: "LIN-123",
			approvalPolicy: { threshold: "high" },
		},
		tree: sampleTree,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

describe("plan schemas", () => {
	test("round-trip through JSON preserves the plan", () => {
		const plan = makePlan();
		const encoded = serializePlan(plan);
		const decoded = deserializePlan(encoded);
		expect(decoded).toEqual(plan);
	});

	test("round-trip is jsonb-compatible (JSON.parse of serialize gives plain object)", () => {
		const plan = makePlan();
		const jsonValue = JSON.parse(serializePlan(plan)) as unknown;
		// Validates as a plain object — no Date/Map/Set instances survive.
		const reparsed = Plan.parse(jsonValue);
		expect(reparsed.id).toBe("plan-1");
		expect(reparsed.tree.type).toBe("group");
	});

	test("validateDag rejects cycles", () => {
		const plan = makePlan();
		const r1 = findNode(plan.tree, "r1");
		if (!r1) throw new Error("r1 missing");
		r1.dependsOn = ["d1"];
		const result = validateDag(plan.tree);
		expect(result.ok).toBe(false);
	});

	test("validateDag accepts a DAG", () => {
		const plan = makePlan();
		expect(validateDag(plan.tree)).toEqual({ ok: true });
	});

	test("validateDag rejects descendants-as-deps", () => {
		const plan = makePlan();
		plan.tree.dependsOn = ["r1"]; // root can't depend on its own descendant
		const result = validateDag(plan.tree);
		expect(result.ok).toBe(false);
	});
});

describe("severity matrix", () => {
	test("default matrix maps irreversible system work to critical", () => {
		expect(gradeSeverity("system", "irreversible")).toBe("critical");
		expect(gradeSeverity("local", "trivial")).toBe("low");
		expect(gradeSeverity("branch", "expensive", DEFAULT_SEVERITY_MATRIX)).toBe(
			"high",
		);
	});
});

describe("applyRevisions", () => {
	test("adds a child to a group node and appends to revisions log", () => {
		const plan = makePlan();
		const rev: PlanRevision = {
			kind: "add_node",
			parentId: "root",
			cause: { type: "expansion", sourceNodeId: "r1" },
			node: {
				type: "verify",
				id: "v1",
				title: "check migration",
				description: "read schema back",
				status: "pending",
				dependsOn: ["d1"],
				needsExpansion: false,
				severity: {
					impact: "local",
					reversibility: "trivial",
					grade: "low",
					rationale: "read-only check",
				},
				attempts: 0,
				annotations: [],
				check: "schema matches expected",
				targetNodeId: "d1",
			},
		};
		const result = applyRevisions(plan, [rev], { now: NOW });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.revisions).toHaveLength(1);
		expect(result.plan.revisions[0]?.seq).toBe(0);
		expect(findNode(result.plan.tree, "v1")).toBeDefined();
		expect(result.events).toHaveLength(1);
	});

	test("rejects duplicate node ids", () => {
		const plan = makePlan();
		const rev: PlanRevision = {
			kind: "add_node",
			parentId: "root",
			cause: { type: "initial" },
			node: {
				type: "research",
				id: "r1", // duplicate!
				title: "dupe",
				description: "",
				status: "pending",
				dependsOn: [],
				needsExpansion: false,
				severity: {
					impact: "local",
					reversibility: "trivial",
					grade: "low",
					rationale: "",
				},
				attempts: 0,
				annotations: [],
				questions: [],
			},
		};
		const result = applyRevisions(plan, [rev]);
		expect(result.ok).toBe(false);
	});

	test("rejects revisions that would create a DAG cycle", () => {
		const plan = makePlan();
		const rev: PlanRevision = {
			kind: "update_node",
			nodeId: "r1",
			patch: { dependsOn: ["d1"] }, // d1 already depends on r1
			cause: { type: "human", actor: "alice" },
		};
		const result = applyRevisions(plan, [rev]);
		expect(result.ok).toBe(false);
	});

	test("skip_node cascades to pending descendants", () => {
		const plan = makePlan();
		const rev: PlanRevision = {
			kind: "skip_node",
			nodeId: "root",
			reason: "user cancelled",
			cause: { type: "human", actor: "alice" },
		};
		const result = applyRevisions(plan, [rev]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const r1 = findNode(result.plan.tree, "r1");
		const d1 = findNode(result.plan.tree, "d1");
		expect(r1?.status).toBe("skipped");
		expect(d1?.status).toBe("skipped");
	});
});

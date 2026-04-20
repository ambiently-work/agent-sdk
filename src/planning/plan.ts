import { z } from "zod";
import { Approval } from "./approvals";
import { PlanBudgetCaps, PriceTable, Usage } from "./budget";
import { ToolCacheSchema } from "./memoization";
import {
	ApprovalPolicy,
	SeverityGrade,
	type SeverityMatrix,
	SeverityMatrixSchema,
} from "./severity";

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export const NodeStatus = z.enum([
	"pending",
	"eligible",
	"running",
	"completed",
	"failed",
	"skipped",
	"awaiting_approval",
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const RetryPolicy = z.object({
	maxRetries: z.number().int().nonnegative().default(0),
	backoffMs: z.number().int().nonnegative().default(1000),
	retryOn: z
		.union([z.enum(["any", "transient"]), z.array(z.string())])
		.default("transient"),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const GatedOn = z.object({
	decideNodeId: z.string(),
	optionId: z.string(),
});
export type GatedOn = z.infer<typeof GatedOn>;

export const NodeError = z.object({
	message: z.string(),
	code: z.string().optional(),
	at: z.iso.datetime(),
});
export type NodeError = z.infer<typeof NodeError>;

const BaseNodeShape = {
	id: z.string(),
	title: z.string(),
	description: z.string(),
	status: NodeStatus.default("pending"),
	output: z.unknown().optional(),
	error: NodeError.optional(),
	/** IDs of other nodes anywhere in the plan that must complete before this one. */
	dependsOn: z.array(z.string()).default([]),
	/** Activated only when the referenced decide node chose this option. */
	gatedOn: GatedOn.optional(),
	/** Marks the node as a placeholder — planner fills in children after upstream runs. */
	needsExpansion: z.boolean().default(false),
	/** Grading of impact/reversibility for this node. */
	severity: SeverityGrade,
	/** Hint the planner provides; executor uses it to predict budget. */
	estimatedTokens: z.number().int().positive().optional(),
	/** Tool allowlist, passed to the executor's tool policy. */
	allowedTools: z.array(z.string()).optional(),
	/** Per-node retry policy (defaults depend on type; see DEFAULT_RETRY_POLICY). */
	retryPolicy: RetryPolicy.optional(),
	/** How many execution attempts have been made so far. */
	attempts: z.number().int().nonnegative().default(0),
	/** Free-form annotations written by planner or human revisions. */
	annotations: z.array(z.string()).default([]),
	startedAt: z.iso.datetime().optional(),
	completedAt: z.iso.datetime().optional(),
};

// Node variants — discriminated union on `type`.

export const ResearchNode = z.object({
	...BaseNodeShape,
	type: z.literal("research"),
	questions: z.array(z.string()).default([]),
});

export const DiscoverNode = z.object({
	...BaseNodeShape,
	type: z.literal("discover"),
	scope: z.string(),
});

export const DecideNode = z.object({
	...BaseNodeShape,
	type: z.literal("decide"),
	question: z.string(),
	options: z
		.array(
			z.object({
				id: z.string(),
				label: z.string(),
				rationale: z.string().optional(),
			}),
		)
		.min(1),
	criteria: z.array(z.string()).default([]),
	/** Whether this decide MUST go to a human regardless of severity threshold. */
	forceHuman: z.boolean().default(false),
});

export const DoNode = z.object({
	...BaseNodeShape,
	type: z.literal("do"),
	action: z.string(),
	/**
	 * Idempotency key template. If set, side-effecting tools can safely retry. Referenced
	 * by tool authors as part of the tool call's inputs; the executor threads it through.
	 */
	idempotencyKey: z.string().optional(),
});

export const VerifyNode = z.object({
	...BaseNodeShape,
	type: z.literal("verify"),
	check: z.string(),
	targetNodeId: z.string().optional(),
});

// Group nodes have children. Because of the zod-union/recursion dance, we type
// `children` via a lazy recursion below.
export const GroupNode: z.ZodType<GroupNodeT> = z.lazy(() =>
	z.object({
		...BaseNodeShape,
		type: z.literal("group"),
		mode: z.enum(["sequence", "parallel"]).default("sequence"),
		children: z.array(PlanNode).default([]),
	}),
);

export type GroupNodeT = z.infer<typeof ResearchNode> extends infer _
	? {
			id: string;
			title: string;
			description: string;
			status: NodeStatus;
			output?: unknown;
			error?: NodeError;
			dependsOn: string[];
			gatedOn?: GatedOn;
			needsExpansion: boolean;
			severity: SeverityGrade;
			estimatedTokens?: number;
			allowedTools?: string[];
			retryPolicy?: RetryPolicy;
			attempts: number;
			annotations: string[];
			startedAt?: string;
			completedAt?: string;
			type: "group";
			mode: "sequence" | "parallel";
			children: PlanNode[];
		}
	: never;

export const PlanNode: z.ZodType<PlanNode> = z.lazy(() =>
	z.discriminatedUnion("type", [
		ResearchNode,
		DiscoverNode,
		DecideNode,
		DoNode,
		VerifyNode,
		GroupNode as unknown as typeof ResearchNode,
	]),
) as unknown as z.ZodType<PlanNode>;

export type ResearchNodeT = z.infer<typeof ResearchNode>;
export type DiscoverNodeT = z.infer<typeof DiscoverNode>;
export type DecideNodeT = z.infer<typeof DecideNode>;
export type DoNodeT = z.infer<typeof DoNode>;
export type VerifyNodeT = z.infer<typeof VerifyNode>;

export type PlanNode =
	| ResearchNodeT
	| DiscoverNodeT
	| DecideNodeT
	| DoNodeT
	| VerifyNodeT
	| GroupNodeT;

// ---------------------------------------------------------------------------
// Plan config + status
// ---------------------------------------------------------------------------

export const PlanStatus = z.enum([
	"draft",
	"awaiting_plan_approval",
	"running",
	"paused",
	"completed",
	"failed",
	"aborted",
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PlanConfig = z.object({
	ownerId: z.string(),
	externalId: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	severityMatrix: SeverityMatrixSchema.optional(),
	approvalPolicy: ApprovalPolicy,
	budget: PlanBudgetCaps.optional(),
	priceTable: PriceTable.optional(),
});
export type PlanConfig = z.infer<typeof PlanConfig>;

// ---------------------------------------------------------------------------
// Revisions (defined as part of the plan to avoid a circular import — the
// apply/replay functions live in revisions.ts)
// ---------------------------------------------------------------------------

export const RevisionCause = z.discriminatedUnion("type", [
	z.object({ type: z.literal("initial") }),
	z.object({ type: z.literal("expansion"), sourceNodeId: z.string() }),
	z.object({ type: z.literal("decision"), sourceNodeId: z.string() }),
	z.object({ type: z.literal("verify_failed"), sourceNodeId: z.string() }),
	z.object({ type: z.literal("discovery"), sourceNodeId: z.string() }),
	z.object({ type: z.literal("human"), actor: z.string() }),
	z.object({ type: z.literal("retry"), sourceNodeId: z.string() }),
]);
export type RevisionCause = z.infer<typeof RevisionCause>;

export const PlanRevision = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("add_node"),
		parentId: z.string(),
		node: PlanNode,
		position: z.number().int().nonnegative().optional(),
		cause: RevisionCause,
	}),
	z.object({
		kind: z.literal("skip_node"),
		nodeId: z.string(),
		reason: z.string(),
		cause: RevisionCause,
	}),
	z.object({
		kind: z.literal("update_node"),
		nodeId: z.string(),
		patch: z.record(z.string(), z.unknown()),
		cause: RevisionCause,
	}),
	z.object({
		kind: z.literal("annotate_node"),
		nodeId: z.string(),
		note: z.string(),
	}),
	z.object({
		kind: z.literal("replace_node"),
		nodeId: z.string(),
		node: PlanNode,
		cause: RevisionCause,
	}),
]);
export type PlanRevision = z.infer<typeof PlanRevision>;

export const SequencedRevision = z.object({
	seq: z.number().int().nonnegative(),
	appliedAt: z.iso.datetime(),
	revision: PlanRevision,
});
export type SequencedRevision = z.infer<typeof SequencedRevision>;

// ---------------------------------------------------------------------------
// Plan envelope
// ---------------------------------------------------------------------------

export const Plan = z.object({
	id: z.string(),
	version: z.number().int().nonnegative().default(0),
	status: PlanStatus.default("draft"),
	task: z.string(),
	config: PlanConfig,
	tree: PlanNode,
	revisions: z.array(SequencedRevision).default([]),
	approvals: z.array(Approval).default([]),
	usage: Usage.default({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
	cache: ToolCacheSchema.default({}),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	/** Scratch space for planner/executor that integrators may also annotate. */
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Plan = z.infer<typeof Plan>;

// ---------------------------------------------------------------------------
// Serialization (jsonb-friendly)
// ---------------------------------------------------------------------------

/**
 * Serialize a plan to a JSON string. Round-trips through `deserializePlan`.
 * Safe to store directly in a Postgres jsonb column via `JSON.parse(serializePlan(plan))`.
 */
export function serializePlan(plan: Plan): string {
	return JSON.stringify(plan);
}

/**
 * Parse and validate a serialized plan. Throws `ZodError` on schema drift.
 */
export function deserializePlan(input: string | unknown): Plan {
	const raw = typeof input === "string" ? JSON.parse(input) : input;
	return Plan.parse(raw);
}

/** Convenience for drivers that want the plain object before hitting jsonb. */
export function toJsonValue(plan: Plan): unknown {
	return JSON.parse(JSON.stringify(plan));
}

// ---------------------------------------------------------------------------
// Tree traversal helpers
// ---------------------------------------------------------------------------

export function* walkNodes(node: PlanNode): Generator<PlanNode> {
	yield node;
	if (node.type === "group") {
		for (const child of node.children) yield* walkNodes(child);
	}
}

export function findNode(root: PlanNode, id: string): PlanNode | undefined {
	for (const n of walkNodes(root)) if (n.id === id) return n;
	return undefined;
}

export function findParent(
	root: PlanNode,
	childId: string,
): PlanNode | undefined {
	if (root.type !== "group") return undefined;
	for (const child of root.children) {
		if (child.id === childId) return root;
		const deeper = findParent(child, childId);
		if (deeper) return deeper;
	}
	return undefined;
}

/**
 * Validate the plan tree as a DAG. Checks:
 * - all IDs unique
 * - all `dependsOn` + `gatedOn.decideNodeId` references point to existing nodes
 * - no cycles in the `dependsOn` graph
 * - no node depends on one of its own descendants (would be a trivial cycle)
 */
export function validateDag(root: PlanNode):
	| {
			ok: true;
	  }
	| { ok: false; error: string } {
	const ids = new Set<string>();
	const byId = new Map<string, PlanNode>();
	for (const n of walkNodes(root)) {
		if (ids.has(n.id))
			return { ok: false, error: `duplicate node id: ${n.id}` };
		ids.add(n.id);
		byId.set(n.id, n);
	}
	for (const n of walkNodes(root)) {
		for (const d of n.dependsOn) {
			if (!ids.has(d)) {
				return { ok: false, error: `node ${n.id} depends on missing ${d}` };
			}
		}
		if (n.gatedOn && !ids.has(n.gatedOn.decideNodeId)) {
			return {
				ok: false,
				error: `node ${n.id} gated on missing decide ${n.gatedOn.decideNodeId}`,
			};
		}
		if (n.type === "group") {
			for (const child of n.children) {
				for (const descendant of walkNodes(child)) {
					if (n.dependsOn.includes(descendant.id)) {
						return {
							ok: false,
							error: `node ${n.id} depends on its descendant ${descendant.id}`,
						};
					}
				}
			}
		}
	}
	// Cycle detection on dependsOn graph (excluding structural tree edges).
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	for (const id of ids) color.set(id, 0);
	function visit(id: string): string | null {
		const c = color.get(id);
		if (c === 1) return `cycle through ${id}`;
		if (c === 2) return null;
		color.set(id, 1);
		stack.push(id);
		const node = byId.get(id);
		if (node) {
			for (const d of node.dependsOn) {
				const found = visit(d);
				if (found) return found;
			}
		}
		color.set(id, 2);
		stack.pop();
		return null;
	}
	for (const id of ids) {
		const found = visit(id);
		if (found) return { ok: false, error: found };
	}
	return { ok: true };
}

export const DEFAULT_RETRY_BY_TYPE: Record<PlanNode["type"], RetryPolicy> = {
	research: { maxRetries: 2, backoffMs: 1000, retryOn: "transient" },
	discover: { maxRetries: 2, backoffMs: 1000, retryOn: "transient" },
	decide: { maxRetries: 1, backoffMs: 500, retryOn: "transient" },
	do: { maxRetries: 0, backoffMs: 0, retryOn: "transient" },
	verify: { maxRetries: 2, backoffMs: 1000, retryOn: "transient" },
	group: { maxRetries: 0, backoffMs: 0, retryOn: "transient" },
};

export function effectiveRetryPolicy(node: PlanNode): RetryPolicy {
	return node.retryPolicy ?? DEFAULT_RETRY_BY_TYPE[node.type];
}

export function effectiveSeverityMatrix(
	plan: Plan,
): SeverityMatrix | undefined {
	return plan.config.severityMatrix;
}

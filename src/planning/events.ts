import { z } from "zod";
import { Approval, ApprovalDecision } from "./approvals";
import { Usage } from "./budget";
import { NodeError, NodeStatus, PlanRevision, PlanStatus } from "./plan";

/**
 * Events emitted during `runStep`. Integrators consume them via the
 * `onCheckpoint` callback (batched since last checkpoint) and the final
 * `StepResult.events` (complete list).
 */
export const PlanEvent = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("plan_status_changed"),
		at: z.iso.datetime(),
		from: PlanStatus,
		to: PlanStatus,
	}),
	z.object({
		type: z.literal("plan_revised"),
		at: z.iso.datetime(),
		revisions: z.array(PlanRevision),
	}),
	z.object({
		type: z.literal("node_status_changed"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		from: NodeStatus,
		to: NodeStatus,
	}),
	z.object({
		type: z.literal("node_started"),
		at: z.iso.datetime(),
		nodeId: z.string(),
	}),
	z.object({
		type: z.literal("node_text_delta"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		text: z.string(),
	}),
	z.object({
		type: z.literal("node_tool_call"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		callId: z.string(),
		tool: z.string(),
		inputs: z.record(z.string(), z.unknown()),
		fromCache: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("node_tool_result"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		callId: z.string(),
		tool: z.string(),
		ok: z.boolean(),
		result: z.unknown(),
		fromCache: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("node_completed"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		output: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("node_failed"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		error: NodeError,
		willRetry: z.boolean(),
	}),
	z.object({
		type: z.literal("node_skipped"),
		at: z.iso.datetime(),
		nodeId: z.string(),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("approval_requested"),
		at: z.iso.datetime(),
		approval: Approval,
	}),
	z.object({
		type: z.literal("approval_resolved"),
		at: z.iso.datetime(),
		approvalId: z.string(),
		decision: ApprovalDecision,
	}),
	z.object({
		type: z.literal("usage_updated"),
		at: z.iso.datetime(),
		nodeId: z.string().optional(),
		delta: Usage,
		cumulative: Usage,
	}),
	z.object({
		type: z.literal("step_yielded"),
		at: z.iso.datetime(),
		reason: z.enum([
			"wall_time",
			"node_count",
			"token_budget",
			"cost_budget",
			"rate_limited",
		]),
		/**
		 * Hint (ms) for when the caller should next invoke `runStep`. Only set
		 * when `reason === "rate_limited"`, sourced from the provider's
		 * `Retry-After` header (or equivalent).
		 */
		retryAfterMs: z.number().int().nonnegative().optional(),
	}),
	z.object({
		type: z.literal("step_paused"),
		at: z.iso.datetime(),
		approvalId: z.string(),
	}),
]);
export type PlanEvent = z.infer<typeof PlanEvent>;

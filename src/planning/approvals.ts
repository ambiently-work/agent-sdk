import { z } from "zod";
import { Severity } from "./severity";

export const ApprovalKind = z.enum([
	/** First gate on a plan: tree was generated, awaiting human OK before execution. */
	"plan_approval",
	/** Gate on a `decide` node whose severity >= policy threshold. */
	"decide_gate",
	/** Gate on a `do` node whose severity >= policy threshold. */
	"do_gate",
	/** Self-escalation from an executor agent. */
	"escalation",
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalStatus = z.enum([
	"pending",
	"approved",
	"rejected",
	"cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const DecisionOption = z.object({
	id: z.string(),
	label: z.string(),
	rationale: z.string().optional(),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

export const ApprovalDecision = z.object({
	approve: z.boolean(),
	/** Chosen option for decide_gate approvals (references `options[].id`). */
	chosenOptionId: z.string().optional(),
	/** Free-form decision body — used when options don't cover the case. */
	freeform: z.record(z.string(), z.unknown()).optional(),
	rationale: z.string().optional(),
	actor: z.string(),
	decidedAt: z.iso.datetime().default(() => new Date().toISOString()),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Approval = z.object({
	id: z.string(),
	kind: ApprovalKind,
	/** Null for plan-level approval; otherwise the node that needs a decision. */
	nodeId: z.string().nullable(),
	/** Severity of the thing being approved (null for plan-level). */
	severity: Severity.nullable(),
	prompt: z.string(),
	options: z.array(DecisionOption).default([]),
	assignee: z.string().optional(),
	status: ApprovalStatus.default("pending"),
	requestedAt: z.iso.datetime(),
	decision: ApprovalDecision.optional(),
});
export type Approval = z.infer<typeof Approval>;

export function isPending(approval: Approval): boolean {
	return approval.status === "pending";
}

export function isApproved(approval: Approval): boolean {
	return approval.status === "approved";
}

import {
	type Approval,
	type ApprovalDecision,
	type ApprovalKind,
	isPending,
} from "./approvals";
import { BudgetTracker, type ExecutorBudget } from "./budget";
import type { PlanEvent } from "./events";
import {
	effectiveRetryPolicy,
	findNode,
	type NodeStatus,
	type Plan,
	type PlanNode,
	type PlanRevision,
	type RetryPolicy,
	validateDag,
	walkNodes,
} from "./plan";
import { applyRevisions } from "./revisions";
import type { ExpansionHook, NodeRunContext, NodeRunner } from "./runner";
import { severityAtLeast } from "./severity";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type YieldReason =
	| "wall_time"
	| "node_count"
	| "token_budget"
	| "cost_budget"
	| "rate_limited";

export type StepOutcome =
	| { status: "completed" }
	| { status: "failed"; error: { message: string; nodeId?: string } }
	| { status: "aborted" }
	| { status: "paused"; approvalId: string }
	| {
			status: "yielded";
			reason: YieldReason;
			/**
			 * Wall-clock hint (ms) for when the caller should next invoke
			 * `runStep`. Only set when `reason === "rate_limited"`. Sourced from
			 * the provider's `Retry-After` header (or equivalent).
			 */
			retryAfterMs?: number;
	  }
	| { status: "idle"; reason: "no_ready_nodes" | "draft" };

export type StepResult = {
	plan: Plan;
	events: PlanEvent[];
	outcome: StepOutcome;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type CheckpointPolicy = {
	onNodeStart?: boolean;
	onNodeComplete?: boolean;
	onToolResult?: boolean;
	onRevision?: boolean;
	onApprovalRequest?: boolean;
	onAssistantTextDelta?: boolean;
	/** Coalesce checkpoints no more often than this (ms). Default 0. */
	minIntervalMs?: number;
};

const DEFAULT_CHECKPOINT_POLICY: Required<CheckpointPolicy> = {
	onNodeStart: true,
	onNodeComplete: true,
	onToolResult: true,
	onRevision: true,
	onApprovalRequest: true,
	onAssistantTextDelta: false,
	minIntervalMs: 0,
};

export type OnCheckpoint = (
	plan: Plan,
	events: PlanEvent[],
) => Promise<void> | void;

export type RunStepOptions = {
	runner: NodeRunner;
	budget?: ExecutorBudget;
	signal?: AbortSignal;
	onCheckpoint?: OnCheckpoint;
	checkpointPolicy?: CheckpointPolicy;
	expansion?: ExpansionHook;
	/** Override Date.now for deterministic tests. */
	now?: () => string;
};

// ---------------------------------------------------------------------------
// runStep — main entry point
// ---------------------------------------------------------------------------

export async function runStep(
	plan: Plan,
	opts: RunStepOptions,
): Promise<StepResult> {
	const now = opts.now ?? (() => new Date().toISOString());
	const policy: Required<CheckpointPolicy> = {
		...DEFAULT_CHECKPOINT_POLICY,
		...opts.checkpointPolicy,
	};

	const events: PlanEvent[] = [];
	let unflushed: PlanEvent[] = [];
	let lastCheckpointAt = 0;
	let working = plan;

	const bumpVersion = (p: Plan, updated: string): Plan => ({
		...p,
		version: p.version + 1,
		updatedAt: updated,
	});

	const emit = (e: PlanEvent) => {
		events.push(e);
		unflushed.push(e);
	};

	const checkpoint = async (trigger: keyof CheckpointPolicy): Promise<void> => {
		if (!policy[trigger]) return;
		if (
			policy.minIntervalMs > 0 &&
			Date.now() - lastCheckpointAt < policy.minIntervalMs
		) {
			return;
		}
		if (unflushed.length === 0) return;
		const snapshot = bumpVersion(working, now());
		working = snapshot;
		const batch = unflushed;
		unflushed = [];
		lastCheckpointAt = Date.now();
		if (opts.onCheckpoint) await opts.onCheckpoint(snapshot, batch);
	};

	// ------ terminal / pre-execution gates ------

	if (
		working.status === "completed" ||
		working.status === "failed" ||
		working.status === "aborted"
	) {
		return {
			plan: working,
			events: [],
			outcome: terminalOutcome(working.status),
		};
	}

	if (working.status === "draft") {
		return {
			plan: working,
			events: [],
			outcome: { status: "idle", reason: "draft" },
		};
	}

	if (working.status === "awaiting_plan_approval") {
		let pending = working.approvals.find(
			(a) => a.kind === "plan_approval" && isPending(a),
		);
		if (!pending) {
			pending = makePlanApproval(working, now());
			working = { ...working, approvals: [...working.approvals, pending] };
			emit({ type: "approval_requested", at: now(), approval: pending });
			emit({ type: "step_paused", at: now(), approvalId: pending.id });
			await checkpoint("onApprovalRequest");
		}
		return {
			plan: working,
			events,
			outcome: { status: "paused", approvalId: pending.id },
		};
	}

	if (working.status === "paused") {
		const pending = working.approvals.find(isPending);
		if (pending) {
			return {
				plan: working,
				events: [],
				outcome: { status: "paused", approvalId: pending.id },
			};
		}
		// No pending approval — resume
		const prev = working.status;
		working = { ...working, status: "running" };
		emit({ type: "plan_status_changed", at: now(), from: prev, to: "running" });
	}

	// ------ main loop ------

	const tracker = new BudgetTracker(
		opts.budget ?? { safetyMargin: 0.1 },
		// NOTE: BudgetTracker mutates this — we'll write back into the plan after.
		{ ...working.usage },
		working.config.budget,
	);

	while (true) {
		if (opts.signal?.aborted) {
			working = { ...working, status: "aborted" };
			emit({
				type: "plan_status_changed",
				at: now(),
				from: "running",
				to: "aborted",
			});
			await checkpoint("onNodeComplete");
			return { plan: working, events, outcome: { status: "aborted" } };
		}

		// Budget yield check
		if (tracker.shouldYield()) {
			const reason: YieldReason = tracker.bottleneck() ?? "wall_time";
			emit({ type: "step_yielded", at: now(), reason });
			working = persistUsage(working, tracker);
			await checkpoint("onNodeComplete");
			return { plan: working, events, outcome: { status: "yielded", reason } };
		}

		// Find ready nodes
		const ready = findReadyNodes(working.tree);
		if (ready.length === 0) {
			// Nothing runnable — check for completion
			const done = isTreeTerminal(working.tree);
			if (done) {
				const outcome = planTerminalOutcome(working.tree);
				const prev = working.status;
				working = {
					...working,
					status: outcome.status === "completed" ? "completed" : "failed",
				};
				emit({
					type: "plan_status_changed",
					at: now(),
					from: prev,
					to: working.status,
				});
				working = persistUsage(working, tracker);
				await checkpoint("onNodeComplete");
				return { plan: working, events, outcome };
			}
			// Not terminal but nothing runnable → blocked (probably unresolved approval)
			const pending = working.approvals.find(isPending);
			if (pending) {
				working = { ...working, status: "paused" };
				emit({
					type: "plan_status_changed",
					at: now(),
					from: "running",
					to: "paused",
				});
				working = persistUsage(working, tracker);
				await checkpoint("onApprovalRequest");
				return {
					plan: working,
					events,
					outcome: { status: "paused", approvalId: pending.id },
				};
			}
			working = persistUsage(working, tracker);
			return {
				plan: working,
				events,
				outcome: { status: "idle", reason: "no_ready_nodes" },
			};
		}

		// Severity gate — any ready node needing approval pauses before we run
		const gated = ready.find((n) =>
			requiresApproval(n, working.config.approvalPolicy.threshold),
		);
		if (gated) {
			const approval = makeNodeApproval(gated, now());
			working = {
				...working,
				approvals: [...working.approvals, approval],
				tree: mutateNodeStatus(working.tree, gated.id, "awaiting_approval"),
				status: "paused",
			};
			emit({
				type: "node_status_changed",
				at: now(),
				nodeId: gated.id,
				from: gated.status,
				to: "awaiting_approval",
			});
			emit({ type: "approval_requested", at: now(), approval });
			emit({
				type: "plan_status_changed",
				at: now(),
				from: "running",
				to: "paused",
			});
			emit({ type: "step_paused", at: now(), approvalId: approval.id });
			working = persistUsage(working, tracker);
			await checkpoint("onApprovalRequest");
			return {
				plan: working,
				events,
				outcome: { status: "paused", approvalId: approval.id },
			};
		}

		// Run all ready nodes in parallel (DAG naturally serializes chains).
		tracker.addNode();
		// Check overshoot
		if (tracker.wouldExceed({ nodes: 0 })) {
			const reason: YieldReason = tracker.bottleneck() ?? "wall_time";
			emit({ type: "step_yielded", at: now(), reason });
			working = persistUsage(working, tracker);
			await checkpoint("onNodeComplete");
			return { plan: working, events, outcome: { status: "yielded", reason } };
		}

		// Mark all as running, emit started
		for (const node of ready) {
			working = {
				...working,
				tree: mutateNode(working.tree, node.id, (n) => ({
					...n,
					status: "running",
					startedAt: now(),
					attempts: n.attempts + 1,
				})),
			};
			emit({
				type: "node_status_changed",
				at: now(),
				nodeId: node.id,
				from: node.status,
				to: "running",
			});
			emit({ type: "node_started", at: now(), nodeId: node.id });
		}
		await checkpoint("onNodeStart");

		// Gather inputs for each node and run
		const runResults = await Promise.all(
			ready.map(async (node) => {
				const inputs = gatherInputs(working, node);
				const latest = findNode(working.tree, node.id);
				if (!latest) throw new Error(`node ${node.id} disappeared`);
				const nodeEvents: PlanEvent[] = [];
				const ctx: NodeRunContext = {
					plan: working,
					node: latest,
					inputs,
					signal: opts.signal ?? new AbortController().signal,
					cache: working.cache,
					emit: (e) => nodeEvents.push(e),
				};
				let result: import("./runner").NodeRunResult;
				try {
					result = await opts.runner.run(ctx);
				} catch (err) {
					result = {
						ok: false,
						error: {
							message: err instanceof Error ? err.message : String(err),
						},
						usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
						transient: false,
					};
				}
				return { node: latest, result, events: nodeEvents };
			}),
		);

		// Apply results
		for (const { node, result, events: nodeEvents } of runResults) {
			for (const e of nodeEvents) emit(e);
			tracker.addUsage(
				result.usage.inputTokens,
				result.usage.outputTokens,
				result.usage.costUsd,
			);
			if (
				result.usage.inputTokens ||
				result.usage.outputTokens ||
				result.usage.costUsd
			) {
				// Emit the *post-delta* aggregate — previously this emitted
				// `working.usage`, which isn't refreshed until `persistUsage`
				// runs at the end of the iteration, so consumers saw a
				// one-node-stale total.
				emit({
					type: "usage_updated",
					at: now(),
					nodeId: node.id,
					delta: result.usage,
					cumulative: tracker.snapshot(),
				});
			}

			if (result.ok) {
				working = {
					...working,
					tree: mutateNode(working.tree, node.id, (n) => ({
						...n,
						status: "completed",
						output: result.output,
						completedAt: now(),
					})),
				};
				emit({
					type: "node_status_changed",
					at: now(),
					nodeId: node.id,
					from: "running",
					to: "completed",
				});
				emit({
					type: "node_completed",
					at: now(),
					nodeId: node.id,
					output: result.output,
				});

				// Decide nodes: starve alternative branches
				if (node.type === "decide") {
					const chosen = extractChosenOptionId(result.output);
					if (chosen) {
						const rev = buildStarvationRevisions(working, node.id, chosen);
						if (rev.length > 0) {
							const applied = applyRevisions(working, rev, { now: now() });
							if (applied.ok) {
								working = applied.plan;
								for (const e of applied.events) emit(e);
							}
						}
					}
				}

				// Expansion hook
				if (
					opts.expansion &&
					(node.type === "research" ||
						node.type === "discover" ||
						node.type === "decide")
				) {
					try {
						const revs = await opts.expansion.expand({
							plan: working,
							triggerNode: node,
						});
						if (revs.length > 0) {
							const applied = applyRevisions(working, revs, { now: now() });
							if (applied.ok) {
								working = applied.plan;
								for (const e of applied.events) emit(e);
							}
						}
					} catch (err) {
						// Expansion failure doesn't fail the node — just annotate.
						working = {
							...working,
							tree: mutateNode(working.tree, node.id, (n) => ({
								...n,
								annotations: [
									...n.annotations,
									`expansion failed: ${err instanceof Error ? err.message : String(err)}`,
								],
							})),
						};
					}
				}
			} else {
				// Failure — check retry policy
				const policy = effectiveRetryPolicy(node);
				const latest = findNode(working.tree, node.id);
				const attempts = latest?.attempts ?? node.attempts;
				const willRetry =
					(result.transient ?? false) &&
					shouldRetry(policy, result.error.code) &&
					attempts <= policy.maxRetries;
				if (willRetry) {
					working = {
						...working,
						tree: mutateNode(working.tree, node.id, (n) => ({
							...n,
							status: "pending",
							error: {
								message: result.error.message,
								code: result.error.code,
								at: now(),
							},
							annotations: [
								...n.annotations,
								`retry ${attempts}/${policy.maxRetries}: ${result.error.message}`,
							],
						})),
					};
					emit({
						type: "node_failed",
						at: now(),
						nodeId: node.id,
						error: {
							message: result.error.message,
							code: result.error.code,
							at: now(),
						},
						willRetry: true,
					});
					// Rate-limited retries must respect the provider's wait hint.
					// Yield so the integrator can reschedule — we don't sleep here.
					if (
						result.error.code === "rate_limited" &&
						(result.retryAfterMs ?? 0) > 0
					) {
						const retryAfterMs = result.retryAfterMs;
						emit({
							type: "step_yielded",
							at: now(),
							reason: "rate_limited",
							retryAfterMs,
						});
						working = persistUsage(working, tracker);
						await checkpoint("onNodeComplete");
						return {
							plan: working,
							events,
							outcome: {
								status: "yielded",
								reason: "rate_limited",
								retryAfterMs,
							},
						};
					}
				} else {
					working = {
						...working,
						tree: mutateNode(working.tree, node.id, (n) => ({
							...n,
							status: "failed",
							error: {
								message: result.error.message,
								code: result.error.code,
								at: now(),
							},
							completedAt: now(),
						})),
						status: "failed",
					};
					emit({
						type: "node_status_changed",
						at: now(),
						nodeId: node.id,
						from: "running",
						to: "failed",
					});
					emit({
						type: "node_failed",
						at: now(),
						nodeId: node.id,
						error: {
							message: result.error.message,
							code: result.error.code,
							at: now(),
						},
						willRetry: false,
					});
					working = persistUsage(working, tracker);
					await checkpoint("onNodeComplete");
					return {
						plan: working,
						events,
						outcome: {
							status: "failed",
							error: { message: result.error.message, nodeId: node.id },
						},
					};
				}
			}
		}

		working = persistUsage(working, tracker);
		await checkpoint("onNodeComplete");
		// Loop to pick up the next batch.
	}
}

// ---------------------------------------------------------------------------
// Approval application (pure function on a plan)
// ---------------------------------------------------------------------------

export function applyApproval(
	plan: Plan,
	approvalId: string,
	decision: ApprovalDecision,
	opts: { now?: () => string } = {},
):
	| { ok: true; plan: Plan; events: PlanEvent[] }
	| { ok: false; error: string } {
	const now = opts.now ?? (() => new Date().toISOString());
	const idx = plan.approvals.findIndex((a) => a.id === approvalId);
	if (idx < 0) return { ok: false, error: `approval ${approvalId} not found` };
	const approval = plan.approvals[idx];
	if (!approval)
		return { ok: false, error: `approval ${approvalId} not found` };
	if (approval.status !== "pending") {
		return {
			ok: false,
			error: `approval ${approvalId} not pending (status=${approval.status})`,
		};
	}

	const updatedApproval: Approval = {
		...approval,
		status: decision.approve ? "approved" : "rejected",
		decision,
	};
	const approvals = [...plan.approvals];
	approvals[idx] = updatedApproval;

	let tree = plan.tree;
	let status = plan.status;
	const events: PlanEvent[] = [];

	if (approval.kind === "plan_approval") {
		status = decision.approve ? "running" : "aborted";
		events.push({
			type: "plan_status_changed",
			at: now(),
			from: plan.status,
			to: status,
		});
	} else if (approval.nodeId) {
		const nodeId = approval.nodeId;
		if (!decision.approve) {
			tree = mutateNode(tree, nodeId, (n) => ({
				...n,
				status: "skipped",
				annotations: [
					...n.annotations,
					`approval ${approvalId} rejected by ${decision.actor}`,
				],
				completedAt: decision.decidedAt,
			}));
			events.push({
				type: "node_status_changed",
				at: now(),
				nodeId,
				from: "awaiting_approval",
				to: "skipped",
			});
		} else if (approval.kind === "decide_gate") {
			const chosenOptionId = decision.chosenOptionId;
			tree = mutateNode(tree, nodeId, (n) => ({
				...n,
				status: "completed",
				output: {
					chosenOptionId,
					rationale: decision.rationale,
					actor: decision.actor,
					source: "human",
				},
				completedAt: decision.decidedAt,
			}));
			events.push({
				type: "node_status_changed",
				at: now(),
				nodeId,
				from: "awaiting_approval",
				to: "completed",
			});
		} else {
			// do_gate / escalation — unblock execution
			tree = mutateNode(tree, nodeId, (n) => ({
				...n,
				status: "eligible",
			}));
			events.push({
				type: "node_status_changed",
				at: now(),
				nodeId,
				from: "awaiting_approval",
				to: "eligible",
			});
		}
		// If the plan was paused on this approval, resume.
		if (plan.status === "paused" && !approvals.some(isPending)) {
			status = "running";
			events.push({
				type: "plan_status_changed",
				at: now(),
				from: "paused",
				to: "running",
			});
		}
	}

	events.push({
		type: "approval_resolved",
		at: now(),
		approvalId,
		decision,
	});

	const validation = validateDag(tree);
	if (!validation.ok) {
		return {
			ok: false,
			error: `tree invalid after approval: ${validation.error}`,
		};
	}

	return {
		ok: true,
		plan: {
			...plan,
			tree,
			approvals,
			status,
			version: plan.version + 1,
			updatedAt: now(),
		},
		events,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function terminalOutcome(status: Plan["status"]): StepOutcome {
	if (status === "completed") return { status: "completed" };
	if (status === "aborted") return { status: "aborted" };
	return { status: "failed", error: { message: "plan in failed state" } };
}

function planTerminalOutcome(root: PlanNode): StepOutcome {
	for (const n of walkNodes(root)) {
		if (n.status === "failed") {
			return {
				status: "failed",
				error: {
					message: n.error?.message ?? `node ${n.id} failed`,
					nodeId: n.id,
				},
			};
		}
	}
	return { status: "completed" };
}

function persistUsage(plan: Plan, tracker: BudgetTracker): Plan {
	return { ...plan, usage: tracker.snapshot() };
}

function isTreeTerminal(root: PlanNode): boolean {
	for (const n of walkNodes(root)) {
		if (n.type === "group") continue;
		if (
			n.status !== "completed" &&
			n.status !== "skipped" &&
			n.status !== "failed"
		) {
			return false;
		}
	}
	return true;
}

function findReadyNodes(root: PlanNode): PlanNode[] {
	const status = new Map<string, NodeStatus>();
	for (const n of walkNodes(root)) status.set(n.id, n.status);
	const out: PlanNode[] = [];

	const isRunnable = (n: PlanNode): boolean => {
		if (n.type === "group") return false;
		if (n.status !== "pending" && n.status !== "eligible") return false;
		const depsMet = n.dependsOn.every((d) => status.get(d) === "completed");
		if (!depsMet) return false;
		if (n.gatedOn) {
			const decide = findNode(root, n.gatedOn.decideNodeId);
			if (!decide || decide.status !== "completed") return false;
			const chosen = extractChosenOptionId(decide.output);
			if (chosen !== n.gatedOn.optionId) return false;
		}
		return true;
	};

	const collect = (node: PlanNode): void => {
		if (node.type !== "group") {
			if (isRunnable(node)) out.push(node);
			return;
		}
		// Respect sequence vs parallel
		if (node.mode === "parallel") {
			for (const c of node.children) collect(c);
			return;
		}
		for (const c of node.children) {
			if (c.status === "completed" || c.status === "skipped") continue;
			if (c.status === "failed") return; // group halts on failed child
			collect(c);
			return; // sequence: only first non-terminal child contributes
		}
	};

	collect(root);
	return out;
}

function gatherInputs(plan: Plan, node: PlanNode): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const id of node.dependsOn) {
		const dep = findNode(plan.tree, id);
		if (dep?.output !== undefined) out[id] = dep.output;
	}
	if (node.type === "verify" && node.targetNodeId) {
		const target = findNode(plan.tree, node.targetNodeId);
		if (target?.output !== undefined) out[node.targetNodeId] = target.output;
	}
	return out;
}

function requiresApproval(
	node: PlanNode,
	threshold: import("./severity").Severity,
): boolean {
	if (node.status !== "pending") return false;
	if (node.type === "decide" && node.forceHuman) return true;
	if (node.type !== "decide" && node.type !== "do") return false;
	return severityAtLeast(node.severity.grade, threshold);
}

function makeNodeApproval(node: PlanNode, nowIso: string): Approval {
	const kind: ApprovalKind = node.type === "decide" ? "decide_gate" : "do_gate";
	return {
		id: cryptoRandomId(),
		kind,
		nodeId: node.id,
		severity: node.severity.grade,
		prompt: approvalPrompt(node),
		options: node.type === "decide" ? node.options : [],
		status: "pending",
		requestedAt: nowIso,
	};
}

function makePlanApproval(plan: Plan, nowIso: string): Approval {
	return {
		id: cryptoRandomId(),
		kind: "plan_approval",
		nodeId: null,
		severity: null,
		prompt: `Approve plan "${plan.task}"?`,
		options: [],
		status: "pending",
		requestedAt: nowIso,
	};
}

function approvalPrompt(node: PlanNode): string {
	if (node.type === "decide") return node.question;
	if (node.type === "do") return `Approve action: ${node.action}`;
	return `Approve ${node.type}: ${node.title}`;
}

function extractChosenOptionId(output: unknown): string | undefined {
	if (output && typeof output === "object" && "chosenOptionId" in output) {
		const id = (output as { chosenOptionId: unknown }).chosenOptionId;
		return typeof id === "string" ? id : undefined;
	}
	return undefined;
}

function buildStarvationRevisions(
	plan: Plan,
	decideNodeId: string,
	chosenOptionId: string,
): PlanRevision[] {
	const revs: PlanRevision[] = [];
	for (const n of walkNodes(plan.tree)) {
		if (!n.gatedOn || n.gatedOn.decideNodeId !== decideNodeId) continue;
		if (n.gatedOn.optionId === chosenOptionId) continue;
		if (n.status === "completed" || n.status === "failed") continue;
		if (n.status === "skipped") continue;
		revs.push({
			kind: "skip_node",
			nodeId: n.id,
			reason: "alternative_not_chosen",
			cause: { type: "decision", sourceNodeId: decideNodeId },
		});
	}
	return revs;
}

function mutateNode(
	root: PlanNode,
	id: string,
	fn: (n: PlanNode) => PlanNode,
): PlanNode {
	if (root.id === id) return fn(root);
	if (root.type === "group") {
		return {
			...root,
			children: root.children.map((c) => mutateNode(c, id, fn)),
		};
	}
	return root;
}

function mutateNodeStatus(
	root: PlanNode,
	id: string,
	status: NodeStatus,
): PlanNode {
	return mutateNode(root, id, (n) => ({ ...n, status }));
}

function shouldRetry(policy: RetryPolicy, code: string | undefined): boolean {
	if (policy.retryOn === "any") return true;
	if (policy.retryOn === "transient") return true;
	if (Array.isArray(policy.retryOn)) {
		return !!code && policy.retryOn.includes(code);
	}
	return false;
}

function cryptoRandomId(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.randomUUID === "function"
	) {
		return globalThis.crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Re-exports for convenience.
export type {
	ExpansionHook,
	NodeRunContext,
	NodeRunner,
	NodeRunResult,
} from "./runner";
export { StubNodeRunner } from "./runner";

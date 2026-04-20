import type { Usage } from "./budget";
import type { PlanEvent } from "./events";
import type { ToolCache } from "./memoization";
import type { Plan, PlanNode } from "./plan";

/**
 * Result from running a single leaf node. Decide-node runners must put the
 * chosen option into `output.chosenOptionId`; research/discover runners should
 * put a structured summary into `output`; do/verify runners return
 * whatever their tool calls produced.
 */
export type NodeRunResult =
	| { ok: true; output: unknown; usage: Usage }
	| {
			ok: false;
			error: { message: string; code?: string };
			usage: Usage;
			/** Whether the error is retryable via the node's retry policy. */
			transient?: boolean;
			/**
			 * Minimum wall-clock wait (ms) before the executor should retry. Set when
			 * the underlying provider returned a rate-limit hint (e.g. `Retry-After`).
			 * The executor takes `max(policy.backoffMs, retryAfterMs)`.
			 */
			retryAfterMs?: number;
	  };

export interface NodeRunContext {
	readonly plan: Plan;
	readonly node: PlanNode;
	/**
	 * Outputs of nodes in `node.dependsOn` (and, for verify nodes, the
	 * `targetNodeId` output if present). Keyed by node id.
	 */
	readonly inputs: Record<string, unknown>;
	/** Push a PlanEvent for this run — executor buffers and relays. */
	readonly emit: (event: PlanEvent) => void;
	/** Abort signal propagated from `runStep`. */
	readonly signal: AbortSignal;
	/** Mutable tool cache. Runners should write before returning. */
	readonly cache: ToolCache;
}

export interface NodeRunner {
	run(ctx: NodeRunContext): Promise<NodeRunResult>;
}

/**
 * Runner hook invoked after a research/discover/decide node completes. May
 * return revisions to reshape the plan (expand placeholders, add branches).
 * Implementations typically delegate to `Planner.expand` but executor
 * consumers can plug any logic here.
 */
export interface ExpansionHook {
	expand(ctx: {
		plan: Plan;
		triggerNode: PlanNode;
	}): Promise<import("./plan").PlanRevision[]>;
}

/**
 * Zero-effect runner useful for tests that only exercise the state machine.
 * Completes every node with a stub output derived from its id.
 */
export class StubNodeRunner implements NodeRunner {
	async run(ctx: NodeRunContext): Promise<NodeRunResult> {
		const { node } = ctx;
		if (node.type === "decide") {
			const first = node.options[0];
			if (!first) {
				return {
					ok: false,
					error: { message: "no options" },
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
				};
			}
			return {
				ok: true,
				output: { chosenOptionId: first.id, rationale: "stub: first option" },
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			};
		}
		return {
			ok: true,
			output: `stub:${node.id}`,
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
		};
	}
}

import { z } from "zod";

export const Usage = z.object({
	inputTokens: z.number().int().nonnegative().default(0),
	outputTokens: z.number().int().nonnegative().default(0),
	costUsd: z.number().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

/**
 * Limits applied to a single `runStep` pass (and optionally to the plan as a whole).
 * Missing fields mean "no limit".
 */
export const ExecutorBudget = z.object({
	maxWallTimeMs: z.number().int().positive().optional(),
	maxNodes: z.number().int().positive().optional(),
	maxTokens: z.number().int().positive().optional(),
	maxCostUsd: z.number().positive().optional(),
	/**
	 * Yield when pressure > 1 - safetyMargin. Gives headroom for in-flight work
	 * to finish without overshooting the hard cap. 0..1, default 0.1.
	 */
	safetyMargin: z.number().min(0).max(1).default(0.1),
});
export type ExecutorBudget = z.infer<typeof ExecutorBudget>;

/**
 * Persistent per-plan caps. Checked on every step in addition to per-pass budgets.
 */
export const PlanBudgetCaps = z.object({
	maxTokens: z.number().int().positive().optional(),
	maxCostUsd: z.number().positive().optional(),
	maxWallTimeMs: z.number().int().positive().optional(),
	maxNodes: z.number().int().positive().optional(),
});
export type PlanBudgetCaps = z.infer<typeof PlanBudgetCaps>;

/**
 * Per-model pricing used to derive `costUsd` from token usage. Units: USD per
 * million tokens. Override via `PlanConfig.priceTable` or pass a custom one to
 * the executor.
 */
export const PriceTableEntry = z.object({
	inputPerMTokens: z.number().nonnegative(),
	outputPerMTokens: z.number().nonnegative(),
});
export type PriceTableEntry = z.infer<typeof PriceTableEntry>;

export const PriceTable = z.record(z.string(), PriceTableEntry);
export type PriceTable = z.infer<typeof PriceTable>;

export const DEFAULT_PRICE_TABLE: PriceTable = {
	"claude-opus-4-7": { inputPerMTokens: 15, outputPerMTokens: 75 },
	"claude-sonnet-4-6": { inputPerMTokens: 3, outputPerMTokens: 15 },
	"claude-haiku-4-5": { inputPerMTokens: 1, outputPerMTokens: 5 },
	"gpt-5": { inputPerMTokens: 10, outputPerMTokens: 30 },
	"gpt-5-codex": { inputPerMTokens: 10, outputPerMTokens: 30 },
};

export function estimateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
	table: PriceTable = DEFAULT_PRICE_TABLE,
): number {
	const entry = table[model];
	if (!entry) return 0;
	return (
		(inputTokens / 1_000_000) * entry.inputPerMTokens +
		(outputTokens / 1_000_000) * entry.outputPerMTokens
	);
}

/**
 * Runtime budget tracker. Not serialized — rebuilt each step from the plan's
 * cumulative `Usage` plus per-pass counters.
 */
export class BudgetTracker {
	private wallStart = Date.now();
	private nodesThisPass = 0;
	private tokensThisPass = 0;
	private costThisPass = 0;

	constructor(
		private readonly budget: ExecutorBudget,
		private readonly cumulative: Usage,
		private readonly caps?: PlanBudgetCaps,
	) {}

	addNode(): void {
		this.nodesThisPass++;
	}

	addUsage(inputTokens: number, outputTokens: number, costUsd: number): void {
		this.tokensThisPass += inputTokens + outputTokens;
		this.costThisPass += costUsd;
		this.cumulative.inputTokens += inputTokens;
		this.cumulative.outputTokens += outputTokens;
		this.cumulative.costUsd += costUsd;
	}

	/**
	 * Pressure across all active limits, 0..1. 1 = hard cap reached.
	 */
	pressure(): number {
		const ps: number[] = [];
		const { budget, caps, cumulative } = this;
		if (budget.maxWallTimeMs) {
			ps.push((Date.now() - this.wallStart) / budget.maxWallTimeMs);
		}
		if (budget.maxNodes) ps.push(this.nodesThisPass / budget.maxNodes);
		if (budget.maxTokens) ps.push(this.tokensThisPass / budget.maxTokens);
		if (budget.maxCostUsd) ps.push(this.costThisPass / budget.maxCostUsd);
		if (caps?.maxTokens) {
			ps.push(
				(cumulative.inputTokens + cumulative.outputTokens) / caps.maxTokens,
			);
		}
		if (caps?.maxCostUsd) ps.push(cumulative.costUsd / caps.maxCostUsd);
		return ps.length > 0 ? Math.max(...ps) : 0;
	}

	/**
	 * Whether starting more work is likely to exceed a cap given the safety margin.
	 */
	shouldYield(): boolean {
		return this.pressure() >= 1 - this.budget.safetyMargin;
	}

	/**
	 * Whether an estimated additional cost would exceed any cap.
	 */
	wouldExceed(estimate: {
		nodes?: number;
		tokens?: number;
		costUsd?: number;
		wallMs?: number;
	}): boolean {
		const { budget, caps, cumulative } = this;
		const wall = Date.now() - this.wallStart + (estimate.wallMs ?? 0);
		const nodes = this.nodesThisPass + (estimate.nodes ?? 0);
		const tokens = this.tokensThisPass + (estimate.tokens ?? 0);
		const cost = this.costThisPass + (estimate.costUsd ?? 0);
		if (budget.maxWallTimeMs && wall > budget.maxWallTimeMs) return true;
		if (budget.maxNodes && nodes > budget.maxNodes) return true;
		if (budget.maxTokens && tokens > budget.maxTokens) return true;
		if (budget.maxCostUsd && cost > budget.maxCostUsd) return true;
		if (
			caps?.maxTokens &&
			cumulative.inputTokens +
				cumulative.outputTokens +
				(estimate.tokens ?? 0) >
				caps.maxTokens
		)
			return true;
		if (
			caps?.maxCostUsd &&
			cumulative.costUsd + (estimate.costUsd ?? 0) > caps.maxCostUsd
		)
			return true;
		return false;
	}

	/**
	 * Which limit is responsible for the current pressure (for yield reasons).
	 */
	snapshot(): Usage {
		return { ...this.cumulative };
	}

	bottleneck():
		| "wall_time"
		| "node_count"
		| "token_budget"
		| "cost_budget"
		| null {
		const { budget, caps, cumulative } = this;
		const wall = budget.maxWallTimeMs
			? (Date.now() - this.wallStart) / budget.maxWallTimeMs
			: 0;
		const nodes = budget.maxNodes ? this.nodesThisPass / budget.maxNodes : 0;
		const tokensPass = budget.maxTokens
			? this.tokensThisPass / budget.maxTokens
			: 0;
		const costPass = budget.maxCostUsd
			? this.costThisPass / budget.maxCostUsd
			: 0;
		const tokensCap = caps?.maxTokens
			? (cumulative.inputTokens + cumulative.outputTokens) / caps.maxTokens
			: 0;
		const costCap = caps?.maxCostUsd ? cumulative.costUsd / caps.maxCostUsd : 0;
		const pairs: Array<
			[number, "wall_time" | "node_count" | "token_budget" | "cost_budget"]
		> = [
			[wall, "wall_time"],
			[nodes, "node_count"],
			[tokensPass, "token_budget"],
			[tokensCap, "token_budget"],
			[costPass, "cost_budget"],
			[costCap, "cost_budget"],
		];
		let top: [number, (typeof pairs)[number][1]] | null = null;
		for (const p of pairs) {
			if (p[0] >= 1 && (!top || p[0] > top[0])) top = p;
		}
		return top ? top[1] : null;
	}
}

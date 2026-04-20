import type { Provider } from "../providers/provider";

/**
 * Logical model tier. Out of the box the planner/runner use "smart" and "fast":
 * - "smart" — big, reasoning-heavy model for plan creation, revisions, conclusions,
 *   and high-severity decisions.
 * - "fast"  — cheaper, faster model for research/discovery gathering, do-node
 *   execution, and verification.
 *
 * Integrators can define additional tiers and reference them in phase overrides.
 */
export type ModelTier = string;

/** Concrete (provider, model) binding for a tier. */
export interface ModelBinding {
	provider: Provider;
	model: string;
	/** Per-binding temperature hint. Callers may still override. */
	temperature?: number;
	/** Per-binding max tokens hint. */
	maxTokens?: number;
}

export interface ModelRouter {
	/**
	 * Resolve a tier to a concrete binding. Implementations must return the same
	 * binding for the same tier across a single plan run so cost/usage stays
	 * predictable.
	 */
	resolve(tier: ModelTier): ModelBinding;
}

/**
 * Static tier → binding map. Use this when you have a fixed set of bindings
 * configured ahead of time (the common case).
 *
 * ```ts
 * const router = new StaticModelRouter({
 *   smart: { provider: claude, model: "claude-opus-4-7" },
 *   fast:  { provider: claude, model: "claude-haiku-4-5" },
 * });
 * ```
 *
 * Set `fallbackTier` to resolve unknown tiers rather than throw.
 */
export class StaticModelRouter implements ModelRouter {
	constructor(
		private readonly bindings: Record<string, ModelBinding>,
		private readonly fallbackTier?: ModelTier,
	) {
		if (Object.keys(bindings).length === 0) {
			throw new Error("StaticModelRouter requires at least one binding");
		}
	}

	resolve(tier: ModelTier): ModelBinding {
		const direct = this.bindings[tier];
		if (direct) return direct;
		if (this.fallbackTier) {
			const fb = this.bindings[this.fallbackTier];
			if (fb) return fb;
		}
		throw new Error(
			`ModelRouter: unknown tier "${tier}" (configured: ${Object.keys(this.bindings).join(", ")})`,
		);
	}
}

/**
 * Single-binding router. Useful for tests or single-model deployments where
 * cost tiering isn't worth the setup.
 */
export class SingleModelRouter implements ModelRouter {
	constructor(private readonly binding: ModelBinding) {}
	resolve(_tier: ModelTier): ModelBinding {
		return this.binding;
	}
}

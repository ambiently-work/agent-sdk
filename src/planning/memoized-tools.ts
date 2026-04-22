import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import type { z } from "zod";
import type { PlanEvent } from "./events";
import {
	type CachedToolResult,
	cacheKey,
	hashInputs,
	type NodeCachePolicy,
	type ToolCache,
} from "./memoization";

export interface MemoizeContext {
	readonly nodeId: string;
	readonly cache: ToolCache;
	readonly policy: NodeCachePolicy;
	readonly emit?: (event: PlanEvent) => void;
	readonly now?: () => string;
}

/**
 * Wraps a base tool so `run()` consults the cache before invoking the underlying
 * implementation. Cache writes only happen on successful runs — failures aren't
 * memoized so transient errors don't poison later steps.
 *
 * The wrapper preserves the base tool's `parse` behavior via the same schema,
 * meaning validation errors short-circuit before any cache lookup.
 */
class MemoizedTool<I = unknown, O = unknown> extends Tool<I, O> {
	readonly id: string;
	readonly description: string;
	readonly schema: z.ZodType<I>;

	constructor(
		private readonly base: Tool<I, O>,
		private readonly ctx: MemoizeContext,
	) {
		super();
		this.id = base.id;
		this.description = base.description;
		this.schema = base.schema;
	}

	async run(inputs: I): Promise<ToolResult<O>> {
		const inputsHash = hashInputs(inputs);
		const key = cacheKey(
			this.ctx.policy.scope,
			this.ctx.nodeId,
			this.id,
			inputsHash,
		);
		const hit = this.ctx.cache[key];
		if (hit) {
			this.ctx.emit?.({
				type: "node_tool_result",
				at: (this.ctx.now ?? (() => new Date().toISOString()))(),
				nodeId: this.ctx.nodeId,
				callId: `memo-${key}`,
				tool: this.id,
				ok: true,
				result: hit.result,
				fromCache: true,
			});
			return hit.result as ToolResult<O>;
		}
		const result = await this.base.run(inputs);
		if (result.ok) {
			const entry: CachedToolResult = {
				nodeId: this.ctx.nodeId,
				toolId: this.id,
				inputsHash,
				result,
				recordedAt: (this.ctx.now ?? (() => new Date().toISOString()))(),
			};
			this.ctx.cache[key] = entry;
			// For cross-node scopes, also register entries keyed under sharedWith
			// nodes so other executions find them via their own `nodeId`.
			if (this.ctx.policy.scope === "node") {
				for (const shared of this.ctx.policy.sharedWith) {
					const sharedKey = cacheKey("node", shared, this.id, inputsHash);
					this.ctx.cache[sharedKey] = entry;
				}
			}
		}
		return result;
	}
}

/**
 * Build a cache-aware registry from a base registry. Optionally filters to an
 * `allowed` set of tool ids (usually `PlanNode.allowedTools`). Returns a *new*
 * registry — the base is left intact.
 */
export function memoizeRegistry(
	base: ToolRegistry,
	ctx: MemoizeContext,
	allowed?: string[],
): ToolRegistry {
	const tools = base
		.list()
		.filter((t) => allowed === undefined || allowed.includes(t.id))
		.map((t) => new MemoizedTool(t, ctx));
	return new ToolRegistry(tools);
}

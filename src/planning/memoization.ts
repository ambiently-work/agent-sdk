import { z } from "zod";

export const NodeCacheScope = z.enum(["node", "plan", "global"]);
export type NodeCacheScope = z.infer<typeof NodeCacheScope>;

export const NodeCachePolicy = z.object({
	scope: NodeCacheScope.default("node"),
	/** Explicit node IDs that may share this node's cache (for fine-grained sharing). */
	sharedWith: z.array(z.string()).default([]),
});
export type NodeCachePolicy = z.infer<typeof NodeCachePolicy>;

export const CachedToolResult = z.object({
	nodeId: z.string(),
	toolId: z.string(),
	inputsHash: z.string(),
	/**
	 * Serialized result envelope. Matches the `Result` shape from tools.ts once
	 * JSON-round-tripped. Stored as unknown so jsonb encoding is trivial.
	 */
	result: z.unknown(),
	recordedAt: z.iso.datetime(),
});
export type CachedToolResult = z.infer<typeof CachedToolResult>;

/**
 * The cache map is keyed by `cacheKey(policy, nodeId, toolId, inputsHash)`. Stored
 * on the plan as a plain object for jsonb friendliness.
 */
export type ToolCache = Record<string, CachedToolResult>;

export const ToolCacheSchema = z.record(z.string(), CachedToolResult);

export function cacheKey(
	scope: NodeCacheScope,
	nodeId: string,
	toolId: string,
	inputsHash: string,
): string {
	if (scope === "node") return `n:${nodeId}:${toolId}:${inputsHash}`;
	if (scope === "plan") return `p:${toolId}:${inputsHash}`;
	return `g:${toolId}:${inputsHash}`;
}

/**
 * Stable, non-cryptographic hash for tool inputs. Inputs are first serialized
 * with sorted keys so that `{a:1,b:2}` and `{b:2,a:1}` collide.
 */
export function hashInputs(inputs: unknown): string {
	const canonical = stableStringify(inputs);
	return fnv1a(canonical);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts = keys.map(
		(k) =>
			`${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
	);
	return `{${parts.join(",")}}`;
}

function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

import type { PlanEvent } from "./events";
import {
	findNode,
	findParent,
	type Plan,
	type PlanNode,
	type PlanRevision,
	type SequencedRevision,
	validateDag,
	walkNodes,
} from "./plan";

export type RevisionApplyResult =
	| { ok: true; plan: Plan; events: PlanEvent[] }
	| { ok: false; error: string };

/**
 * Apply a batch of revisions to a plan. All-or-nothing: if any revision is
 * invalid or the resulting tree fails DAG validation, the plan is returned
 * unchanged with an error.
 */
export function applyRevisions(
	plan: Plan,
	revisions: PlanRevision[],
	opts: { now?: string } = {},
): RevisionApplyResult {
	if (revisions.length === 0) {
		return { ok: true, plan, events: [] };
	}
	const now = opts.now ?? new Date().toISOString();
	const startSeq = plan.revisions.length;

	let tree = deepClone(plan.tree);
	const appended: SequencedRevision[] = [];

	for (let i = 0; i < revisions.length; i++) {
		const rev = revisions[i];
		if (!rev) continue;
		const res = applyOne(tree, rev);
		if (!res.ok) return { ok: false, error: res.error };
		tree = res.tree;
		appended.push({
			seq: startSeq + i,
			appliedAt: now,
			revision: rev,
		});
	}

	const validation = validateDag(tree);
	if (!validation.ok) {
		return {
			ok: false,
			error: `revision produces invalid DAG: ${validation.error}`,
		};
	}

	const next: Plan = {
		...plan,
		tree,
		revisions: [...plan.revisions, ...appended],
		updatedAt: now,
	};

	const events: PlanEvent[] = [
		{ type: "plan_revised", at: now, revisions: [...revisions] },
	];

	return { ok: true, plan: next, events };
}

function applyOne(
	tree: PlanNode,
	rev: PlanRevision,
): { ok: true; tree: PlanNode } | { ok: false; error: string } {
	switch (rev.kind) {
		case "add_node": {
			const parent = findNode(tree, rev.parentId);
			if (!parent)
				return { ok: false, error: `parent ${rev.parentId} not found` };
			if (parent.type !== "group") {
				return {
					ok: false,
					error: `parent ${rev.parentId} is not a group (type=${parent.type})`,
				};
			}
			if (findNode(tree, rev.node.id)) {
				return { ok: false, error: `node ${rev.node.id} already exists` };
			}
			const pos = rev.position ?? parent.children.length;
			parent.children.splice(pos, 0, deepClone(rev.node));
			return { ok: true, tree };
		}
		case "skip_node": {
			const node = findNode(tree, rev.nodeId);
			if (!node) return { ok: false, error: `node ${rev.nodeId} not found` };
			if (node.status === "completed") {
				return { ok: false, error: `cannot skip completed node ${rev.nodeId}` };
			}
			for (const n of walkNodes(node)) {
				if (n.status === "pending" || n.status === "eligible") {
					n.status = "skipped";
					n.annotations.push(`skipped: ${rev.reason}`);
				}
			}
			return { ok: true, tree };
		}
		case "update_node": {
			const node = findNode(tree, rev.nodeId);
			if (!node) return { ok: false, error: `node ${rev.nodeId} not found` };
			if (node.status === "completed" || node.status === "failed") {
				return {
					ok: false,
					error: `cannot update terminal node ${rev.nodeId} (status=${node.status})`,
				};
			}
			// Whitelisted patchable fields — avoid clobbering id/type/status/children.
			const allowed: Array<keyof PlanNode> = [
				"title",
				"description",
				"dependsOn",
				"needsExpansion",
				"severity",
				"estimatedTokens",
				"allowedTools",
				"retryPolicy",
				"gatedOn",
			] as Array<keyof PlanNode>;
			for (const key of Object.keys(rev.patch)) {
				if (!allowed.includes(key as keyof PlanNode)) {
					return { ok: false, error: `patch field '${key}' not updatable` };
				}
				(node as Record<string, unknown>)[key] = rev.patch[key];
			}
			return { ok: true, tree };
		}
		case "annotate_node": {
			const node = findNode(tree, rev.nodeId);
			if (!node) return { ok: false, error: `node ${rev.nodeId} not found` };
			node.annotations.push(rev.note);
			return { ok: true, tree };
		}
		case "replace_node": {
			const node = findNode(tree, rev.nodeId);
			if (!node) return { ok: false, error: `node ${rev.nodeId} not found` };
			if (node.status !== "pending" && node.status !== "eligible") {
				return {
					ok: false,
					error: `cannot replace non-pending node ${rev.nodeId} (status=${node.status})`,
				};
			}
			if (rev.node.id !== rev.nodeId) {
				return {
					ok: false,
					error: `replace node id ${rev.node.id} must match target ${rev.nodeId}`,
				};
			}
			const parent = findParent(tree, rev.nodeId);
			if (!parent || parent.type !== "group") {
				// Root replacement — substitute directly.
				if (tree.id === rev.nodeId) {
					return { ok: true, tree: deepClone(rev.node) };
				}
				return { ok: false, error: `cannot locate parent of ${rev.nodeId}` };
			}
			const idx = parent.children.findIndex((c) => c.id === rev.nodeId);
			if (idx < 0) return { ok: false, error: `child ${rev.nodeId} missing` };
			parent.children[idx] = deepClone(rev.node);
			return { ok: true, tree };
		}
	}
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

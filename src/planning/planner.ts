import { z } from "zod";
import { Agent } from "../agent/agent";
import type { Provider } from "../providers/provider";
import { Tool, ToolRegistry, type ToolResult } from "../tools/tools";
import {
	type ModelBinding,
	type ModelRouter,
	type ModelTier,
	SingleModelRouter,
} from "./model-router";
import {
	Plan,
	type PlanConfig,
	type PlanNode,
	type PlanRevision,
} from "./plan";
import type { ExpansionHook } from "./runner";
import { SeverityGrade } from "./severity";

// ---------------------------------------------------------------------------
// Flat node schema — planner emits a list; we reassemble into a tree.
// Recursive zod doesn't serialize cleanly through JSON Schema, and LLMs are
// much more reliable with flat `parentId` references than deep nesting.
// ---------------------------------------------------------------------------

export const FlatNodeType = z.enum([
	"research",
	"discover",
	"decide",
	"do",
	"verify",
	"group",
]);
export type FlatNodeType = z.infer<typeof FlatNodeType>;

export const FlatDecisionOption = z.object({
	id: z.string(),
	label: z.string(),
	rationale: z.string().optional(),
});

export const FlatGatedOn = z.object({
	decideNodeId: z.string(),
	optionId: z.string(),
});

export const FlatPlanNode = z.object({
	id: z.string(),
	parentId: z.string().nullable(),
	type: FlatNodeType,
	title: z.string(),
	description: z.string(),
	dependsOn: z.array(z.string()).default([]),
	gatedOn: FlatGatedOn.optional(),
	needsExpansion: z.boolean().default(false),
	severity: SeverityGrade,
	estimatedTokens: z.number().int().positive().optional(),
	allowedTools: z.array(z.string()).optional(),

	// Type-specific (all optional at flat layer; validated after reassembly).
	questions: z.array(z.string()).optional(),
	scope: z.string().optional(),
	question: z.string().optional(),
	options: z.array(FlatDecisionOption).optional(),
	criteria: z.array(z.string()).optional(),
	forceHuman: z.boolean().optional(),
	action: z.string().optional(),
	idempotencyKey: z.string().optional(),
	check: z.string().optional(),
	targetNodeId: z.string().optional(),
	mode: z.enum(["sequence", "parallel"]).optional(),
});
export type FlatPlanNode = z.infer<typeof FlatPlanNode>;

export const SubmitPlanInput = z.object({
	rootId: z.string(),
	nodes: z.array(FlatPlanNode).min(1),
});
export type SubmitPlanInput = z.infer<typeof SubmitPlanInput>;

export const SubmitRevisionsInput = z.object({
	revisions: z.array(
		z.object({
			kind: z.enum([
				"add_node",
				"skip_node",
				"update_node",
				"annotate_node",
				"replace_node",
			]),
			// Generic payloads; validated when we build the PlanRevision union.
			parentId: z.string().optional(),
			nodeId: z.string().optional(),
			reason: z.string().optional(),
			note: z.string().optional(),
			position: z.number().int().nonnegative().optional(),
			node: FlatPlanNode.optional(),
			nodes: z.array(FlatPlanNode).optional(),
			patch: z.record(z.string(), z.unknown()).optional(),
		}),
	),
});
export type SubmitRevisionsInput = z.infer<typeof SubmitRevisionsInput>;

// ---------------------------------------------------------------------------
// Flat → tree reassembly
// ---------------------------------------------------------------------------

export function reassembleTree(input: SubmitPlanInput): PlanNode {
	const byId = new Map(input.nodes.map((n) => [n.id, n]));
	if (!byId.has(input.rootId)) {
		throw new Error(`submit_plan: root node ${input.rootId} not in nodes list`);
	}
	const childrenByParent = new Map<string, FlatPlanNode[]>();
	for (const n of input.nodes) {
		if (n.parentId === null) continue;
		if (!byId.has(n.parentId)) {
			throw new Error(
				`submit_plan: node ${n.id} references missing parent ${n.parentId}`,
			);
		}
		const list = childrenByParent.get(n.parentId) ?? [];
		list.push(n);
		childrenByParent.set(n.parentId, list);
	}
	const build = (id: string): PlanNode => {
		const flat = byId.get(id);
		if (!flat) throw new Error(`submit_plan: unknown id ${id}`);
		const children = childrenByParent.get(id) ?? [];
		return toPlanNode(
			flat,
			children.map((c) => build(c.id)),
		);
	};
	return build(input.rootId);
}

function toPlanNode(flat: FlatPlanNode, children: PlanNode[]): PlanNode {
	const base = {
		id: flat.id,
		title: flat.title,
		description: flat.description,
		status: "pending" as const,
		dependsOn: flat.dependsOn,
		gatedOn: flat.gatedOn,
		needsExpansion: flat.needsExpansion,
		severity: flat.severity,
		estimatedTokens: flat.estimatedTokens,
		allowedTools: flat.allowedTools,
		attempts: 0,
		annotations: [],
	};
	switch (flat.type) {
		case "research":
			return { ...base, type: "research", questions: flat.questions ?? [] };
		case "discover":
			if (!flat.scope) throw new Error(`discover ${flat.id} missing scope`);
			return { ...base, type: "discover", scope: flat.scope };
		case "decide":
			if (!flat.question) {
				throw new Error(`decide ${flat.id} missing question`);
			}
			if (!flat.options || flat.options.length === 0) {
				throw new Error(`decide ${flat.id} missing options`);
			}
			return {
				...base,
				type: "decide",
				question: flat.question,
				options: flat.options,
				criteria: flat.criteria ?? [],
				forceHuman: flat.forceHuman ?? false,
			};
		case "do":
			if (!flat.action) throw new Error(`do ${flat.id} missing action`);
			return {
				...base,
				type: "do",
				action: flat.action,
				idempotencyKey: flat.idempotencyKey,
			};
		case "verify":
			if (!flat.check) throw new Error(`verify ${flat.id} missing check`);
			return {
				...base,
				type: "verify",
				check: flat.check,
				targetNodeId: flat.targetNodeId,
			};
		case "group":
			return {
				...base,
				type: "group",
				mode: flat.mode ?? "sequence",
				children,
			};
	}
}

export function flatRevisionsToPlan(
	input: SubmitRevisionsInput,
): PlanRevision[] {
	const out: PlanRevision[] = [];
	for (const r of input.revisions) {
		switch (r.kind) {
			case "add_node": {
				if (!r.parentId || !r.node) {
					throw new Error("add_node requires parentId and node");
				}
				out.push({
					kind: "add_node",
					parentId: r.parentId,
					position: r.position,
					node: toPlanNode(r.node, []),
					cause: { type: "expansion", sourceNodeId: r.parentId },
				});
				break;
			}
			case "skip_node": {
				if (!r.nodeId || !r.reason) {
					throw new Error("skip_node requires nodeId and reason");
				}
				out.push({
					kind: "skip_node",
					nodeId: r.nodeId,
					reason: r.reason,
					cause: { type: "human", actor: "planner" },
				});
				break;
			}
			case "update_node": {
				if (!r.nodeId || !r.patch) {
					throw new Error("update_node requires nodeId and patch");
				}
				out.push({
					kind: "update_node",
					nodeId: r.nodeId,
					patch: r.patch,
					cause: { type: "human", actor: "planner" },
				});
				break;
			}
			case "annotate_node": {
				if (!r.nodeId || !r.note) {
					throw new Error("annotate_node requires nodeId and note");
				}
				out.push({
					kind: "annotate_node",
					nodeId: r.nodeId,
					note: r.note,
				});
				break;
			}
			case "replace_node": {
				if (!r.nodeId || !r.node) {
					throw new Error("replace_node requires nodeId and node");
				}
				out.push({
					kind: "replace_node",
					nodeId: r.nodeId,
					node: toPlanNode(r.node, []),
					cause: { type: "human", actor: "planner" },
				});
				break;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Planner tools (capture submissions, then Agent loop exits)
// ---------------------------------------------------------------------------

class CapturingTool<I, O> extends Tool<I, O> {
	readonly id: string;
	readonly description: string;
	readonly schema: z.ZodType<I>;
	captured: I | undefined;
	private readonly onCapture: (value: I) => O;

	constructor(opts: {
		id: string;
		description: string;
		schema: z.ZodType<I>;
		onCapture: (value: I) => O;
	}) {
		super();
		this.id = opts.id;
		this.description = opts.description;
		this.schema = opts.schema;
		this.onCapture = opts.onCapture;
	}

	async run(inputs: I): Promise<ToolResult<O>> {
		this.captured = inputs;
		try {
			return { ok: true, value: this.onCapture(inputs) };
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "tool_failed",
					message: err instanceof Error ? err.message : String(err),
				},
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Two shapes are accepted:
 * - Provider+model (simple): planner runs every phase with the same binding.
 * - Router + tier (recommended): planner asks the router for a `"smart"` binding
 *   (override via `plannerTier`) so integrators can route planning to a reasoning
 *   model while keeping execution on a cheaper one via `AgentNodeRunner`.
 */
export type PlannerOptions =
	| {
			provider: Provider;
			model: string;
			router?: undefined;
			plannerTier?: undefined;
			systemPromptExtra?: string;
			temperature?: number;
			maxToolIterations?: number;
	  }
	| {
			router: ModelRouter;
			/** Tier to resolve for planning work. Default `"smart"`. */
			plannerTier?: ModelTier;
			provider?: undefined;
			model?: undefined;
			systemPromptExtra?: string;
			temperature?: number;
			maxToolIterations?: number;
	  };

const PLAN_SYSTEM_PROMPT = `You are a planning agent. Your job is to break a user task into a structured plan tree.

Available node types:
- research: targeted Q&A on a known topic (read-only)
- discover: open-ended exploration of unknown space (read-only)
- decide: pick between options. Must specify all candidate option subtrees upfront; use \`gatedOn\` on children of each option.
- do: execute a change (side-effecting)
- verify: confirm a \`do\` succeeded (read-only)
- group: container with \`mode: "sequence" | "parallel"\`

For every node you must grade severity (impact × reversibility) honestly. Use \`needsExpansion: true\` on placeholder nodes you don't fully plan yet.

When you're ready, call the \`submit_plan\` tool with the final flat node list. The list must include a root node (id referenced in \`rootId\`) and every other node's \`parentId\`. After submitting, stop producing output.`;

const EXPAND_SYSTEM_PROMPT = `You are revising an in-flight plan. A research/discover/decide node just completed. Based on its output, propose revisions that:
- Fill in any \`needsExpansion: true\` descendants of the trigger
- Add new sibling nodes if discoveries demand them
- Skip now-irrelevant pending nodes (with a clear \`reason\`)

Emit revisions via the \`submit_revisions\` tool. Use \`annotate_node\` for learnings you want preserved without structural change. Do not touch completed nodes. After submitting, stop.`;

const REVISE_SYSTEM_PROMPT = `You are revising a plan given feedback. Emit a minimal set of revisions via \`submit_revisions\` that address the feedback while preserving completed work. Do not touch completed nodes. After submitting, stop.`;

export class Planner {
	private readonly router: ModelRouter;
	private readonly plannerTier: ModelTier;
	private readonly systemPromptExtra?: string;
	private readonly temperature?: number;
	private readonly maxToolIterations: number;

	constructor(opts: PlannerOptions) {
		if (opts.router) {
			this.router = opts.router;
			this.plannerTier = opts.plannerTier ?? "smart";
		} else {
			this.router = new SingleModelRouter({
				provider: opts.provider,
				model: opts.model,
			});
			this.plannerTier = "smart";
		}
		this.systemPromptExtra = opts.systemPromptExtra;
		this.temperature = opts.temperature;
		this.maxToolIterations = opts.maxToolIterations ?? 4;
	}

	private binding(): ModelBinding {
		return this.router.resolve(this.plannerTier);
	}

	async createPlan(params: {
		task: string;
		config: PlanConfig;
		id?: string;
		now?: () => string;
	}): Promise<Plan> {
		const now = params.now ?? (() => new Date().toISOString());
		const tool = new CapturingTool<SubmitPlanInput, string>({
			id: "submit_plan",
			description:
				"Submit the final plan tree as a flat node list with parentId references.",
			schema: SubmitPlanInput,
			onCapture: () => "plan submitted",
		});
		const registry = new ToolRegistry([tool]);
		const binding = this.binding();
		const agent = new Agent(binding.provider, registry);

		const systemPrompt = this.systemPromptExtra
			? `${PLAN_SYSTEM_PROMPT}\n\n${this.systemPromptExtra}`
			: PLAN_SYSTEM_PROMPT;

		for await (const _ of agent.run({
			model: binding.model,
			systemPrompt,
			temperature: this.temperature ?? binding.temperature ?? 0.2,
			maxTokens: binding.maxTokens,
			maxToolIterations: this.maxToolIterations,
			messages: [
				{
					role: "user",
					content: `Task: ${params.task}\n\nProduce a full plan and submit it via the submit_plan tool.`,
				},
			],
		})) {
			void _;
		}

		if (!tool.captured) {
			throw new Error("planner did not submit a plan");
		}
		const tree = reassembleTree(tool.captured);
		const planId = params.id ?? cryptoRandomId();
		const plan = Plan.parse({
			id: planId,
			version: 0,
			status: "awaiting_plan_approval",
			task: params.task,
			config: params.config,
			tree,
			createdAt: now(),
			updatedAt: now(),
		});
		return plan;
	}

	async expandPlan(params: {
		plan: Plan;
		triggerNode: PlanNode;
	}): Promise<PlanRevision[]> {
		return this.reviseInternal(params.plan, EXPAND_SYSTEM_PROMPT, {
			kind: "expansion",
			triggerNodeId: params.triggerNode.id,
			triggerOutput: params.triggerNode.output,
		});
	}

	/**
	 * Adapter that exposes this planner as an `ExpansionHook` for the executor.
	 * After every successful research/discover/decide node, the executor calls
	 * `expand(...)` and the planner proposes revisions — typically filling in
	 * `needsExpansion: true` descendants or adding follow-ups based on output.
	 *
	 * By default, the hook only invokes the planner when the plan still
	 * contains at least one pending `needsExpansion: true` node — otherwise
	 * there's nothing to revise and we'd just burn tokens. Set `always: true`
	 * to let the planner review after every trigger.
	 */
	asExpansionHook(opts: { always?: boolean } = {}): ExpansionHook {
		return {
			expand: async ({ plan, triggerNode }) => {
				if (!opts.always && !planHasPendingExpansion(plan.tree)) return [];
				return this.expandPlan({ plan, triggerNode });
			},
		};
	}

	async revisePlan(params: {
		plan: Plan;
		feedback: string;
	}): Promise<PlanRevision[]> {
		return this.reviseInternal(params.plan, REVISE_SYSTEM_PROMPT, {
			kind: "feedback",
			feedback: params.feedback,
		});
	}

	private async reviseInternal(
		plan: Plan,
		systemPrompt: string,
		context: Record<string, unknown>,
	): Promise<PlanRevision[]> {
		const tool = new CapturingTool<SubmitRevisionsInput, string>({
			id: "submit_revisions",
			description:
				"Submit a batch of revisions to apply to the plan. Only touch pending nodes.",
			schema: SubmitRevisionsInput,
			onCapture: () => "revisions submitted",
		});
		const registry = new ToolRegistry([tool]);
		const binding = this.binding();
		const agent = new Agent(binding.provider, registry);

		const full = this.systemPromptExtra
			? `${systemPrompt}\n\n${this.systemPromptExtra}`
			: systemPrompt;

		for await (const _ of agent.run({
			model: binding.model,
			systemPrompt: full,
			temperature: this.temperature ?? binding.temperature ?? 0.2,
			maxTokens: binding.maxTokens,
			maxToolIterations: this.maxToolIterations,
			messages: [
				{
					role: "user",
					content: JSON.stringify({
						plan: {
							id: plan.id,
							task: plan.task,
							tree: plan.tree,
						},
						context,
					}),
				},
			],
		})) {
			void _;
		}

		if (!tool.captured) return [];
		return flatRevisionsToPlan(tool.captured);
	}
}

function planHasPendingExpansion(node: PlanNode): boolean {
	if (node.needsExpansion && node.status === "pending") return true;
	if (node.type === "group") {
		for (const child of node.children) {
			if (planHasPendingExpansion(child)) return true;
		}
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
	return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

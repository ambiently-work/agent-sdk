import { z } from "zod";
import type { Message, ProviderEvent, RunInput } from "../providers/provider";
import { Tool, ToolRegistry, type ToolResult } from "@ambiently-work/faux";
import {
	DEFAULT_PRICE_TABLE,
	estimateCost,
	type PriceTable,
	type Usage,
} from "./budget";
import type { NodeCachePolicy } from "./memoization";
import { memoizeRegistry } from "./memoized-tools";
import type { ModelRouter, ModelTier } from "./model-router";
import type { PlanNode } from "./plan";
import type { NodeRunContext, NodeRunner, NodeRunResult } from "./runner";

// ---------------------------------------------------------------------------
// Phase tier configuration
// ---------------------------------------------------------------------------

/**
 * Model tier used for each phase of node execution. Defaults encode the
 * cost-optimization story: gather with "fast", conclude/decide with "smart".
 * Override any field to route differently.
 */
export interface PhaseTiers {
	researchGather: ModelTier;
	researchConclude: ModelTier;
	discoverGather: ModelTier;
	discoverConclude: ModelTier;
	decide: ModelTier;
	do: ModelTier;
	verify: ModelTier;
}

export const DEFAULT_PHASE_TIERS: PhaseTiers = {
	researchGather: "fast",
	researchConclude: "smart",
	discoverGather: "fast",
	discoverConclude: "smart",
	decide: "smart",
	do: "fast",
	verify: "fast",
};

// ---------------------------------------------------------------------------
// Structured submit schemas (each phase ends with one)
// ---------------------------------------------------------------------------

export const SubmitFindingsInput = z.object({
	summary: z.string(),
	findings: z.array(z.string()).default([]),
	confidence: z.enum(["low", "medium", "high"]).default("medium"),
	openQuestions: z.array(z.string()).default([]),
});
export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInput>;

export const SubmitDiscoveriesInput = z.object({
	summary: z.string(),
	discoveries: z.array(z.string()).default([]),
	unknowns: z.array(z.string()).default([]),
	suggestedNextNodes: z
		.array(
			z.object({
				title: z.string(),
				rationale: z.string().optional(),
			}),
		)
		.default([]),
});
export type SubmitDiscoveriesInput = z.infer<typeof SubmitDiscoveriesInput>;

export const SubmitDecisionInput = z.object({
	chosenOptionId: z.string(),
	rationale: z.string(),
	confidence: z.enum(["low", "medium", "high"]).default("medium"),
	dissent: z.string().optional(),
});
export type SubmitDecisionInput = z.infer<typeof SubmitDecisionInput>;

export const SubmitActionInput = z.object({
	summary: z.string(),
	outputs: z.record(z.string(), z.unknown()).default({}),
	sideEffects: z.array(z.string()).default([]),
});
export type SubmitActionInput = z.infer<typeof SubmitActionInput>;

export const SubmitVerificationInput = z.object({
	passed: z.boolean(),
	details: z.string(),
	remediation: z.string().optional(),
});
export type SubmitVerificationInput = z.infer<typeof SubmitVerificationInput>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgentNodeRunnerOptions {
	router: ModelRouter;
	/** Base tool registry presented to do/verify/research/discover nodes. */
	tools?: ToolRegistry;
	/** Phase → tier overrides. */
	phaseTiers?: Partial<PhaseTiers>;
	/** Default cache policy when a node has no explicit policy. */
	defaultCachePolicy?: NodeCachePolicy;
	/** Max tool iterations per Agent.run. Default 8. */
	maxToolIterations?: number;
	/** Default temperature when the binding doesn't specify one. */
	temperature?: number;
	/** Price table for cost estimation when providers don't self-report. */
	priceTable?: PriceTable;
	/** Extra system prompt content appended to every phase. */
	systemPromptExtra?: string;
	/** Deterministic clock for tests. */
	now?: () => string;
}

// ---------------------------------------------------------------------------
// AgentNodeRunner
// ---------------------------------------------------------------------------

export class AgentNodeRunner implements NodeRunner {
	private readonly router: ModelRouter;
	private readonly baseTools: ToolRegistry;
	private readonly tiers: PhaseTiers;
	private readonly defaultCachePolicy: NodeCachePolicy;
	private readonly maxToolIterations: number;
	private readonly temperature?: number;
	private readonly priceTable: PriceTable;
	private readonly systemPromptExtra?: string;
	private readonly now: () => string;

	constructor(opts: AgentNodeRunnerOptions) {
		this.router = opts.router;
		this.baseTools = opts.tools ?? new ToolRegistry();
		this.tiers = { ...DEFAULT_PHASE_TIERS, ...opts.phaseTiers };
		this.defaultCachePolicy = opts.defaultCachePolicy ?? {
			scope: "node",
			sharedWith: [],
		};
		this.maxToolIterations = opts.maxToolIterations ?? 8;
		this.temperature = opts.temperature;
		this.priceTable = opts.priceTable ?? DEFAULT_PRICE_TABLE;
		this.systemPromptExtra = opts.systemPromptExtra;
		this.now = opts.now ?? (() => new Date().toISOString());
	}

	async run(ctx: NodeRunContext): Promise<NodeRunResult> {
		try {
			switch (ctx.node.type) {
				case "research":
					return await this.runResearch(ctx);
				case "discover":
					return await this.runDiscover(ctx);
				case "decide":
					return await this.runDecide(ctx);
				case "do":
					return await this.runDo(ctx);
				case "verify":
					return await this.runVerify(ctx);
				case "group":
					return {
						ok: false,
						error: {
							code: "not_a_leaf",
							message: "AgentNodeRunner cannot execute group nodes",
						},
						usage: zeroUsage(),
						transient: false,
					};
			}
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "runner_threw",
					message: err instanceof Error ? err.message : String(err),
				},
				usage: zeroUsage(),
				transient: true,
			};
		}
	}

	// ------------------------------------------------------------------
	// Research: gather (fast + tools) → conclude (smart, no tools)
	// ------------------------------------------------------------------

	private async runResearch(ctx: NodeRunContext): Promise<NodeRunResult> {
		const node = ctx.node;
		if (node.type !== "research") throw new Error("not research");

		const gatherPrompt = `You are conducting targeted research for a plan node.
Node: ${node.title}
Description: ${node.description}
Questions:
${(node.questions ?? []).map((q) => `- ${q}`).join("\n") || "(none)"}

Use the available tools to gather concrete information. When you have enough to answer the questions, produce a concise notes summary and stop.`;

		const gather = await this.runPhase({
			ctx,
			tier: this.tiers.researchGather,
			systemPrompt: PHASE_SYSTEM_PROMPTS.researchGather,
			userPrompt: gatherPrompt,
			tools: this.allowedToolRegistry(ctx, node),
			captureTool: null,
			inputsSummary: summarizeInputs(ctx.inputs),
		});
		if (!gather.ok) return gather;

		const conclude = await this.runPhase<SubmitFindingsInput>({
			ctx,
			tier: this.tiers.researchConclude,
			systemPrompt: PHASE_SYSTEM_PROMPTS.researchConclude,
			userPrompt: `Questions:\n${(node.questions ?? []).map((q) => `- ${q}`).join("\n") || "(none)"}\n\nGather notes:\n${gather.value.text || "(no notes)"}\n\nNow call submit_findings with the synthesized result.`,
			tools: null,
			captureTool: {
				id: "submit_findings",
				description:
					"Submit the synthesized research findings. Call exactly once.",
				schema: SubmitFindingsInput,
			},
			inputsSummary: undefined,
		});
		if (!conclude.ok) return conclude;

		const totalUsage = addUsage(gather.value.usage, conclude.value.usage);
		return {
			ok: true,
			output: conclude.value.captured ?? {
				summary: gather.value.text,
				findings: [],
				confidence: "low",
				openQuestions: [],
			},
			usage: totalUsage,
		};
	}

	// ------------------------------------------------------------------
	// Discover: gather (fast + tools) → conclude (smart, no tools)
	// ------------------------------------------------------------------

	private async runDiscover(ctx: NodeRunContext): Promise<NodeRunResult> {
		const node = ctx.node;
		if (node.type !== "discover") throw new Error("not discover");

		const gatherPrompt = `You are doing open-ended discovery for a plan node.
Node: ${node.title}
Description: ${node.description}
Scope: ${node.scope}

Probe the scope using the tools to surface unknowns, surprises, or signal that constrains downstream decisions. Stop when you have enough signal; do NOT aim for completeness.`;

		const gather = await this.runPhase({
			ctx,
			tier: this.tiers.discoverGather,
			systemPrompt: PHASE_SYSTEM_PROMPTS.discoverGather,
			userPrompt: gatherPrompt,
			tools: this.allowedToolRegistry(ctx, node),
			captureTool: null,
			inputsSummary: summarizeInputs(ctx.inputs),
		});
		if (!gather.ok) return gather;

		const conclude = await this.runPhase<SubmitDiscoveriesInput>({
			ctx,
			tier: this.tiers.discoverConclude,
			systemPrompt: PHASE_SYSTEM_PROMPTS.discoverConclude,
			userPrompt: `Scope: ${node.scope}\n\nGather notes:\n${gather.value.text || "(no notes)"}\n\nNow call submit_discoveries.`,
			tools: null,
			captureTool: {
				id: "submit_discoveries",
				description:
					"Submit the synthesized discovery output. Call exactly once.",
				schema: SubmitDiscoveriesInput,
			},
			inputsSummary: undefined,
		});
		if (!conclude.ok) return conclude;

		return {
			ok: true,
			output: conclude.value.captured ?? {
				summary: gather.value.text,
				discoveries: [],
				unknowns: [],
				suggestedNextNodes: [],
			},
			usage: addUsage(gather.value.usage, conclude.value.usage),
		};
	}

	// ------------------------------------------------------------------
	// Decide: single smart pass, submit_decision tool
	// ------------------------------------------------------------------

	private async runDecide(ctx: NodeRunContext): Promise<NodeRunResult> {
		const node = ctx.node;
		if (node.type !== "decide") throw new Error("not decide");

		const optionIds = node.options.map((o) => o.id);
		const SubmitDecisionForNode = SubmitDecisionInput.extend({
			chosenOptionId: z.enum(optionIds as [string, ...string[]]),
		});

		const optionsBlock = node.options
			.map(
				(o) =>
					`- id=${o.id} label=${JSON.stringify(o.label)}${o.rationale ? ` rationale=${JSON.stringify(o.rationale)}` : ""}`,
			)
			.join("\n");
		const criteriaBlock = node.criteria.length
			? `\nCriteria:\n${node.criteria.map((c) => `- ${c}`).join("\n")}`
			: "";

		const prompt = `Decision: ${node.question}
${node.description ? `Context: ${node.description}\n` : ""}Options:
${optionsBlock}${criteriaBlock}

Inputs from upstream nodes:
${summarizeInputs(ctx.inputs) || "(none)"}

Pick one option and call submit_decision. Be decisive.`;

		const phase = await this.runPhase<z.infer<typeof SubmitDecisionForNode>>({
			ctx,
			tier: this.tiers.decide,
			systemPrompt: PHASE_SYSTEM_PROMPTS.decide,
			userPrompt: prompt,
			tools: null,
			captureTool: {
				id: "submit_decision",
				description: "Submit the chosen option. Call exactly once.",
				schema: SubmitDecisionForNode,
			},
			inputsSummary: undefined,
		});
		if (!phase.ok) return phase;
		if (!phase.value.captured) {
			return {
				ok: false,
				error: {
					code: "no_decision",
					message: "decide phase did not submit a decision",
				},
				usage: phase.value.usage,
				transient: true,
			};
		}
		return {
			ok: true,
			output: {
				chosenOptionId: phase.value.captured.chosenOptionId,
				rationale: phase.value.captured.rationale,
				confidence: phase.value.captured.confidence,
				dissent: phase.value.captured.dissent,
				source: "agent",
			},
			usage: phase.value.usage,
		};
	}

	// ------------------------------------------------------------------
	// Do: fast + allowed tools, submit_action to finalize
	// ------------------------------------------------------------------

	private async runDo(ctx: NodeRunContext): Promise<NodeRunResult> {
		const node = ctx.node;
		if (node.type !== "do") throw new Error("not do");

		const prompt = `Action to perform: ${node.action}
${node.description ? `Context: ${node.description}\n` : ""}${node.idempotencyKey ? `Idempotency key: ${node.idempotencyKey}\n` : ""}
Inputs from upstream nodes:
${summarizeInputs(ctx.inputs) || "(none)"}

Use the provided tools to perform the action. When done, call submit_action exactly once with a summary and any structured outputs.`;

		const phase = await this.runPhase<SubmitActionInput>({
			ctx,
			tier: this.tiers.do,
			systemPrompt: PHASE_SYSTEM_PROMPTS.do,
			userPrompt: prompt,
			tools: this.allowedToolRegistry(ctx, node),
			captureTool: {
				id: "submit_action",
				description:
					"Submit the action summary and any structured outputs. Call exactly once.",
				schema: SubmitActionInput,
			},
			inputsSummary: undefined,
		});
		if (!phase.ok) return phase;
		return {
			ok: true,
			output: phase.value.captured ?? {
				summary: phase.value.text,
				outputs: {},
				sideEffects: [],
			},
			usage: phase.value.usage,
		};
	}

	// ------------------------------------------------------------------
	// Verify: fast + allowed tools, submit_verification to finalize
	// ------------------------------------------------------------------

	private async runVerify(ctx: NodeRunContext): Promise<NodeRunResult> {
		const node = ctx.node;
		if (node.type !== "verify") throw new Error("not verify");

		const prompt = `Verification check: ${node.check}
${node.description ? `Context: ${node.description}\n` : ""}${
	node.targetNodeId ? `Target node: ${node.targetNodeId}\n` : ""
}
Inputs from upstream / target nodes:
${summarizeInputs(ctx.inputs) || "(none)"}

Use the tools to evaluate the check. Call submit_verification with passed=true/false and details.`;

		const phase = await this.runPhase<SubmitVerificationInput>({
			ctx,
			tier: this.tiers.verify,
			systemPrompt: PHASE_SYSTEM_PROMPTS.verify,
			userPrompt: prompt,
			tools: this.allowedToolRegistry(ctx, node),
			captureTool: {
				id: "submit_verification",
				description:
					"Submit the verification result. Call exactly once with passed=true or false.",
				schema: SubmitVerificationInput,
			},
			inputsSummary: undefined,
		});
		if (!phase.ok) return phase;
		const captured = phase.value.captured;
		if (!captured) {
			return {
				ok: false,
				error: {
					code: "no_verification",
					message: "verify phase did not submit a result",
				},
				usage: phase.value.usage,
				transient: true,
			};
		}
		// Failing verification is still a successful node run — the node's output
		// communicates pass/fail. The executor / expansion hook decides what to do.
		return {
			ok: true,
			output: captured,
			usage: phase.value.usage,
		};
	}

	// ------------------------------------------------------------------
	// Internal: run one phase (one Agent.run loop)
	// ------------------------------------------------------------------

	private async runPhase<TCapture = unknown>(args: {
		ctx: NodeRunContext;
		tier: ModelTier;
		systemPrompt: string;
		userPrompt: string;
		tools: ToolRegistry | null;
		captureTool: {
			id: string;
			description: string;
			schema: z.ZodType<TCapture>;
		} | null;
		inputsSummary: string | undefined;
	}): Promise<
		| {
				ok: true;
				value: { text: string; usage: Usage; captured: TCapture | undefined };
		  }
		| {
				ok: false;
				error: { message: string; code?: string };
				usage: Usage;
				transient?: boolean;
				retryAfterMs?: number;
		  }
	> {
		const binding = this.router.resolve(args.tier);
		const captured: { value: TCapture | undefined } = { value: undefined };

		let registry = args.tools ?? new ToolRegistry();
		if (args.captureTool) {
			const capture = new CaptureTool<TCapture>({
				id: args.captureTool.id,
				description: args.captureTool.description,
				schema: args.captureTool.schema,
				onCapture: (v) => {
					captured.value = v;
				},
			});
			const combined = new ToolRegistry(registry.list());
			combined.register(capture);
			registry = combined;
		}

		const systemPrompt = this.systemPromptExtra
			? `${args.systemPrompt}\n\n${this.systemPromptExtra}`
			: args.systemPrompt;

		const messages: Message[] = [
			{
				role: "user",
				content: args.inputsSummary
					? `${args.userPrompt}\n\nUpstream inputs:\n${args.inputsSummary}`
					: args.userPrompt,
			},
		];

		const runInput: RunInput = {
			model: binding.model,
			messages,
			tools: registry,
			systemPrompt,
			temperature: this.temperature ?? binding.temperature ?? 0.2,
			maxTokens: binding.maxTokens,
			maxToolIterations: this.maxToolIterations,
			signal: args.ctx.signal,
		};

		let text = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let costUsd = 0;

		try {
			for await (const event of binding.provider.run(runInput)) {
				this.relayEvent(args.ctx, event);
				if (event.type === "assistant_text") text += event.text;
				if (event.type === "done" && event.usage) {
					inputTokens += event.usage.inputTokens ?? 0;
					outputTokens += event.usage.outputTokens ?? 0;
					costUsd += estimateCost(
						binding.model,
						event.usage.inputTokens ?? 0,
						event.usage.outputTokens ?? 0,
						this.priceTable,
					);
				}
				if (event.type === "error") {
					const retryAfterMs =
						event.error.code === "rate_limited"
							? event.error.retryAfterMs
							: undefined;
					return {
						ok: false,
						error: {
							code: event.error.code,
							message: event.error.message,
						},
						usage: { inputTokens, outputTokens, costUsd },
						transient:
							event.error.code === "rate_limited" ||
							event.error.code === "unreachable",
						retryAfterMs,
					};
				}
			}
		} catch (err) {
			return {
				ok: false,
				error: {
					code: "provider_threw",
					message: err instanceof Error ? err.message : String(err),
				},
				usage: { inputTokens, outputTokens, costUsd },
				transient: true,
			};
		}

		return {
			ok: true,
			value: {
				text,
				usage: { inputTokens, outputTokens, costUsd },
				captured: captured.value,
			},
		};
	}

	private allowedToolRegistry(
		ctx: NodeRunContext,
		node: PlanNode,
	): ToolRegistry {
		const policy = ctx.node.retryPolicy;
		void policy; // kept to document that we could rewire per-node retries
		return memoizeRegistry(
			this.baseTools,
			{
				nodeId: ctx.node.id,
				cache: ctx.cache,
				policy: this.defaultCachePolicy,
				emit: ctx.emit,
				now: this.now,
			},
			node.allowedTools,
		);
	}

	private relayEvent(ctx: NodeRunContext, event: ProviderEvent): void {
		switch (event.type) {
			case "assistant_text_delta":
				ctx.emit({
					type: "node_text_delta",
					at: this.now(),
					nodeId: ctx.node.id,
					text: event.text,
				});
				return;
			case "tool_call":
				ctx.emit({
					type: "node_tool_call",
					at: this.now(),
					nodeId: ctx.node.id,
					callId: event.call.id,
					tool: event.call.name,
					inputs: event.call.input,
					fromCache: false,
				});
				return;
			case "tool_result":
				ctx.emit({
					type: "node_tool_result",
					at: this.now(),
					nodeId: ctx.node.id,
					callId: event.id,
					// Best-effort: we don't know the tool name by id here; leave blank.
					tool: "",
					ok: event.result.ok,
					result: event.result.ok ? event.result.value : event.result.error,
					fromCache: false,
				});
				return;
			default:
				return;
		}
	}
}

// ---------------------------------------------------------------------------
// Capture tool — single-shot, stores input, returns ack.
// ---------------------------------------------------------------------------

class CaptureTool<T> extends Tool<T, string> {
	readonly id: string;
	readonly description: string;
	readonly schema: z.ZodType<T>;
	private readonly onCapture: (value: T) => void;

	constructor(opts: {
		id: string;
		description: string;
		schema: z.ZodType<T>;
		onCapture: (value: T) => void;
	}) {
		super();
		this.id = opts.id;
		this.description = opts.description;
		this.schema = opts.schema;
		this.onCapture = opts.onCapture;
	}

	async run(inputs: T): Promise<ToolResult<string>> {
		this.onCapture(inputs);
		return { ok: true, value: "captured" };
	}
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PHASE_SYSTEM_PROMPTS = {
	researchGather: `You are a research gatherer. Use tools surgically to answer the caller's questions. Prefer fewer, higher-signal calls. Output terse notes only — no preamble.`,
	researchConclude: `You are a research synthesizer. Turn the gathered notes into a compact, decision-ready output. Call submit_findings exactly once and stop.`,
	discoverGather: `You are a discovery probe. Use tools to surface unknowns and surprises relevant to the scope. Output terse notes only — no preamble.`,
	discoverConclude: `You are a discovery synthesizer. Summarize discoveries and suggest follow-up nodes. Call submit_discoveries exactly once and stop.`,
	decide: `You are a decision maker. You must pick exactly one option and justify it briefly. Call submit_decision with chosenOptionId set to one of the provided option ids.`,
	do: `You are an execution agent. Carry out the requested action using the tools available. Be idempotent where possible. Finalize by calling submit_action.`,
	verify: `You are a verification agent. Use tools to confirm or refute the check. Bias toward reporting failure when in doubt. Finalize by calling submit_verification.`,
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function summarizeInputs(inputs: Record<string, unknown>): string {
	const keys = Object.keys(inputs);
	if (keys.length === 0) return "";
	return keys
		.map((k) => `- ${k}: ${truncate(JSON.stringify(inputs[k]), 600)}`)
		.join("\n");
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}… (truncated ${s.length - n} chars)`;
}

function zeroUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		costUsd: a.costUsd + b.costUsd,
	};
}

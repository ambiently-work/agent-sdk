import { z } from "zod";

export const Impact = z.enum(["local", "branch", "plan", "system"]);
export type Impact = z.infer<typeof Impact>;

export const Reversibility = z.enum([
	"trivial",
	"cheap",
	"expensive",
	"irreversible",
]);
export type Reversibility = z.infer<typeof Reversibility>;

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const SeverityGrade = z.object({
	impact: Impact,
	reversibility: Reversibility,
	grade: Severity,
	rationale: z.string(),
});
export type SeverityGrade = z.infer<typeof SeverityGrade>;

/**
 * 4x4 impact × reversibility → severity. Indexed as `matrix[impact][reversibility]`.
 * Integrators can override per plan via `PlanConfig.severityMatrix`.
 */
export type SeverityMatrix = Record<Impact, Record<Reversibility, Severity>>;

export const DEFAULT_SEVERITY_MATRIX: SeverityMatrix = {
	local: {
		trivial: "low",
		cheap: "low",
		expensive: "medium",
		irreversible: "high",
	},
	branch: {
		trivial: "low",
		cheap: "medium",
		expensive: "high",
		irreversible: "high",
	},
	plan: {
		trivial: "medium",
		cheap: "medium",
		expensive: "high",
		irreversible: "critical",
	},
	system: {
		trivial: "medium",
		cheap: "high",
		expensive: "critical",
		irreversible: "critical",
	},
};

export const SeverityMatrixSchema = z.record(
	Impact,
	z.record(Reversibility, Severity),
) as z.ZodType<SeverityMatrix>;

export function gradeSeverity(
	impact: Impact,
	reversibility: Reversibility,
	matrix: SeverityMatrix = DEFAULT_SEVERITY_MATRIX,
): Severity {
	return matrix[impact][reversibility];
}

const SEVERITY_ORDER: Record<Severity, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

export function severityAtLeast(a: Severity, b: Severity): boolean {
	return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b];
}

export const ApprovalPolicy = z.object({
	/** Severities at or above this level require human approval. */
	threshold: Severity.default("high"),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

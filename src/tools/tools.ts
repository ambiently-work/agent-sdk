import { z } from "zod";

export type Result<T, E = Error> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export type ToolError =
	| { code: "unknown_tool"; message: string }
	| { code: "duplicate_tool"; message: string }
	| { code: "invalid_input"; message: string; issues: z.core.$ZodIssue[] }
	| { code: "tool_failed"; message: string; cause?: unknown }
	| { code: "sandbox_compile_failed"; message: string }
	| { code: "sandbox_load_failed"; message: string }
	| { code: "sandbox_runtime_error"; message: string; stack?: string }
	| { code: "sandbox_timeout"; message: string; timeoutMs: number }
	| { code: "sandbox_memory_exceeded"; message: string; limitBytes: number }
	| { code: "sandbox_capability_denied"; message: string; capability: string };

export type ToolResult<T> = Result<T, ToolError>;

export interface ToolCall {
	tool: string;
	inputs: Record<string, unknown>;
}

export abstract class Tool<I = unknown, O = unknown> {
	abstract readonly id: string;
	abstract readonly description: string;
	abstract readonly schema: z.ZodType<I>;

	abstract run(inputs: I): Promise<ToolResult<O>>;

	parse(inputs: Record<string, unknown>): ToolResult<I> {
		const result = this.schema.safeParse(inputs);
		if (result.success) return { ok: true, value: result.data };
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: z.prettifyError(result.error),
				issues: result.error.issues,
			},
		};
	}
}

export class ToolRegistry {
	private readonly tools = new Map<string, Tool>();

	constructor(tools: Tool[] = []) {
		for (const tool of tools) this.register(tool);
	}

	register(tool: Tool): ToolResult<Tool> {
		if (this.tools.has(tool.id)) {
			return {
				ok: false,
				error: {
					code: "duplicate_tool",
					message: `Tool "${tool.id}" is already registered`,
				},
			};
		}
		this.tools.set(tool.id, tool);
		return { ok: true, value: tool };
	}

	get(id: string): Tool | undefined {
		return this.tools.get(id);
	}

	list(): Tool[] {
		return [...this.tools.values()];
	}

	async run(call: ToolCall): Promise<ToolResult<unknown>> {
		const tool = this.tools.get(call.tool);
		if (!tool) {
			return {
				ok: false,
				error: {
					code: "unknown_tool",
					message: `Unknown tool "${call.tool}"`,
				},
			};
		}

		const parsed = tool.parse(call.inputs);
		if (!parsed.ok) return parsed;
		return await tool.run(parsed.value);
	}
}

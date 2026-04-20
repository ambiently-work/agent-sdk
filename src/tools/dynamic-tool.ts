import { z } from "zod";
import { Sandbox, type SandboxCreateOptions } from "../sandbox";
import type { ToolMeta } from "../sandbox/types";
import { Tool, type ToolResult } from "./tools";

export type DynamicToolOptions = SandboxCreateOptions;

export class DynamicTool extends Tool<unknown, unknown> {
	readonly id: string;
	readonly description: string;
	readonly schema: z.ZodType<unknown>;
	readonly jsonSchema: unknown;

	private constructor(
		private readonly sandbox: Sandbox,
		meta: ToolMeta,
	) {
		super();
		this.id = meta.id;
		this.description = meta.description;
		this.jsonSchema = meta.jsonSchema;
		this.schema = z.unknown();
	}

	static async fromSource(
		jsSource: string,
		options: DynamicToolOptions = {},
	): Promise<ToolResult<DynamicTool>> {
		const sandbox = await Sandbox.create(options);
		const meta = await sandbox.load(jsSource);
		if (!meta.ok) {
			await sandbox.dispose();
			return meta;
		}
		return { ok: true, value: new DynamicTool(sandbox, meta.value) };
	}

	override parse(inputs: Record<string, unknown>): ToolResult<unknown> {
		return { ok: true, value: inputs };
	}

	async run(inputs: unknown): Promise<ToolResult<unknown>> {
		return await this.sandbox.invoke(inputs);
	}

	async dispose(): Promise<void> {
		await this.sandbox.dispose();
	}
}

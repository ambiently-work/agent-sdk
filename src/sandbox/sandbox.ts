import type { ToolResult } from "@ambiently-work/faux";
import { type BackendSelectionOptions, selectBackend } from "./backend/select";
import { loadResponseSchema } from "./protocol/wire";
import type {
	SandboxBackend,
	SandboxInstance,
	SandboxOptions,
	ToolMeta,
} from "./types";

export interface SandboxCreateOptions
	extends SandboxOptions,
		BackendSelectionOptions {
	backend?: SandboxBackend;
}

export class Sandbox {
	private constructor(private readonly instance: SandboxInstance) {}

	static async create(opts: SandboxCreateOptions = {}): Promise<Sandbox> {
		const backend =
			opts.backend ??
			(await selectBackend({
				loader: opts.loader,
				hostFetcher: opts.hostFetcher,
				prefer: opts.prefer,
			}));
		const instance = await backend.create({
			timeoutMs: opts.timeoutMs,
			memoryBytes: opts.memoryBytes,
			maxStackBytes: opts.maxStackBytes,
			capabilities: opts.capabilities,
		});
		return new Sandbox(instance);
	}

	async load(jsSource: string): Promise<ToolResult<ToolMeta>> {
		const loaded = await this.instance.load(jsSource);
		if (!loaded.ok) return loaded;
		const meta = await this.instance.callJson("__loadTool");
		if (!meta.ok) return meta;
		const parsed = loadResponseSchema.safeParse(meta.value);
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					code: "sandbox_load_failed",
					message: `tool meta did not match expected shape: ${parsed.error.message}`,
				},
			};
		}
		return { ok: true, value: parsed.data as ToolMeta };
	}

	async invoke(inputs: unknown): Promise<ToolResult<unknown>> {
		const result = await this.instance.callJson(
			"__runTool",
			JSON.stringify(inputs),
		);
		if (!result.ok) return result;
		const inner = result.value;
		if (
			!inner ||
			typeof inner !== "object" ||
			typeof (inner as { ok?: unknown }).ok !== "boolean"
		) {
			return {
				ok: false,
				error: {
					code: "sandbox_runtime_error",
					message: "guest did not return a Result-shaped value",
				},
			};
		}
		return inner as ToolResult<unknown>;
	}

	async dispose(): Promise<void> {
		await this.instance.dispose();
	}
}

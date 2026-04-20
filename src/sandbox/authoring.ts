import type { ToolResult } from "../tools/tools";
import { Sandbox, type SandboxCreateOptions } from "./sandbox";
import { transpileTs } from "./transpile";
import type { ToolMeta } from "./types";

export interface CompileToolResult {
	js: string;
	meta: ToolMeta;
}

export interface CompileToolOptions extends SandboxCreateOptions {
	tsLoader?: "ts" | "tsx";
}

export async function compileTool(
	tsSource: string,
	options: CompileToolOptions = {},
): Promise<ToolResult<CompileToolResult>> {
	let js: string;
	try {
		js = transpileTs(tsSource, options.tsLoader ?? "ts");
	} catch (e) {
		return {
			ok: false,
			error: {
				code: "sandbox_compile_failed",
				message: e instanceof Error ? e.message : String(e),
			},
		};
	}
	const sandbox = await Sandbox.create(options);
	try {
		const meta = await sandbox.load(js);
		if (!meta.ok) return meta;
		return { ok: true, value: { js, meta: meta.value } };
	} finally {
		await sandbox.dispose();
	}
}

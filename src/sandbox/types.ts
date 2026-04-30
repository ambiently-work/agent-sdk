import type { ToolResult } from "@ambiently-work/faux";

export interface ToolMeta {
	id: string;
	description: string;
	jsonSchema: unknown;
}

export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>;

export interface Capability {
	name: string;
	functions: Record<string, HostFn>;
	dispose?(): void | Promise<void>;
}

export interface SandboxOptions {
	timeoutMs?: number;
	memoryBytes?: number;
	maxStackBytes?: number;
	capabilities?: Capability[];
	/**
	 * Workerd backend only. Directory under which miniflare/workerd should
	 * place their temp files and AF_UNIX sockets. POSIX `sun_path` is capped
	 * at 108 bytes; if the resolved path is too long, workerd dies on
	 * bootstrap with "Broken pipe; fd = 3" / `connect ENOENT`. Defaults to
	 * `$MINIFLARE_TMPDIR` if set, otherwise `/tmp` on POSIX (short and safe).
	 */
	tmpDir?: string;
}

export interface SandboxInstance {
	load(js: string): Promise<ToolResult<void>>;
	callJson(fn: string, arg?: unknown): Promise<ToolResult<unknown>>;
	dispose(): Promise<void>;
}

export interface SandboxBackend {
	create(opts: SandboxOptions): Promise<SandboxInstance>;
}

export const DEFAULTS = {
	timeoutMs: 5_000,
	memoryBytes: 32 * 1024 * 1024,
	maxStackBytes: 1024 * 1024,
} as const;

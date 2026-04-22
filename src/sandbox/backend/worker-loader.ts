import type { ToolError, ToolResult } from "@ambiently-work/faux";
import { buildRemoteGuestModule } from "../protocol/remote-guest";
import {
	dispatchHostInvoke,
	flattenCapabilities,
} from "../protocol/remote-host";
import {
	type Capability,
	DEFAULTS,
	type SandboxBackend,
	type SandboxInstance,
	type SandboxOptions,
} from "../types";

export interface WorkerCode {
	compatibilityDate: string;
	mainModule: string;
	modules: Record<string, string>;
	env?: Record<string, unknown>;
	globalOutbound?: unknown;
}

export interface WorkerStub {
	getEntrypoint(): Fetcher;
}

export interface Fetcher {
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface WorkerLoaderBinding {
	load(code: WorkerCode): WorkerStub;
	get(id: string, getCode: () => Promise<WorkerCode> | WorkerCode): WorkerStub;
}

export type HostFetcherFactory = (
	dispatch: (request: Request) => Promise<Response>,
) => Fetcher;

export interface WorkerLoaderBackendOptions {
	loader: WorkerLoaderBinding;
	hostFetcher: HostFetcherFactory;
	compatibilityDate?: string;
}

const DEFAULT_COMPAT_DATE = "2026-01-01";

export class WorkerLoaderBackend implements SandboxBackend {
	constructor(private readonly opts: WorkerLoaderBackendOptions) {}

	async create(opts: SandboxOptions = {}): Promise<SandboxInstance> {
		return new WorkerLoaderInstance(this.opts, opts);
	}
}

class WorkerLoaderInstance implements SandboxInstance {
	private worker: WorkerStub | null = null;
	private disposed = false;
	private readonly capabilities: Capability[];
	private readonly timeoutMs: number;

	constructor(
		private readonly backendOpts: WorkerLoaderBackendOptions,
		opts: SandboxOptions,
	) {
		this.capabilities = opts.capabilities ?? [];
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
	}

	async load(jsSource: string): Promise<ToolResult<void>> {
		if (this.disposed) {
			return {
				ok: false,
				error: {
					code: "sandbox_load_failed",
					message: "sandbox already disposed",
				},
			};
		}
		const built = buildRemoteGuestModule(jsSource);
		const handlers = flattenCapabilities(this.capabilities);
		const hostFetcher = this.backendOpts.hostFetcher((request) =>
			dispatchHostInvoke(request, handlers),
		);
		try {
			this.worker = this.backendOpts.loader.load({
				compatibilityDate:
					this.backendOpts.compatibilityDate ?? DEFAULT_COMPAT_DATE,
				mainModule: built.mainModule,
				modules: built.modules,
				env: { HOST: hostFetcher },
				globalOutbound: null,
			});
			return { ok: true, value: undefined };
		} catch (e) {
			return {
				ok: false,
				error: this.classifyThrown(e, "sandbox_load_failed"),
			};
		}
	}

	async callJson(fn: string, arg?: unknown): Promise<ToolResult<unknown>> {
		if (!this.worker) {
			return {
				ok: false,
				error: { code: "sandbox_load_failed", message: "sandbox not loaded" },
			};
		}
		const path =
			fn === "__loadTool"
				? "/loadTool"
				: fn === "__runTool"
					? "/runTool"
					: null;
		if (!path) {
			return {
				ok: false,
				error: {
					code: "sandbox_runtime_error",
					message: `unknown guest function "${fn}"`,
				},
			};
		}
		const init: RequestInit | undefined =
			fn === "__runTool"
				? {
						method: "POST",
						body: typeof arg === "string" ? arg : JSON.stringify(arg),
					}
				: undefined;
		try {
			const entrypoint = this.worker.getEntrypoint();
			const response = await this.withTimeout(
				entrypoint.fetch(`http://_${path}`, init),
			);
			if (!response.ok) {
				const body = await response.text();
				return {
					ok: false,
					error: {
						code: "sandbox_runtime_error",
						message: `guest returned ${response.status}: ${body.slice(0, 200)}`,
					},
				};
			}
			const text = await response.text();
			try {
				return { ok: true, value: JSON.parse(text) };
			} catch (e) {
				return {
					ok: false,
					error: {
						code: "sandbox_runtime_error",
						message: `guest returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
					},
				};
			}
		} catch (e) {
			return {
				ok: false,
				error: this.classifyThrown(e, "sandbox_runtime_error"),
			};
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.worker = null;
		for (const cap of this.capabilities) {
			try {
				await cap.dispose?.();
			} catch {}
		}
	}

	private withTimeout<T>(promise: Promise<T>): Promise<T> {
		const timeout = this.timeoutMs;
		return new Promise<T>((resolve, reject) => {
			const id = setTimeout(() => {
				const e = new Error(`sandbox call exceeded timeout of ${timeout}ms`);
				e.name = "SandboxTimeout";
				reject(e);
			}, timeout);
			promise.then(
				(v) => {
					clearTimeout(id);
					resolve(v);
				},
				(e) => {
					clearTimeout(id);
					reject(e);
				},
			);
		});
	}

	private classifyThrown(
		e: unknown,
		defaultCode: ToolError["code"],
	): ToolError {
		const message = e instanceof Error ? e.message : String(e);
		const name = e instanceof Error ? e.name : "Error";
		if (name === "SandboxTimeout") {
			return {
				code: "sandbox_timeout",
				message,
				timeoutMs: this.timeoutMs,
			};
		}
		return { code: defaultCode, message } as ToolError;
	}
}

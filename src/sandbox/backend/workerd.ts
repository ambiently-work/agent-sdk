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

interface MiniflareResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

interface MiniflareLike {
	dispatchFetch(url: string, init?: unknown): Promise<MiniflareResponseLike>;
	dispose(): Promise<void>;
}

interface MiniflareCtor {
	new (opts: unknown): MiniflareLike;
}

let miniflareCtor: MiniflareCtor | null | undefined;
async function loadMiniflare(): Promise<MiniflareCtor> {
	if (miniflareCtor) return miniflareCtor;
	if (miniflareCtor === null) {
		throw new Error(
			"miniflare is not installed — run `bun add miniflare` to use WorkerdBackend",
		);
	}
	try {
		const mod = (await import("miniflare")) as unknown as {
			Miniflare: MiniflareCtor;
		};
		miniflareCtor = mod.Miniflare;
		return miniflareCtor;
	} catch (e) {
		miniflareCtor = null;
		throw new Error(
			`miniflare import failed: ${e instanceof Error ? e.message : String(e)} — install miniflare to use WorkerdBackend`,
		);
	}
}

export class WorkerdBackend implements SandboxBackend {
	async create(opts: SandboxOptions = {}): Promise<SandboxInstance> {
		const Miniflare = await loadMiniflare();
		return new WorkerdInstance(Miniflare, opts);
	}
}

class WorkerdInstance implements SandboxInstance {
	private mf: MiniflareLike | null = null;
	private disposed = false;
	private readonly capabilities: Capability[];
	private readonly timeoutMs: number;

	constructor(
		private readonly Miniflare: MiniflareCtor,
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
		try {
			this.mf = new this.Miniflare({
				modules: true,
				compatibilityDate: "2026-01-01",
				compatibilityFlags: ["nodejs_compat"],
				script: built.modules[built.mainModule],
				modulesRoot: "/",
				serviceBindings: {
					HOST: async (request: Request) =>
						dispatchHostInvoke(request, handlers),
				},
			});
			// dispatchFetch lazily starts the runtime; do a no-op probe so failures surface here
			const probe = await this.fetchPath("/loadTool");
			if (!probe.ok) {
				const text = await probe.text();
				return {
					ok: false,
					error: {
						code: "sandbox_load_failed",
						message: `guest worker failed to start: ${probe.status} ${text}`,
					},
				};
			}
			return { ok: true, value: undefined };
		} catch (e) {
			return {
				ok: false,
				error: this.classifyThrown(e, "sandbox_load_failed"),
			};
		}
	}

	async callJson(fn: string, arg?: unknown): Promise<ToolResult<unknown>> {
		if (!this.mf) {
			return {
				ok: false,
				error: { code: "sandbox_load_failed", message: "sandbox not loaded" },
			};
		}
		try {
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
			const response = await this.withTimeout(this.fetchPath(path, init));
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
		if (this.mf) {
			try {
				await this.mf.dispose();
			} catch {}
			this.mf = null;
		}
		for (const cap of this.capabilities) {
			try {
				await cap.dispose?.();
			} catch {}
		}
	}

	private async fetchPath(
		path: string,
		init?: RequestInit,
	): Promise<MiniflareResponseLike> {
		if (!this.mf) throw new Error("sandbox not initialized");
		return await this.mf.dispatchFetch(`http://workerd${path}`, init);
	}

	private withTimeout<T>(promise: Promise<T>): Promise<T> {
		const timeout = this.timeoutMs;
		return new Promise<T>((resolve, reject) => {
			const id = setTimeout(() => {
				reject(makeTimeoutError(timeout));
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

function makeTimeoutError(timeoutMs: number): Error {
	const e = new Error(`sandbox call exceeded timeout of ${timeoutMs}ms`);
	e.name = "SandboxTimeout";
	return e;
}

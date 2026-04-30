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

// Miniflare derives its tmp path from `os.tmpdir()` at constructor time
// (`path.join(os.tmpdir(), "miniflare-<32hex>")`) and workerd creates
// AF_UNIX sockets *inside* that directory for plugin IPC. POSIX caps
// `sun_path` at 108 bytes — once the parent path is long enough, workerd
// can't bind and exits with "Broken pipe; fd = 3" / `connect ENOENT`.
//
// Real-world long-path sources we hit:
//   - macOS: `os.tmpdir()` → `/var/folders/<hash>/T` (~49 chars)
//   - GitHub-hosted runners: `/home/runner/work/<repo>/<repo>/...`
//
// Mitigation: scope `process.env.TMPDIR` to a short path *just* for the
// synchronous `new Miniflare(...)` call, so `os.tmpdir()` resolves to it.
// See issue #26 for the full reproduction.
function resolveShortTmpdir(explicit?: string): string | null {
	if (explicit) return explicit;
	const fromEnv = process.env.MINIFLARE_TMPDIR;
	if (fromEnv) return fromEnv;
	if (process.platform === "win32") return null;
	return "/tmp";
}

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
	private readonly shortTmpdir: string | null;

	constructor(
		private readonly Miniflare: MiniflareCtor,
		opts: SandboxOptions,
	) {
		this.capabilities = opts.capabilities ?? [];
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
		this.shortTmpdir = resolveShortTmpdir(opts.tmpDir);
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
		// `child_process.spawn()` inside Bun has been observed to fail with a
		// transient `connect ENOENT` while wiring up stdio for back-to-back
		// workerd spawns under heavy test pressure. The error originates in
		// Bun's internal IPC plumbing, *before* workerd even runs, so a small
		// retry is safe and keeps the suite deterministic. See issue #26.
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				this.mf = this.constructMiniflare({
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
					await this.disposeMiniflare();
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
				lastError = e;
				await this.disposeMiniflare();
				if (!isTransientSpawnError(e) || attempt === 2) break;
				await sleep(100 * 2 ** attempt);
			}
		}
		return {
			ok: false,
			error: this.classifyThrown(lastError, "sandbox_load_failed"),
		};
	}

	private constructMiniflare(opts: unknown): MiniflareLike {
		// `os.tmpdir()` is read synchronously inside the Miniflare constructor,
		// so a brief env scope is enough — no race even with concurrent creates.
		const prev = process.env.TMPDIR;
		if (this.shortTmpdir !== null) {
			process.env.TMPDIR = this.shortTmpdir;
		}
		try {
			return new this.Miniflare(opts);
		} finally {
			if (this.shortTmpdir !== null) {
				if (prev === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = prev;
			}
		}
	}

	private async disposeMiniflare(): Promise<void> {
		if (!this.mf) return;
		try {
			await this.mf.dispose();
		} catch {}
		this.mf = null;
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
		await this.disposeMiniflare();
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

function isTransientSpawnError(e: unknown): boolean {
	if (!e) return false;
	const message = e instanceof Error ? e.message : String(e);
	const code = (e as { code?: unknown }).code;
	const syscall = (e as { syscall?: unknown }).syscall;
	// Bun's child_process.spawn wires stdio via internal sockets; under heavy
	// load the connect() to that socket can transiently fail with ENOENT.
	if (code === "ENOENT" && syscall === "connect") return true;
	if (/Failed to connect/.test(message) && /ENOENT/.test(message)) return true;
	// Defensive: workerd's "Broken pipe; fd = 3" is the symptom of the same
	// race when the spawn *did* succeed but the stdio side died early.
	if (/Broken pipe.*fd = 3/.test(message)) return true;
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

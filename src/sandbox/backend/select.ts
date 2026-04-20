import type { SandboxBackend } from "../types";
import type { HostFetcherFactory, WorkerLoaderBinding } from "./worker-loader";

export interface BackendSelectionOptions {
	loader?: WorkerLoaderBinding;
	hostFetcher?: HostFetcherFactory;
	prefer?: "workerd" | "worker-loader" | "auto";
}

export async function selectBackend(
	opts: BackendSelectionOptions = {},
): Promise<SandboxBackend> {
	const choice = opts.prefer ?? "auto";

	if (
		choice === "worker-loader" ||
		(choice === "auto" && opts.loader && opts.hostFetcher)
	) {
		if (!opts.loader || !opts.hostFetcher) {
			throw new Error(
				"worker-loader backend requires both `loader` (env.LOADER) and `hostFetcher`",
			);
		}
		const { WorkerLoaderBackend } = await import("./worker-loader");
		return new WorkerLoaderBackend({
			loader: opts.loader,
			hostFetcher: opts.hostFetcher,
		});
	}

	const { WorkerdBackend } = await import("./workerd");
	return new WorkerdBackend();
}

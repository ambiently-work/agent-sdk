import type { Fetcher } from "./worker-loader";

type DispatchFn = (request: Request) => Promise<Response>;

const REGISTRY = new Map<string, DispatchFn>();
let nextId = 0;

interface CtxLike {
	exports: Record<
		string,
		(opts: { props: { __sandboxId: string } }) => Fetcher
	>;
}

export function makeHostFetcher(
	ctx: CtxLike,
	entrypointName: string,
	dispatch: DispatchFn,
): Fetcher {
	const id = `__amb_${nextId++}`;
	REGISTRY.set(id, dispatch);
	const factory = ctx.exports[entrypointName];
	if (!factory) {
		REGISTRY.delete(id);
		throw new Error(
			`ctx.exports.${entrypointName} not found — make sure your Worker module exports the AmbientHostEntrypoint class`,
		);
	}
	return factory({ props: { __sandboxId: id } });
}

export function releaseHostFetcher(id: string): void {
	REGISTRY.delete(id);
}

interface WorkerEntrypointBase {
	new (
		...args: unknown[]
	): {
		ctx: { props?: { __sandboxId?: string } };
		fetch(request: Request): Promise<Response>;
	};
}

export function createAmbientHostEntrypoint(
	WorkerEntrypoint: WorkerEntrypointBase,
): WorkerEntrypointBase {
	return class AmbientHostEntrypoint extends WorkerEntrypoint {
		override async fetch(request: Request): Promise<Response> {
			const id = this.ctx.props?.__sandboxId;
			if (!id) {
				return new Response("missing __sandboxId in props", { status: 400 });
			}
			const dispatch = REGISTRY.get(id);
			if (!dispatch) {
				return Response.json({
					error: {
						name: "Error",
						message: `host fetcher ${id} is no longer registered`,
					},
				});
			}
			return dispatch(request);
		}
	} as unknown as WorkerEntrypointBase;
}

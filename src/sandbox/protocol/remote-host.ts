import type { Capability, HostFn } from "../types";

export function flattenCapabilities(
	capabilities: Capability[],
): Record<string, HostFn> {
	const out: Record<string, HostFn> = {};
	for (const cap of capabilities) {
		for (const [name, fn] of Object.entries(cap.functions)) {
			out[name] = fn;
		}
	}
	return out;
}

export interface InvokePayload {
	fn: string;
	args: unknown[];
}

export interface InvokeResponse {
	value?: unknown;
	error?: { name: string; message: string };
}

export async function dispatchHostInvoke(
	request: Request,
	handlers: Record<string, HostFn>,
): Promise<Response> {
	let payload: InvokePayload;
	try {
		payload = (await request.json()) as InvokePayload;
	} catch (e) {
		return Response.json({
			error: {
				name: "HostProtocolError",
				message: `invalid invoke payload: ${e instanceof Error ? e.message : String(e)}`,
			},
		});
	}
	const handler = handlers[payload.fn];
	if (!handler) {
		return Response.json({
			error: {
				name: "FetchDeniedError",
				message: `capability "${payload.fn}" is not available`,
			},
		});
	}
	try {
		const value = await handler(...(payload.args ?? []));
		return Response.json({ value: value ?? null });
	} catch (e) {
		const error =
			e instanceof Error
				? { name: e.name || "Error", message: e.message }
				: { name: "Error", message: String(e) };
		return Response.json({ error });
	}
}

import type { Capability } from "../types";

export type FetchImpl = (
	url: URL | string,
	init?: RequestInit,
) => Promise<Response>;

export interface FetchCapabilityOptions {
	allow: (url: URL) => boolean;
	timeoutMs?: number;
	maxResponseBytes?: number;
	fetchImpl?: FetchImpl;
}

export interface GuestFetchResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_BYTES = 1 << 20;

export class FetchDeniedError extends Error {
	readonly capability = "fetch";
	constructor(public readonly attemptedUrl: string) {
		super(`fetch to "${attemptedUrl}" is not allowed`);
		this.name = "FetchDeniedError";
	}
}

export class FetchOversizeError extends Error {
	readonly capability = "fetch";
	constructor(public readonly limit: number) {
		super(`response body exceeded ${limit} bytes`);
		this.name = "FetchOversizeError";
	}
}

export function fetchCapability(opts: FetchCapabilityOptions): Capability {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
	const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;
	const impl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));

	const fetchFn = async (...args: unknown[]): Promise<GuestFetchResponse> => {
		const [rawUrl, init] = args as [string, RequestInit | undefined];
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new FetchDeniedError(String(rawUrl));
		}
		if (!opts.allow(url)) throw new FetchDeniedError(url.toString());

		const response = await impl(url, {
			method: init?.method ?? "GET",
			headers: init?.headers,
			body: init?.body,
			signal: AbortSignal.timeout(timeoutMs),
		});

		const reader = response.body?.getReader();
		let body = "";
		let received = 0;
		if (reader) {
			const decoder = new TextDecoder();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel().catch(() => {});
					throw new FetchOversizeError(maxBytes);
				}
				body += decoder.decode(value, { stream: true });
			}
			body += decoder.decode();
		}

		const headers: Record<string, string> = {};
		response.headers.forEach((v, k) => {
			headers[k] = v;
		});

		return {
			status: response.status,
			statusText: response.statusText,
			headers,
			body,
		};
	};

	return {
		name: "fetch",
		functions: { fetch: fetchFn },
	};
}

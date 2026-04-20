import { describe, expect, test } from "bun:test";
import { WorkerdBackend } from "../backend/workerd";
import { fetchCapability, logCapability } from "./index";

const backend = new WorkerdBackend();

describe("logCapability", () => {
	test("forwards calls from guest to sink", async () => {
		const events: Array<{ level: string; message: string }> = [];
		const sandbox = await backend.create({
			capabilities: [
				logCapability({
					sink: (level, message) => events.push({ level, message }),
				}),
			],
		});
		try {
			const loaded = await sandbox.load(`
				defineTool({
					id: "logger",
					description: "Logs",
					schema: z.object({}),
					async run() {
						await host.log("hello", { id: 1 });
						await host.warn("careful");
						await host.error("boom");
						return { ok: true, value: null };
					},
				});
			`);
			expect(loaded.ok).toBe(true);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result).toEqual({
				ok: true,
				value: { ok: true, value: null },
			});
			expect(events).toEqual([
				{ level: "log", message: 'hello {"id":1}' },
				{ level: "warn", message: "careful" },
				{ level: "error", message: "boom" },
			]);
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);
});

describe("fetchCapability", () => {
	test("allows requests matching the allowlist and returns response", async () => {
		const fakeFetch = async (input: URL | string) => {
			const url = typeof input === "string" ? input : input.toString();
			return new Response(`fetched ${url}`, {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/plain" },
			});
		};
		const sandbox = await backend.create({
			capabilities: [
				fetchCapability({
					allow: (u) => u.host === "example.com",
					fetchImpl: fakeFetch,
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fetcher",
					description: "Fetches",
					schema: z.object({}),
					async run() {
						const res = await host.fetch("https://example.com/data");
						return { ok: true, value: { status: res.status, body: res.body } };
					},
				});
			`);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result).toEqual({
				ok: true,
				value: {
					ok: true,
					value: { status: 200, body: "fetched https://example.com/data" },
				},
			});
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("denies requests outside the allowlist with sandbox_capability_denied", async () => {
		const sandbox = await backend.create({
			capabilities: [
				fetchCapability({
					allow: (u) => u.host === "allowed.example",
					fetchImpl: async () => new Response("nope"),
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fetcher",
					description: "Fetches",
					schema: z.object({}),
					async run() {
						const res = await host.fetch("https://blocked.example/secret");
						return { ok: true, value: res.body };
					},
				});
			`);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					error?: { code: string; capability?: string };
				};
				expect(inner.ok).toBe(false);
				expect(inner.error?.code).toBe("sandbox_capability_denied");
				expect(inner.error?.capability).toBe("fetch");
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("rejects oversized response bodies", async () => {
		const big = new Uint8Array(2048).fill(65);
		const fakeFetch = async () => new Response(big, { status: 200 });
		const sandbox = await backend.create({
			capabilities: [
				fetchCapability({
					allow: () => true,
					maxResponseBytes: 1024,
					fetchImpl: fakeFetch,
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fetcher",
					description: "Fetches",
					schema: z.object({}),
					async run() {
						try {
							const r = await host.fetch("https://x.example/");
							return { ok: true, value: { len: r.body.length } };
						} catch (e) {
							return { ok: false, error: { code: "tool_failed", message: e.message } };
						}
					},
				});
			`);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					error?: { code: string; message: string };
				};
				expect(inner.ok).toBe(false);
				expect(inner.error?.code).toBe("tool_failed");
				expect(inner.error?.message).toMatch(/exceeded 1024 bytes/);
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);
});

import { describe, expect, test } from "bun:test";
import { fetchCapability, logCapability } from "../capabilities";
import { WorkerdBackend } from "./workerd";

const echoSource = `
defineTool({
  id: "echo",
  description: "Echoes a message",
  schema: z.object({ message: z.string() }),
  async run({ message }) {
    return { ok: true, value: message };
  },
});
`;

describe("WorkerdBackend", () => {
	test("loads, exposes meta, and runs the tool", async () => {
		const backend = new WorkerdBackend();
		const sandbox = await backend.create({});
		try {
			const loaded = await sandbox.load(echoSource);
			expect(loaded.ok).toBe(true);

			const meta = await sandbox.callJson("__loadTool");
			expect(meta.ok).toBe(true);
			if (meta.ok) {
				const m = meta.value as { id: string; description: string };
				expect(m.id).toBe("echo");
				expect(m.description).toBe("Echoes a message");
			}

			const result = await sandbox.callJson(
				"__runTool",
				JSON.stringify({ message: "hi" }),
			);
			expect(result).toEqual({ ok: true, value: { ok: true, value: "hi" } });
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("forwards log capability calls back to host", async () => {
		const events: Array<{ level: string; message: string }> = [];
		const backend = new WorkerdBackend();
		const sandbox = await backend.create({
			capabilities: [
				logCapability({
					sink: (level, message) => events.push({ level, message }),
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "logger",
					description: "Logs",
					schema: z.object({}),
					async run() {
						await host.log("hello", { id: 1 });
						await host.warn("careful");
						return { ok: true, value: null };
					},
				});
			`);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result).toEqual({ ok: true, value: { ok: true, value: null } });
			expect(events).toEqual([
				{ level: "log", message: 'hello {"id":1}' },
				{ level: "warn", message: "careful" },
			]);
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("uses fetch capability with allowlist", async () => {
		const fakeFetch = async (input: URL | string) =>
			new Response(`fetched ${input.toString()}`, { status: 200 });
		const backend = new WorkerdBackend();
		const sandbox = await backend.create({
			capabilities: [
				fetchCapability({
					allow: (u) => u.host === "api.example.com",
					fetchImpl: fakeFetch,
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fetcher",
					description: "Fetches",
					schema: z.object({ city: z.string() }),
					async run({ city }) {
						const res = await host.fetch("https://api.example.com/?city=" + city);
						return { ok: true, value: { status: res.status, body: res.body } };
					},
				});
			`);
			const result = await sandbox.callJson(
				"__runTool",
				JSON.stringify({ city: "Amsterdam" }),
			);
			expect(result).toEqual({
				ok: true,
				value: {
					ok: true,
					value: {
						status: 200,
						body: "fetched https://api.example.com/?city=Amsterdam",
					},
				},
			});
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);
});

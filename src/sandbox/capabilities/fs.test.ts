import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "@ambiently-work/vfs";
import { WorkerdBackend } from "../backend/workerd";
import { fsCapability } from "./fs";

const backend = new WorkerdBackend();

describe("fsCapability", () => {
	test("exposes read/write to guest tools", async () => {
		const fs = new VirtualFileSystem({
			files: { "/workspace/a.txt": "hello" },
		});
		const sandbox = await backend.create({
			capabilities: [fsCapability({ fs })],
		});
		try {
			const loaded = await sandbox.load(`
				defineTool({
					id: "fs-demo",
					description: "reads and writes files",
					schema: z.object({}),
					async run() {
						const before = await host.readFile("/workspace/a.txt");
						await host.writeFile("/workspace/b.txt", before + " world");
						const after = await host.readFile("/workspace/b.txt");
						return { ok: true, value: { before, after } };
					},
				});
			`);
			expect(loaded.ok).toBe(true);

			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					value: { before: string; after: string };
				};
				expect(inner.ok).toBe(true);
				expect(inner.value.before).toBe("hello");
				expect(inner.value.after).toBe("hello world");
			}
			// Host-side should see the guest's write
			expect(fs.readFile("/workspace/b.txt")).toBe("hello world");
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("denies ops blocked by the allow predicate", async () => {
		const fs = new VirtualFileSystem({ files: { "/etc/secrets": "shh" } });
		const sandbox = await backend.create({
			capabilities: [
				fsCapability({
					fs,
					allow: (_op, path) => path.startsWith("/workspace"),
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fs-denied",
					description: "tries to read outside workspace",
					schema: z.object({}),
					async run() {
						const r = await host.readFile("/etc/secrets");
						return { ok: true, value: r };
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
				expect(inner.error?.capability).toBe("fs");
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("stat returns a plain-object shape suitable for the JSON boundary", async () => {
		const fs = new VirtualFileSystem({ files: { "/a.txt": "hello" } });
		fs.chmod("/a.txt", 0o644);
		const sandbox = await backend.create({
			capabilities: [fsCapability({ fs })],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "fs-stat",
					description: "stats a file",
					schema: z.object({}),
					async run() {
						const s = await host.stat("/a.txt");
						return { ok: true, value: s };
					},
				});
			`);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					value: { size: number; kind: string; mode: number };
				};
				expect(inner.ok).toBe(true);
				expect(inner.value.kind).toBe("file");
				expect(inner.value.size).toBe(5);
				expect(inner.value.mode).toBe(0o644);
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);
});

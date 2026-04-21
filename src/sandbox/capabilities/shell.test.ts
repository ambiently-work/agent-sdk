import { describe, expect, test } from "bun:test";
import { Shell } from "@ambiently-work/faux";
import { ShellSession } from "../../tools/shell-session";
import { ShellTool } from "../../tools/shell-tool";
import { WorkerdBackend } from "../backend/workerd";
import { shellCapability } from "./shell";

const backend = new WorkerdBackend();

describe("shellCapability", () => {
	test("exposes a run() that executes a command in the host Shell", async () => {
		const shell = new Shell({
			user: "luca",
			fs: { "/home/luca/hi.txt": "hello\n" },
		});
		const sandbox = await backend.create({
			capabilities: [shellCapability({ shell })],
		});
		try {
			const loaded = await sandbox.load(`
				defineTool({
					id: "runner",
					description: "Runs shell",
					schema: z.object({}),
					async run() {
						const r = await host.run("cat /home/luca/hi.txt | wc -w");
						return { ok: true, value: r };
					},
				});
			`);
			expect(loaded.ok).toBe(true);
			const result = await sandbox.callJson("__runTool", JSON.stringify({}));
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					value: { stdout: string; stderr: string; exitCode: number };
				};
				expect(inner.ok).toBe(true);
				expect(inner.value.exitCode).toBe(0);
				expect(inner.value.stdout.trim()).toBe("1");
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("denies commands rejected by the allow predicate", async () => {
		const sandbox = await backend.create({
			capabilities: [
				shellCapability({
					shellOptions: { user: "luca" },
					allow: (cmd) => cmd.startsWith("echo "),
				}),
			],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "runner",
					description: "Runs shell",
					schema: z.object({}),
					async run() {
						const r = await host.run("rm -rf /");
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
				expect(inner.error?.capability).toBe("shell");
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("a shared session bridges the sandbox capability and the native ShellTool", async () => {
		const session = new ShellSession({ user: "luca" });
		const tool = new ShellTool({ session });
		const sandbox = await backend.create({
			capabilities: [shellCapability({ session })],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "runner",
					description: "Runs shell",
					schema: z.object({ command: z.string() }),
					async run(inputs) {
						const r = await host.run(inputs.command);
						return { ok: true, value: r };
					},
				});
			`);
			// Guest-side export, host-side read.
			await sandbox.callJson(
				"__runTool",
				JSON.stringify({ command: "export BRIDGED=yep" }),
			);
			const fromTool = await tool.run({ command: "echo $BRIDGED" });
			expect(fromTool.ok).toBe(true);
			if (fromTool.ok) expect(fromTool.value.stdout).toBe("yep\n");
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);

	test("shares shell state across guest invocations", async () => {
		const shell = new Shell({ user: "luca" });
		const sandbox = await backend.create({
			capabilities: [shellCapability({ shell })],
		});
		try {
			await sandbox.load(`
				defineTool({
					id: "runner",
					description: "Runs shell",
					schema: z.object({ command: z.string() }),
					async run(inputs) {
						const r = await host.run(inputs.command);
						return { ok: true, value: r };
					},
				});
			`);
			await sandbox.callJson(
				"__runTool",
				JSON.stringify({ command: "export GREETING=howdy" }),
			);
			const result = await sandbox.callJson(
				"__runTool",
				JSON.stringify({ command: "echo $GREETING" }),
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const inner = result.value as {
					ok: boolean;
					value: { stdout: string };
				};
				expect(inner.ok).toBe(true);
				expect(inner.value.stdout).toBe("howdy\n");
			}
		} finally {
			await sandbox.dispose();
		}
	}, 30_000);
});

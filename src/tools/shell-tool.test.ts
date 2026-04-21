import { describe, expect, test } from "bun:test";
import { Shell } from "@ambiently-work/faux-shell";
import { ShellSession } from "./shell-session";
import { ShellTool } from "./shell-tool";
import { ToolRegistry } from "./tools";

describe("ShellTool", () => {
	test("runs a command and returns stdout/stderr/exitCode", async () => {
		const tool = new ShellTool({ shellOptions: { user: "luca" } });
		const result = await tool.run({ command: "echo hello" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.stdout).toBe("hello\n");
			expect(result.value.stderr).toBe("");
			expect(result.value.exitCode).toBe(0);
		}
	});

	test("preserves shell state across runs (cwd, env)", async () => {
		const tool = new ShellTool({ shellOptions: { user: "luca" } });
		await tool.run({ command: "export FOO=bar" });
		const result = await tool.run({ command: "echo $FOO" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.stdout).toBe("bar\n");
	});

	test("can use a caller-provided Shell instance", async () => {
		const shell = new Shell({
			user: "luca",
			fs: { "/home/luca/note.txt": "ambient\n" },
		});
		const tool = new ShellTool({ shell });
		const result = await tool.run({ command: "cat /home/luca/note.txt" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.stdout).toBe("ambient\n");
	});

	test("integrates with ToolRegistry and validates input", async () => {
		const registry = new ToolRegistry([new ShellTool()]);
		const ok = await registry.run({
			tool: "shell",
			inputs: { command: "printf ok" },
		});
		expect(ok.ok).toBe(true);

		const bad = await registry.run({ tool: "shell", inputs: {} });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.code).toBe("invalid_input");

		const empty = await registry.run({
			tool: "shell",
			inputs: { command: "" },
		});
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.code).toBe("invalid_input");
	});

	test("custom id/description are honored", () => {
		const tool = new ShellTool({
			id: "bash",
			description: "Run bash",
		});
		expect(tool.id).toBe("bash");
		expect(tool.description).toBe("Run bash");
	});

	test("serializes concurrent invocations so one session stays consistent", async () => {
		const tool = new ShellTool({ shellOptions: { user: "luca" } });
		const order: number[] = [];
		const commands = [
			"export STEP=1; echo one",
			"export STEP=2; echo two",
			"export STEP=3; echo three",
		];
		const results = await Promise.all(
			commands.map(async (cmd, i) => {
				const r = await tool.run({ command: cmd });
				order.push(i);
				return r;
			}),
		);
		expect(order).toEqual([0, 1, 2]);
		const finalStep = await tool.run({ command: "echo $STEP" });
		expect(finalStep.ok).toBe(true);
		if (finalStep.ok) expect(finalStep.value.stdout.trim()).toBe("3");
		for (const r of results) expect(r.ok).toBe(true);
	});

	test("a shared ShellSession is reused across tool instances", async () => {
		const session = new ShellSession({ user: "luca" });
		const toolA = new ShellTool({ id: "shell_a", session });
		const toolB = new ShellTool({ id: "shell_b", session });
		await toolA.run({ command: "export SHARED=yes" });
		const r = await toolB.run({ command: "echo $SHARED" });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.stdout).toBe("yes\n");
		expect(toolA.shell).toBe(toolB.shell);
	});
});

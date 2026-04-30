#!/usr/bin/env bun
// Run every sandbox-touching test file in its own `bun test` process.
//
// Why per-file isolation: each test file boots one or more miniflare/workerd
// subprocesses. After roughly 5–10 spawns within a single bun process, Bun's
// `child_process.spawn` stdio plumbing intermittently fails with
// `connect ENOENT` (Bun bug, not workerd). Running each file in a fresh bun
// process keeps spawn pressure low enough to avoid that race entirely. See
// issue #26.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
	"src/sandbox/authoring.test.ts",
	"src/sandbox/backend/workerd.test.ts",
	"src/sandbox/capabilities",
	"src/tools/dynamic-tool.test.ts",
	"src/tools/registry-dynamic.test.ts",
];

function expand(path: string): string[] {
	const stat = statSync(path);
	if (stat.isFile()) return [path];
	const out: string[] = [];
	for (const entry of readdirSync(path)) {
		const child = join(path, entry);
		const childStat = statSync(child);
		if (childStat.isDirectory()) out.push(...expand(child));
		else if (entry.endsWith(".test.ts")) out.push(child);
	}
	return out;
}

const files = ROOTS.flatMap(expand).sort();
const MAX_ATTEMPTS = Number.parseInt(
	process.env.SANDBOX_TEST_ATTEMPTS ?? "2",
	10,
);

function runOnce(file: string): number | null {
	const result = spawnSync("bun", ["test", file], {
		stdio: "inherit",
		env: process.env,
	});
	return result.status;
}

let failures = 0;
for (const file of files) {
	process.stdout.write(`\n→ ${file}\n`);
	let status: number | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		status = runOnce(file);
		if (status === 0) break;
		if (attempt < MAX_ATTEMPTS) {
			// Bun 1.3.12 still surfaces a rare workerd "Broken pipe; fd = 3" at
			// spawn time on Linux runners (issue #26). One retry per file is
			// enough to ride out the transient kernel/IPC race; persistent
			// failures still surface. Tune via SANDBOX_TEST_ATTEMPTS.
			process.stdout.write(
				`  ⟲ ${file} failed (exit ${status}); retrying ${attempt + 1}/${MAX_ATTEMPTS}\n`,
			);
		}
	}
	if (status !== 0) {
		failures += 1;
		process.stdout.write(`  ✗ ${file} (exit ${status})\n`);
	}
}

if (failures > 0) {
	process.stdout.write(`\nSandbox tests failed in ${failures} file(s)\n`);
	process.exit(1);
}
process.stdout.write(`\nAll ${files.length} sandbox test files passed\n`);

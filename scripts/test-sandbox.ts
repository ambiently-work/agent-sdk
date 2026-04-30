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
let failures = 0;
for (const file of files) {
	process.stdout.write(`\n→ ${file}\n`);
	const result = spawnSync("bun", ["test", file], {
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) {
		failures += 1;
		process.stdout.write(`  ✗ ${file} (exit ${result.status})\n`);
	}
}

if (failures > 0) {
	process.stdout.write(`\nSandbox tests failed in ${failures} file(s)\n`);
	process.exit(1);
}
process.stdout.write(`\nAll ${files.length} sandbox test files passed\n`);

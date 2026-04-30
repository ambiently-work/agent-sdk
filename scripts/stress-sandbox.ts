#!/usr/bin/env bun
// Loop the sandbox test suite N times to exercise the miniflare/workerd
// bootstrap race that issue #26 tracked. Gated behind `STRESS_SANDBOX=1` so
// the standard CI run stays fast; set in nightly or workflow_dispatch jobs.
//
// Pass count via `STRESS_RUNS=20` (default 10).
import { spawnSync } from "node:child_process";

if (!process.env.STRESS_SANDBOX) {
	process.stdout.write(
		"Skipping sandbox stress run (set STRESS_SANDBOX=1 to enable)\n",
	);
	process.exit(0);
}

const runs = Number.parseInt(process.env.STRESS_RUNS ?? "10", 10);
let failures = 0;
for (let i = 1; i <= runs; i++) {
	process.stdout.write(`\n=== stress run ${i}/${runs} ===\n`);
	const result = spawnSync("bun", ["scripts/test-sandbox.ts"], {
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) failures += 1;
}

process.stdout.write(`\nStress: ${runs - failures}/${runs} runs passed\n`);
process.exit(failures > 0 ? 1 : 0);

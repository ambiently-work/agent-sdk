#!/usr/bin/env bun
/**
 * CI-oriented wrapper around `tsc -p tsconfig.build.json`.
 *
 * Same situation as `typecheck-ci.ts`: because `@ambiently-work/faux` and
 * `@ambiently-work/mirage` are wired up as `github:` dependencies that ship
 * raw `.ts` sources (npm's `publishConfig.files` is bypassed for git tarball
 * installs), TypeScript follows those imports and type-checks the sibling
 * packages' source trees. Strictness errors over there bubble up into our run
 * and make tsc exit non-zero — even though our own source compiled cleanly
 * and the full `dist/` was emitted.
 *
 * This wrapper runs the build, prints the full output, then filters
 * diagnostics: if every failing location is outside our own `src/` and
 * `scripts/` trees, we treat the run as a pass (and require `dist/index.js`
 * to actually exist). Errors anywhere inside this repo still fail the build.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const proc = Bun.spawn({
	cmd: ["bunx", "tsc", "-p", "tsconfig.build.json", "--pretty", "false"],
	cwd: root,
	stdout: "pipe",
	stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);

await Bun.write(Bun.stdout, stdout);
await Bun.write(Bun.stderr, stderr);

if (exitCode === 0) process.exit(0);

const diagnosticPattern = /^(.+?\.tsx?)\((\d+),(\d+)\):\s+error\s+TS\d+:/;
const ownPathPrefixes = ["src/", "scripts/"];

const errorsInOwnCode: string[] = [];
for (const line of stdout.split("\n")) {
	const match = diagnosticPattern.exec(line);
	if (!match) continue;
	const [, file] = match;
	if (!file) continue;
	const normalized = file.replace(/\\/g, "/");
	if (ownPathPrefixes.some((prefix) => normalized.startsWith(prefix))) {
		errorsInOwnCode.push(line);
	}
}

if (errorsInOwnCode.length > 0) {
	console.error(
		`\n::error::tsc reported ${errorsInOwnCode.length} error(s) in this repo:`,
	);
	for (const err of errorsInOwnCode) console.error(`  ${err}`);
	process.exit(1);
}

const distEntry = resolve(root, "dist/index.js");
if (!existsSync(distEntry)) {
	console.error(
		`\n::error::tsc emitted no errors in this repo, but ${distEntry} was not produced.`,
	);
	process.exit(1);
}

console.error(
	"\ntsc reported errors only in sibling github: dependencies; dist/ was emitted; treating as pass.",
);
process.exit(0);

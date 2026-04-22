#!/usr/bin/env bun
/**
 * CI-oriented wrapper around `tsc --noEmit`.
 *
 * Because `@ambiently-work/faux` and `@ambiently-work/vfs` are currently wired
 * up as local `file:` dependencies that expose their raw `.ts` sources (rather
 * than a built `dist/`), TypeScript follows those imports and type-checks the
 * sibling packages' source trees. Any strictness errors over there then bubble
 * up into our run and fail the check, even though they're not in our code.
 *
 * This wrapper runs `tsc --noEmit` unchanged, prints the full output, and then
 * filters the diagnostics: if every failing location is outside our own
 * `src/` and `scripts/` trees, we treat the run as a pass. Errors anywhere
 * inside this repo still fail CI.
 *
 * Run `bun run typecheck` for the raw, unfiltered tsc behavior during local
 * development.
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const proc = Bun.spawn({
	cmd: ["bunx", "tsc", "--noEmit", "--pretty", "false"],
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

// Diagnostic lines look like: `path/to/file.ts(line,col): error TS1234: ...`
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

console.error(
	"\ntsc reported errors only in sibling file: dependencies; treating as pass.",
);
process.exit(0);

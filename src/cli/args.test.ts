import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
	test("defaults model from env or fallback", () => {
		const args = parseArgs([]);
		expect(typeof args.model).toBe("string");
		expect(args.model.length).toBeGreaterThan(0);
	});

	test("reads prompt from positional args", () => {
		const args = parseArgs(["hello", "world"]);
		expect(args.prompt).toBe("hello world");
	});

	test("parses flags", () => {
		const args = parseArgs([
			"-m",
			"qwen2.5:7b",
			"--host",
			"http://localhost:11434",
			"-s",
			"be concise",
			"-t",
			"0.2",
			"--max-tokens",
			"500",
			"--max-tool-iterations",
			"4",
			"--once",
			"--no-color",
			"tell me a joke",
		]);
		expect(args.model).toBe("qwen2.5:7b");
		expect(args.host).toBe("http://localhost:11434");
		expect(args.system).toBe("be concise");
		expect(args.temperature).toBe(0.2);
		expect(args.maxTokens).toBe(500);
		expect(args.maxToolIterations).toBe(4);
		expect(args.once).toBe(true);
		expect(args.noColor).toBe(true);
		expect(args.prompt).toBe("tell me a joke");
	});

	test("--help sets help flag", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
	});

	test("throws on unknown flag", () => {
		expect(() => parseArgs(["--nonsense"])).toThrow(/unknown flag/);
	});

	test("throws when a flag expects a value but none is given", () => {
		expect(() => parseArgs(["--model"])).toThrow(/missing value/);
	});
});

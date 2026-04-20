import { describe, expect, test } from "bun:test";
import {
	type ModelInfo,
	Provider,
	type ProviderEvent,
	type ProviderResult,
	type RunInput,
} from "../providers/provider";
import { SingleModelRouter, StaticModelRouter } from "./model-router";

class StubProvider extends Provider {
	readonly id = "stub";
	async listModels(): Promise<ProviderResult<ModelInfo[]>> {
		return { ok: true, value: [] };
	}
	async *run(_input: RunInput): AsyncIterable<ProviderEvent> {
		yield { type: "done", stopReason: "stop" };
	}
}

describe("StaticModelRouter", () => {
	test("resolves exact tier", () => {
		const provider = new StubProvider();
		const router = new StaticModelRouter({
			smart: { provider, model: "big" },
			fast: { provider, model: "small" },
		});
		expect(router.resolve("smart").model).toBe("big");
		expect(router.resolve("fast").model).toBe("small");
	});

	test("falls back to fallback tier when unknown", () => {
		const provider = new StubProvider();
		const router = new StaticModelRouter(
			{ fast: { provider, model: "small" } },
			"fast",
		);
		expect(router.resolve("smart").model).toBe("small");
	});

	test("throws for unknown tier with no fallback", () => {
		const provider = new StubProvider();
		const router = new StaticModelRouter({
			fast: { provider, model: "small" },
		});
		expect(() => router.resolve("smart")).toThrow(/unknown tier "smart"/);
	});

	test("throws when constructed with no bindings", () => {
		expect(() => new StaticModelRouter({})).toThrow(/at least one binding/);
	});
});

describe("SingleModelRouter", () => {
	test("returns the same binding for any tier", () => {
		const provider = new StubProvider();
		const router = new SingleModelRouter({ provider, model: "only" });
		expect(router.resolve("smart").model).toBe("only");
		expect(router.resolve("fast").model).toBe("only");
		expect(router.resolve("anything-else").model).toBe("only");
	});
});

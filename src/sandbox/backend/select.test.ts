import { describe, expect, test } from "bun:test";
import { selectBackend } from "./select";
import { WorkerLoaderBackend } from "./worker-loader";
import { WorkerdBackend } from "./workerd";

describe("selectBackend", () => {
	test("defaults to Workerd", async () => {
		const backend = await selectBackend();
		expect(backend).toBeInstanceOf(WorkerdBackend);
	});

	test("explicit prefer=workerd returns WorkerdBackend", async () => {
		const backend = await selectBackend({ prefer: "workerd" });
		expect(backend).toBeInstanceOf(WorkerdBackend);
	});

	test("explicit prefer=worker-loader without loader throws", async () => {
		await expect(selectBackend({ prefer: "worker-loader" })).rejects.toThrow(
			/requires both `loader`/,
		);
	});

	test("auto with loader+hostFetcher returns WorkerLoaderBackend", async () => {
		const backend = await selectBackend({
			loader: {
				load: () => ({
					getEntrypoint: () => ({ fetch: async () => new Response() }),
				}),
				get: () => ({
					getEntrypoint: () => ({ fetch: async () => new Response() }),
				}),
			},
			hostFetcher: () => ({ fetch: async () => new Response() }),
		});
		expect(backend).toBeInstanceOf(WorkerLoaderBackend);
	});
});

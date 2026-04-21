import { ToolRegistry } from "@ambiently-work/faux";
import type { Provider, ProviderEvent, RunInput } from "../providers/provider";

export class Agent {
	constructor(
		public readonly provider: Provider,
		public readonly tools: ToolRegistry = new ToolRegistry(),
	) {}

	run(input: Omit<RunInput, "tools">): AsyncIterable<ProviderEvent> {
		return this.provider.run({ ...input, tools: this.tools });
	}
}

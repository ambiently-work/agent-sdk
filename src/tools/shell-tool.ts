import type { Shell, ShellOptions, ShellResult } from "@ambiently-work/faux";
import { z } from "zod";
import { ShellSession } from "./shell-session";
import { Tool, type ToolResult } from "./tools";

export interface ShellToolOptions {
	id?: string;
	description?: string;
	session?: ShellSession;
	shell?: Shell;
	shellOptions?: ShellOptions;
}

const DEFAULT_DESCRIPTION =
	"Run a command in a long-lived, in-process POSIX-ish shell session with a virtual filesystem. State (cwd, env, files) persists across calls for the life of the agent. Returns stdout, stderr, and exitCode.";

const inputSchema = z.object({
	command: z.string().min(1, "command must be non-empty"),
});

type ShellToolInput = z.infer<typeof inputSchema>;

export class ShellTool extends Tool<ShellToolInput, ShellResult> {
	readonly id: string;
	readonly description: string;
	readonly schema = inputSchema;
	readonly session: ShellSession;

	constructor(options: ShellToolOptions = {}) {
		super();
		this.id = options.id ?? "shell";
		this.description = options.description ?? DEFAULT_DESCRIPTION;
		this.session =
			options.session ??
			new ShellSession(options.shell ?? options.shellOptions ?? {});
	}

	get shell(): Shell {
		return this.session.shell;
	}

	async run(inputs: ShellToolInput): Promise<ToolResult<ShellResult>> {
		try {
			const result = await this.session.run(inputs.command);
			return { ok: true, value: result };
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "tool_failed",
					message: error instanceof Error ? error.message : String(error),
					cause: error,
				},
			};
		}
	}
}

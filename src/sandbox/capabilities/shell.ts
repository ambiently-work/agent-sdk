import type {
	Shell,
	ShellOptions,
	ShellResult,
} from "@ambiently-work/faux";
import { ShellSession } from "../../tools/shell-session";
import type { Capability } from "../types";

export interface ShellCapabilityOptions {
	session?: ShellSession;
	shell?: Shell;
	shellOptions?: ShellOptions;
	/** Reject commands the guest attempts to run. Return `false` to deny. */
	allow?: (command: string) => boolean;
}

export class ShellDeniedError extends Error {
	readonly capability = "shell";
	constructor(public readonly command: string) {
		super(`shell command "${command}" is not allowed`);
		this.name = "ShellDeniedError";
	}
}

export function shellCapability(opts: ShellCapabilityOptions = {}): Capability {
	const session =
		opts.session ?? new ShellSession(opts.shell ?? opts.shellOptions ?? {});
	const allow = opts.allow ?? (() => true);

	return {
		name: "shell",
		functions: {
			run: async (...args): Promise<ShellResult> => {
				const [command] = args as [string];
				if (typeof command !== "string" || command.length === 0) {
					throw new Error("shell.run: command must be a non-empty string");
				}
				if (!allow(command)) throw new ShellDeniedError(command);
				return await session.run(command);
			},
		},
	};
}

import type { Capability } from "../types";

export type LogSink = (
	level: "log" | "warn" | "error",
	message: string,
) => void;

export interface LogCapabilityOptions {
	sink?: LogSink;
}

export function logCapability(opts: LogCapabilityOptions = {}): Capability {
	const sink: LogSink = opts.sink ?? (() => {});
	return {
		name: "log",
		functions: {
			log: async (...args) => {
				sink("log", formatArgs(args));
				return null;
			},
			warn: async (...args) => {
				sink("warn", formatArgs(args));
				return null;
			},
			error: async (...args) => {
				sink("error", formatArgs(args));
				return null;
			},
		},
	};
}

function formatArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

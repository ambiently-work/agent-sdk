import type { ProviderEvent } from "../providers/provider";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export interface RenderOptions {
	color?: boolean;
	stream?: NodeJS.WriteStream;
	showUsage?: boolean;
}

export class EventRenderer {
	private readonly color: boolean;
	private readonly out: NodeJS.WriteStream;
	private readonly showUsage: boolean;
	private streaming = false;

	constructor(opts: RenderOptions = {}) {
		this.out = opts.stream ?? process.stdout;
		this.color = opts.color ?? Boolean(this.out.isTTY);
		this.showUsage = opts.showUsage ?? true;
	}

	handle(event: ProviderEvent): void {
		switch (event.type) {
			case "assistant_text_delta":
				if (!this.streaming) {
					this.write(this.paint(BOLD, "assistant> "));
					this.streaming = true;
				}
				this.write(event.text);
				return;
			case "assistant_text":
				if (this.streaming) {
					this.write("\n");
					this.streaming = false;
				}
				return;
			case "tool_call":
				this.write(
					`${this.paint(CYAN, "→ tool")} ${this.paint(BOLD, event.call.name)} ${this.paint(DIM, JSON.stringify(event.call.input))}\n`,
				);
				return;
			case "tool_result": {
				if (event.result.ok) {
					const summary = summarize(event.result.value);
					this.write(
						`${this.paint(GREEN, "← ok")}   ${this.paint(DIM, summary)}\n`,
					);
				} else {
					this.write(
						`${this.paint(RED, "← err")}  ${event.result.error.code}: ${event.result.error.message}\n`,
					);
				}
				return;
			}
			case "done": {
				const suffix =
					this.showUsage && event.usage
						? ` ${this.paint(DIM, `(in=${event.usage.inputTokens ?? "?"} out=${event.usage.outputTokens ?? "?"})`)}`
						: "";
				const label =
					event.stopReason === "stop"
						? this.paint(DIM, "[done]")
						: this.paint(YELLOW, `[done: ${event.stopReason}]`);
				this.write(`${label}${suffix}\n`);
				return;
			}
			case "error":
				this.write(
					`${this.paint(RED, "[error]")} ${event.error.code}: ${event.error.message}\n`,
				);
				return;
		}
	}

	info(message: string): void {
		this.write(`${this.paint(MAGENTA, "›")} ${message}\n`);
	}

	private write(text: string): void {
		this.out.write(text);
	}

	private paint(code: string, text: string): string {
		return this.color ? `${code}${text}${RESET}` : text;
	}
}

function summarize(value: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return String(value);
	}
	if (json.length <= 200) return json;
	return `${json.slice(0, 197)}...`;
}

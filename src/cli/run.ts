import { Agent } from "../agent/agent";
import { ClaudeAgentProvider } from "../providers/claude-agent";
import { CodexProvider } from "../providers/codex";
import { GeminiProvider } from "../providers/gemini";
import { LMStudioProvider } from "../providers/lmstudio";
import { OllamaProvider } from "../providers/ollama";
import type { Message, Provider } from "../providers/provider";
import { ToolRegistry } from "../tools/tools";
import { type CliArgs, HELP_TEXT, type ProviderId, parseArgs } from "./args";
import { EventRenderer } from "./render";

export interface CliDeps {
	argv?: string[];
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	tools?: ToolRegistry;
}

export async function runCli(deps: CliDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const stdin = deps.stdin ?? process.stdin;

	let args: CliArgs;
	try {
		args = parseArgs(deps.argv ?? process.argv.slice(2));
	} catch (e) {
		stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		stderr.write(HELP_TEXT);
		return 2;
	}

	if (args.help) {
		stdout.write(HELP_TEXT);
		return 0;
	}

	const renderer = new EventRenderer({
		stream: stdout,
		color: !args.noColor && Boolean(stdout.isTTY),
	});

	const provider = makeProvider(args.provider, args.host);
	const agent = new Agent(provider, deps.tools ?? new ToolRegistry());

	const turns: Message[] = [];
	const piped = !stdin.isTTY;
	const interactive = !args.once && !piped && stdout.isTTY;

	const firstPrompt = args.prompt ?? (piped ? await readAll(stdin) : undefined);

	if (firstPrompt !== undefined) {
		turns.push({ role: "user", content: firstPrompt });
		const ok = await runTurn(agent, args, turns, renderer);
		if (!ok) return 1;
		if (!interactive) return 0;
	}

	if (!interactive) {
		renderer.info(
			"no input — pipe a prompt, pass one as args, or run in a TTY",
		);
		return 2;
	}

	renderer.info(
		`interactive mode — provider=${args.provider} model=${args.model}${args.host ? ` host=${args.host}` : ""}. ctrl-d or ctrl-c to exit.`,
	);

	for await (const line of readLines(stdin, stdout)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed === "/exit" || trimmed === "/quit") break;
		turns.push({ role: "user", content: line });
		const ok = await runTurn(agent, args, turns, renderer);
		if (!ok) return 1;
	}
	return 0;
}

async function runTurn(
	agent: Agent,
	args: CliArgs,
	turns: Message[],
	renderer: EventRenderer,
): Promise<boolean> {
	const abort = new AbortController();
	const onSigint = () => abort.abort();
	process.on("SIGINT", onSigint);
	let assistantText = "";
	try {
		for await (const event of agent.run({
			model: args.model,
			messages: turns,
			systemPrompt: args.system,
			temperature: args.temperature,
			maxTokens: args.maxTokens,
			maxToolIterations: args.maxToolIterations,
			signal: abort.signal,
		})) {
			renderer.handle(event);
			if (event.type === "assistant_text") assistantText = event.text;
			if (event.type === "error") return false;
		}
	} finally {
		process.off("SIGINT", onSigint);
	}
	turns.push({ role: "assistant", content: assistantText });
	return true;
}

function makeProvider(id: ProviderId, host: string | undefined): Provider {
	switch (id) {
		case "ollama":
			return new OllamaProvider({ host });
		case "lmstudio":
			return new LMStudioProvider({ baseUrl: host });
		case "gemini":
			return new GeminiProvider();
		case "claude-agent":
			return new ClaudeAgentProvider();
		case "codex":
			return new CodexProvider();
	}
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function* readLines(
	stdin: NodeJS.ReadStream,
	stdout: NodeJS.WriteStream,
): AsyncIterable<string> {
	const prompt = "you> ";
	stdout.write(prompt);
	let buffer = "";
	stdin.setEncoding("utf8");
	for await (const chunk of stdin as AsyncIterable<string>) {
		buffer += chunk;
		let idx = buffer.indexOf("\n");
		while (idx !== -1) {
			const line = buffer.slice(0, idx).replace(/\r$/, "");
			buffer = buffer.slice(idx + 1);
			yield line;
			stdout.write(prompt);
			idx = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) yield buffer;
}

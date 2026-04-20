export type ProviderId =
	| "ollama"
	| "lmstudio"
	| "gemini"
	| "claude-agent"
	| "codex";

export const PROVIDER_IDS: readonly ProviderId[] = [
	"ollama",
	"lmstudio",
	"gemini",
	"claude-agent",
	"codex",
];

export interface CliArgs {
	provider: ProviderId;
	model: string;
	host?: string;
	system?: string;
	prompt?: string;
	temperature?: number;
	maxTokens?: number;
	maxToolIterations?: number;
	noColor: boolean;
	once: boolean;
	help: boolean;
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
	ollama: "llama3.1",
	lmstudio: "",
	gemini: "gemini-2.5-flash",
	"claude-agent": "claude-sonnet-4-6",
	codex: "gpt-5-codex",
};

export function parseArgs(argv: string[]): CliArgs {
	const envProvider = process.env.AMBIENT_PROVIDER as ProviderId | undefined;
	const provider: ProviderId =
		envProvider && PROVIDER_IDS.includes(envProvider) ? envProvider : "ollama";
	const args: CliArgs = {
		provider,
		model: process.env.AMBIENT_MODEL ?? DEFAULT_MODELS[provider],
		host: process.env.OLLAMA_BASE_URL,
		noColor: process.env.NO_COLOR !== undefined,
		once: false,
		help: false,
	};

	const positional: string[] = [];
	let modelExplicit = process.env.AMBIENT_MODEL !== undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		switch (arg) {
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-p":
			case "--provider": {
				const value = requireValue(argv, ++i, arg);
				if (!PROVIDER_IDS.includes(value as ProviderId)) {
					throw new Error(
						`unknown provider "${value}" (must be one of: ${PROVIDER_IDS.join(", ")})`,
					);
				}
				args.provider = value as ProviderId;
				if (!modelExplicit) args.model = DEFAULT_MODELS[args.provider];
				break;
			}
			case "-m":
			case "--model":
				args.model = requireValue(argv, ++i, arg);
				modelExplicit = true;
				break;
			case "--host":
				args.host = requireValue(argv, ++i, arg);
				break;
			case "-s":
			case "--system":
				args.system = requireValue(argv, ++i, arg);
				break;
			case "-t":
			case "--temperature":
				args.temperature = Number(requireValue(argv, ++i, arg));
				break;
			case "--max-tokens":
				args.maxTokens = Number(requireValue(argv, ++i, arg));
				break;
			case "--max-tool-iterations":
				args.maxToolIterations = Number(requireValue(argv, ++i, arg));
				break;
			case "--no-color":
				args.noColor = true;
				break;
			case "--once":
				args.once = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
				positional.push(arg);
		}
	}

	if (positional.length > 0) args.prompt = positional.join(" ");
	return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (value === undefined) throw new Error(`missing value for ${flag}`);
	return value;
}

export const HELP_TEXT = `ambient — run an LLM agent loop from the CLI

Usage:
  ambient [flags] [prompt...]

Reads from stdin when no prompt is given. Without --once, runs as an interactive REPL.

Flags:
  -p, --provider <id>         ${PROVIDER_IDS.join(" | ")} (default: ollama or $AMBIENT_PROVIDER)
  -m, --model <id>            model id (default: per-provider, or $AMBIENT_MODEL)
      --host <url>            backend base URL (Ollama / LM Studio)
  -s, --system <text>         system prompt
  -t, --temperature <n>       sampling temperature
      --max-tokens <n>        max tokens
      --max-tool-iterations <n>  cap on tool-call loop iterations (default: 16)
      --once                  run a single turn, then exit
      --no-color              disable ANSI colors
  -h, --help                  show this help

Env:
  AMBIENT_PROVIDER              default provider id
  AMBIENT_MODEL                 default model id
  OLLAMA_BASE_URL               Ollama host
  LMSTUDIO_BASE_URL             LM Studio host (ws://localhost:1234)
  GOOGLE_API_KEY / GEMINI_API_KEY  Gemini auth
  ANTHROPIC_API_KEY             Claude Agent SDK auth (honored by the CLI it wraps)
  OPENAI_API_KEY                Codex SDK auth (honored by the CLI it wraps)
  NO_COLOR                      disable colors when set

Examples:
  ambient "what's 2+2"
  echo "summarize this" | ambient --once
  ambient -p lmstudio -m qwen2.5-7b-instruct
  ambient -p gemini "draft a release note"
  ambient -p claude-agent "review this PR" -s "be terse"
`;

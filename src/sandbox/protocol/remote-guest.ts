import { defineToolSource } from "./preamble/defineTool";
import { zodBundleSource } from "./preamble/zod.bundle";

const HOST_PROXY_SOURCE = `
let __ENV_HOST = null;

globalThis.host = new Proxy({}, {
  get(_, name) {
    if (typeof name !== "string") return undefined;
    return async (...args) => {
      if (!__ENV_HOST) {
        const e = new Error("host capabilities are only available during runTool");
        e.name = "SandboxRuntimeError";
        throw e;
      }
      const res = await __ENV_HOST.fetch("http://_/invoke", {
        method: "POST",
        body: JSON.stringify({ fn: name, args }),
        headers: { "content-type": "application/json" },
      });
      const json = await res.json();
      if (json.error) {
        const err = new Error(json.error.message);
        err.name = json.error.name || "Error";
        throw err;
      }
      return json.value;
    };
  },
});

globalThis.__setHostBinding = (binding) => { __ENV_HOST = binding; };
`;

const ENTRYPOINT_SOURCE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/loadTool") {
        return Response.json(JSON.parse(globalThis.__loadTool()));
      }
      if (url.pathname === "/runTool") {
        const inputsJson = await request.text();
        globalThis.__setHostBinding(env.HOST);
        try {
          const result = await globalThis.__runTool(inputsJson);
          return new Response(result, { headers: { "content-type": "application/json" } });
        } finally {
          globalThis.__setHostBinding(null);
        }
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({
        ok: false,
        error: {
          code: "sandbox_runtime_error",
          message: e && e.message ? String(e.message) : String(e),
        },
      }, { status: 500 });
    }
  },
};
`;

export interface BuiltGuestModule {
	mainModule: string;
	modules: Record<string, string>;
}

export function buildRemoteGuestModule(userSource: string): BuiltGuestModule {
	const guestSource = `${zodBundleSource}\n${HOST_PROXY_SOURCE}\n${defineToolSource}\n${userSource}\n${ENTRYPOINT_SOURCE}`;
	return {
		mainModule: "guest.mjs",
		modules: { "guest.mjs": guestSource },
	};
}

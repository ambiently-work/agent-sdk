export const defineToolSource = `
(() => {
  let SPEC = null;

  globalThis.defineTool = (spec) => {
    if (SPEC !== null) throw new Error("defineTool can only be called once");
    if (typeof spec !== "object" || spec === null) throw new Error("spec must be an object");
    if (typeof spec.id !== "string" || spec.id.length === 0) throw new Error("spec.id must be a non-empty string");
    if (typeof spec.description !== "string") throw new Error("spec.description must be a string");
    if (typeof spec.run !== "function") throw new Error("spec.run must be a function");
    if (!spec.schema || typeof spec.schema.safeParse !== "function") {
      throw new Error("spec.schema must be a zod schema");
    }
    SPEC = spec;
  };

  globalThis.__loadTool = () => {
    if (!SPEC) throw new Error("defineTool was never called");
    const jsonSchema = globalThis.z.toJSONSchema(SPEC.schema);
    return JSON.stringify({
      id: SPEC.id,
      description: SPEC.description,
      jsonSchema,
    });
  };

  globalThis.__runTool = async (inputsJson) => {
    if (!SPEC) {
      return JSON.stringify({
        ok: false,
        error: { code: "sandbox_load_failed", message: "defineTool was never called" },
      });
    }
    let inputs;
    try {
      inputs = JSON.parse(inputsJson);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: { code: "invalid_input", message: "inputs were not valid JSON", issues: [] },
      });
    }
    const parsed = SPEC.schema.safeParse(inputs);
    if (!parsed.success) {
      return JSON.stringify({
        ok: false,
        error: {
          code: "invalid_input",
          message: globalThis.z.prettifyError(parsed.error),
          issues: parsed.error.issues,
        },
      });
    }
    try {
      const result = await SPEC.run(parsed.data);
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
        return JSON.stringify({
          ok: false,
          error: { code: "tool_failed", message: "tool returned a value that is not a Result" },
        });
      }
      return JSON.stringify(result);
    } catch (e) {
      const name = e && e.name ? String(e.name) : "Error";
      const message = e && e.message ? String(e.message) : String(e);
      const stack = e && e.stack ? String(e.stack) : undefined;
      const code =
        name === "FetchDeniedError"
          ? "sandbox_capability_denied"
          : name === "FetchOversizeError"
          ? "tool_failed"
          : "sandbox_runtime_error";
      const error =
        code === "sandbox_capability_denied"
          ? { code, message, capability: "fetch" }
          : { code, message, stack };
      return JSON.stringify({ ok: false, error });
    }
  };
})();
`;

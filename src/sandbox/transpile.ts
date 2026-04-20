declare const Bun: {
	Transpiler: new (opts: {
		loader: "ts" | "tsx" | "js" | "jsx";
	}) => {
		transformSync(source: string): string;
	};
};

export function transpileTs(
	source: string,
	loader: "ts" | "tsx" = "ts",
): string {
	if (typeof globalThis.Bun === "undefined") {
		throw new Error(
			"transpileTs requires the Bun runtime — transpile tool sources at authoring time and persist the JS output",
		);
	}
	const transpiler = new Bun.Transpiler({ loader });
	return transpiler.transformSync(source);
}

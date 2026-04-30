import type { IFileSystem, MirageStats } from "@ambiently-work/mirage";
import type { Capability } from "../types";

export interface FsCapabilityOptions {
	/**
	 * The filesystem to expose. Typically a `VirtualFileSystem` from
	 * `@ambiently-work/mirage`, but any `IFileSystem` works (including a
	 * `ReadOnlyFileSystem` or `LayeredFileSystem`).
	 */
	fs: IFileSystem;
	/**
	 * Predicate to gate guest access to specific paths. Return `false` to
	 * deny. Defaults to allowing everything.
	 */
	allow?: (op: FsOp, path: string) => boolean;
}

export type FsOp =
	| "readFile"
	| "readDir"
	| "stat"
	| "lstat"
	| "exists"
	| "writeFile"
	| "appendFile"
	| "mkdir"
	| "rm"
	| "cp"
	| "mv"
	| "glob";

export class FsDeniedError extends Error {
	readonly capability = "fs";
	constructor(
		public readonly op: FsOp,
		public readonly path: string,
	) {
		super(`fs.${op} on "${path}" is not allowed`);
		this.name = "FsDeniedError";
	}
}

/**
 * Stats shape returned to guests. A plain object, not the function-bearing
 * `VfsStats` — those methods can't cross the host/guest JSON boundary.
 */
export interface GuestStats {
	size: number;
	mode: number;
	uid: number;
	gid: number;
	atime: number;
	mtime: number;
	ctime: number;
	kind: "file" | "directory" | "symlink";
}

function toGuestStats(stat: MirageStats): GuestStats {
	const kind = stat.isFile()
		? "file"
		: stat.isDirectory()
			? "directory"
			: "symlink";
	return {
		size: stat.size,
		mode: stat.mode,
		uid: stat.uid,
		gid: stat.gid,
		atime: stat.atime,
		mtime: stat.mtime,
		ctime: stat.ctime,
		kind,
	};
}

/**
 * Expose a {@link IFileSystem} to guest tools running inside a sandbox.
 *
 * Guests call `host.fs.readFile(path)`, `host.fs.writeFile(path, content)`,
 * etc. The host side enforces the optional `allow` predicate before
 * forwarding to the underlying filesystem.
 *
 * Share the same filesystem with a {@link shellCapability} by passing the
 * `Shell.vfs` instance here, so the guest sees the same tree the shell does.
 */
export function fsCapability(opts: FsCapabilityOptions): Capability {
	const { fs } = opts;
	const allow = opts.allow ?? (() => true);

	function guard(op: FsOp, path: string): void {
		if (!allow(op, path)) throw new FsDeniedError(op, path);
	}

	return {
		name: "fs",
		functions: {
			readFile: async (...args): Promise<string> => {
				const [path] = args as [string];
				guard("readFile", path);
				return fs.readFile(path);
			},
			readDir: async (...args): Promise<string[]> => {
				const [path] = args as [string];
				guard("readDir", path);
				return fs.readDir(path);
			},
			stat: async (...args): Promise<GuestStats> => {
				const [path] = args as [string];
				guard("stat", path);
				return toGuestStats(fs.stat(path));
			},
			lstat: async (...args): Promise<GuestStats> => {
				const [path] = args as [string];
				guard("lstat", path);
				return toGuestStats(fs.lstat(path));
			},
			exists: async (...args): Promise<boolean> => {
				const [path] = args as [string];
				guard("exists", path);
				return fs.exists(path);
			},
			writeFile: async (...args): Promise<void> => {
				const [path, content] = args as [string, string];
				guard("writeFile", path);
				fs.writeFile(path, content);
			},
			appendFile: async (...args): Promise<void> => {
				const [path, content] = args as [string, string];
				guard("appendFile", path);
				fs.appendFile(path, content);
			},
			mkdir: async (...args): Promise<void> => {
				const [path, options] = args as [
					string,
					{ recursive?: boolean } | undefined,
				];
				guard("mkdir", path);
				fs.mkdir(path, options);
			},
			rm: async (...args): Promise<void> => {
				const [path, options] = args as [
					string,
					{ recursive?: boolean; force?: boolean } | undefined,
				];
				guard("rm", path);
				fs.rm(path, options);
			},
			cp: async (...args): Promise<void> => {
				const [src, dest, options] = args as [
					string,
					string,
					{ recursive?: boolean } | undefined,
				];
				guard("cp", src);
				guard("cp", dest);
				fs.cp(src, dest, options);
			},
			mv: async (...args): Promise<void> => {
				const [src, dest] = args as [string, string];
				guard("mv", src);
				guard("mv", dest);
				fs.mv(src, dest);
			},
			glob: async (...args): Promise<string[]> => {
				const [pattern, options] = args as [
					string,
					{ cwd?: string } | undefined,
				];
				guard("glob", pattern);
				return fs.glob(pattern, options);
			},
		},
	};
}

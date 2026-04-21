import {
	Shell,
	type ShellOptions,
	type ShellResult,
} from "@ambiently-work/faux-shell";

export class ShellSession {
	readonly shell: Shell;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(shellOrOptions: Shell | ShellOptions = {}) {
		this.shell =
			shellOrOptions instanceof Shell
				? shellOrOptions
				: new Shell(shellOrOptions);
	}

	run(command: string): Promise<ShellResult> {
		const task = this.queue.then(() => this.shell.run(command));
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}
}

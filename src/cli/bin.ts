#!/usr/bin/env bun
import { runCli } from "./run";

const code = await runCli();
process.exit(code);

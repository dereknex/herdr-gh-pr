#!/usr/bin/env bun
import { run } from "../src/main";
run(process.argv[2], true, true).catch((error) => {
  console.error(`[gh-pr] ${error}`);
  process.exitCode = 1;
});

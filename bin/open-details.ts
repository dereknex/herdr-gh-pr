#!/usr/bin/env bun
import { openDetails } from "../src/main";
openDetails(process.argv[2]).catch((error) => {
  console.error(`[gh-pr] ${error}`);
  process.exitCode = 1;
});

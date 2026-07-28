#!/usr/bin/env node
/**
 * Run the Vitest suite + Node's built-in backend test runner.
 * Sequential by default so output stays readable in CI logs.
 *
 *   node scripts/test-all.mjs              (default)
 *   node scripts/test-all.mjs --parallel   (run both streams at once)
 *
 * Exits non-zero if either suite fails.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const parallel = process.argv.includes("--parallel");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const SUITES = [
  { name: "frontend (vitest)", cmd: npm, args: ["run", "test"] },
  { name: "backend (node:test)", cmd: npm, args: ["run", "test:backend"] },
];

function runOne(suite) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // On Windows, npm is npm.cmd — prefer running through the shell so
    // Node's ENOENT-on-spawn behavior doesn't bite on MSYS bash.
    const result = spawnSync(suite.cmd, suite.args, {
      stdio: "inherit",
      env: process.env,
      shell: true,
    });
    const code = result.status ?? 1;
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n[test-all] ${suite.name} exited with code ${code} after ${dur}s`);
    resolve(code);
  });
}

if (parallel) {
  const codes = await Promise.all(SUITES.map(runOne));
  const failed = codes.some((c) => c !== 0);
  process.exit(failed ? 1 : 0);
} else {
  for (const suite of SUITES) {
    const code = await runOne(suite);
    if (code !== 0) {
      console.error(`[test-all] ${suite.name} failed; aborting.`);
      process.exit(code);
    }
  }
  console.log("\n[test-all] all suites passed.");
}

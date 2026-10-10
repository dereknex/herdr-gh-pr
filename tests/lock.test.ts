import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, statePath } from "../src/state";

const WORKER = `
const dir = process.argv[2];
const roundDir = process.argv[3];
process.env.HERDR_PLUGIN_STATE_DIR = dir;
const { acquireLock } = await import(${JSON.stringify(new URL("../src/state.ts", import.meta.url).pathname)});
const { writeFileSync, readdirSync } = await import("node:fs");
const { join } = await import("node:path");
const lock = acquireLock("concurrent-key");
try { writeFileSync(join(roundDir, "attempt-" + process.pid), lock ? "acquired" : "denied"); } catch {}
if (!lock) { console.log("denied"); process.exit(0); }
console.log("acquired");
const start = Date.now();
while (Date.now() - start < 5000) {
  try {
    const attempts = readdirSync(roundDir).filter(f => f.startsWith("attempt-"));
    if (attempts.length >= 6) break;
  } catch {}
  await Bun.sleep(10);
}
lock();
process.exit(0);
`;

test("concurrent hooks elect exactly one lock holder and a dead owner is recoverable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-pr-lock-test-"));
  try {
    const worker = join(dir, "worker.ts");
    writeFileSync(worker, WORKER);
    for (let round = 0; round < 2; round++) {
      const roundDir = join(dir, `round-${round}`);
      mkdirSync(roundDir, { recursive: true });
      const workers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, worker, dir, roundDir], { stdout: "pipe", stderr: "pipe" }));
      let acquired = 0;
      for (const w of workers) {
        const out = await new Response(w.stdout).text();
        const err = await new Response(w.stderr).text();
        if ((await w.exited) !== 0) throw new Error(`worker crashed: ${err}`);
        if (out.trim() === "acquired") acquired++;
      }
      expect(acquired).toBe(1);
    }
    const dead = statePath("lock", "dead-owner");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "owner.json"), JSON.stringify({ pid: 99999999, token: "gone" }));
    const recovered = acquireLock("dead-owner");
    expect(typeof recovered).toBe("function");
    expect(recovered).not.toBeNull();
    recovered?.();

    // Stale recovery lock with dead owner is also reclaimed
    const deadRecKey = "dead-rec-owner";
    const deadRec = statePath("lock", deadRecKey);
    mkdirSync(deadRec, { recursive: true });
    writeFileSync(join(deadRec, "owner.json"), JSON.stringify({ pid: 99999999, token: "main-dead" }));
    const deadRecDir = `${deadRec}.recovery`;
    mkdirSync(deadRecDir, { recursive: true });
    writeFileSync(join(deadRecDir, "owner.json"), JSON.stringify({ pid: 99999999, time: Date.now() }));
    const recFromDeadRec = acquireLock(deadRecKey);
    expect(typeof recFromDeadRec).toBe("function");
    expect(recFromDeadRec).not.toBeNull();
    recFromDeadRec?.();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

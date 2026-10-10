import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { digest, type Snapshot } from "./pr";

export interface DeliveryState {
  active: Record<string, number>;
  sent: string[];
  lastAttempt: number;
  status: string;
  pendingAttempt?: string[];
}
export const emptyDelivery = (): DeliveryState => ({ active: {}, sent: [], lastAttempt: 0, status: "" });
export interface PaneCache { snapshot?: Snapshot; root: string; branch: string; error?: string; delivery?: string }
function directory(): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(tmpdir(), "herdr-gh-pr");
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function statePath(kind: string, key: string): string {
  return join(directory(), `${kind}-${digest(key)}.json`);
}
export function readState<T>(kind: string, key: string): T | undefined {
  try { return JSON.parse(readFileSync(statePath(kind, key), "utf8")); }
  catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
}
export function writeState(kind: string, key: string, value: unknown): void {
  const file = statePath(kind, key);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

// A live process retains its lock regardless of query duration. A recovery
// lock serializes removal of a dead holder; ownership is checked on release.
export function acquireLock(key: string): (() => void) | null {
  const path = statePath("lock", key);
  const ownerFile = join(path, "owner.json");
  const token = randomUUID();
  const create = () => {
    mkdirSync(path);
    const ownerTemp = join(path, "owner.json.tmp");
    writeFileSync(ownerTemp, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    // Atomic rename: concurrent readers see either no record or a complete one.
    renameSync(ownerTemp, ownerFile);
  };
  try { create(); }
  catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const recovery = `${path}.recovery`;
    try { mkdirSync(recovery); }
    catch (error: any) { if (error.code === "EEXIST") return null; throw error; }
    try {
      let owner: { pid: number; token: string } | undefined;
      try { owner = JSON.parse(readFileSync(ownerFile, "utf8")); }
      catch (error: any) {
        // Missing or unreadable means the creator may still be finishing its record.
        if (Date.now() - statSync(error.code === "ENOENT" ? path : ownerFile).mtimeMs < 300_000) return null;
      }
      if (owner) {
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") throw new Error("Invalid lock owner");
        try { process.kill(owner.pid, 0); return null; }
        catch (error: any) { if (error.code !== "ESRCH") return null; }
      }
      rmSync(path, { recursive: true, force: true });
      create();
    } catch (error: any) { if (["EEXIST", "ENOENT"].includes(error.code)) return null; throw error; }
    finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      if (owner.token === token) rmSync(path, { recursive: true, force: true });
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  };
}

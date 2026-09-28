/** Quarantine receipts preserve inode evidence through commit, rollback and conflicts. */
import { closeSync, fstatSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { linkAt, openParent, renameAt, unlinkAt } from "@rae/fs-bridge";
import {
  absent,
  attached,
  code,
  readNamed,
  same,
  writeNoClobber,
  writeRecovery,
  type FileState,
} from "./io.js";

export type Hook = (point: string, relative?: string) => void | Promise<void>;
export interface Mutation {
  relative: string;
  expected: FileState;
  replacement: Buffer | null;
}
interface Receipt extends Mutation {
  parent: number;
  name: Buffer;
  oldQuarantine: string | null;
  installed: FileState;
  stage: "pending" | "captured" | "installed";
  retained: string[];
}
function quarantine(parent: number, name: Buffer): string | null {
  const temporary = `.profile-${randomUUID()}.quarantine`;
  try {
    renameAt(parent, name, parent, temporary);
    fsyncSync(parent);
    return temporary;
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}
function alias(parent: number, from: string, to: Buffer): boolean {
  try {
    linkAt(parent, from, parent, to);
    fsyncSync(parent);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST" || code(error) === "ENOTEMPTY") return false;
    throw error;
  }
}
function liveMatches(receipt: Receipt, expected: FileState): boolean {
  try {
    return same(readNamed(receipt.parent, receipt.name), expected);
  } catch {
    return false;
  }
}
function retain(receipt: Receipt, name: string | null): void {
  if (name && !receipt.retained.includes(name)) receipt.retained.push(name);
}
function preserveCompeting(receipt: Receipt, name: string | null): void {
  if (!name) return;
  alias(receipt.parent, name, receipt.name);
  retain(receipt, name);
}
function recovery(root: number, receipts: Receipt[], conflicts: string[], reason: string): string {
  const directory = `.rae-profile-recovery-${randomUUID().replaceAll("-", "")}`;
  const retained: Array<{ path: string; name: string; parent: { device: number; inode: number } }> =
    [];
  for (const receipt of receipts) {
    if (receipt.expected.exists)
      writeRecovery(root, `${directory}/before/${receipt.relative}`, receipt.expected.data);
    if (receipt.installed.exists)
      writeRecovery(root, `${directory}/installed/${receipt.relative}`, receipt.installed.data);
    for (const [index, name] of [receipt.oldQuarantine, ...receipt.retained]
      .filter((name): name is string => name !== null)
      .entries()) {
      const metadata = fstatSync(receipt.parent);
      retained.push({
        path: receipt.relative,
        name,
        parent: { device: metadata.dev, inode: metadata.ino },
      });
      try {
        const state = readNamed(receipt.parent, name);
        if (state.exists)
          writeRecovery(root, `${directory}/quarantine/${index}/${receipt.relative}`, state.data);
      } catch {
        /* Unsafe entries stay retained in place and are never followed. */
      }
    }
  }
  writeRecovery(
    root,
    `${directory}/RECOVERY.json`,
    Buffer.from(
      JSON.stringify(
        {
          reason,
          conflicts,
          retained_quarantines: retained,
          manual_recovery: "Compare before/, installed/, and quarantine/ before restoring.",
        },
        null,
        2,
      ) + "\n",
    ),
  );
  return directory;
}
async function apply(root: number, receipt: Receipt, action: string, hook: Hook): Promise<void> {
  if (!attached(root, receipt.relative, receipt.parent))
    throw new Error(`Managed parent changed: ${receipt.relative}`);
  await hook(`${action}-before-capture`, receipt.relative);
  if (receipt.expected.exists) {
    receipt.oldQuarantine = quarantine(receipt.parent, receipt.name);
    // A missing expected file belongs to a concurrent actor. Do not resurrect it.
    if (!receipt.oldQuarantine)
      throw new Error(`Managed file changed before mutation: ${receipt.relative}`);
    let actual: FileState;
    try {
      actual = readNamed(receipt.parent, receipt.oldQuarantine);
    } catch (error) {
      // A concurrent symlink or special file still owns its live pathname.
      // Restore only an alias, preserving the captured inode for recovery.
      preserveCompeting(receipt, receipt.oldQuarantine);
      receipt.oldQuarantine = null;
      throw error;
    }
    if (!same(actual, receipt.expected)) {
      preserveCompeting(receipt, receipt.oldQuarantine);
      receipt.oldQuarantine = null;
      throw new Error(`Managed file changed before mutation: ${receipt.relative}`);
    }
  }
  receipt.stage = "captured";
  if (receipt.replacement !== null) {
    await hook(`${action}-before-replacement`, receipt.relative);
    writeNoClobber(receipt.parent, receipt.name, receipt.replacement);
  }
  receipt.stage = "installed";
  await hook(`${action}-after-replacement`, receipt.relative);
  if (!attached(root, receipt.relative, receipt.parent))
    throw new Error(`Managed parent changed: ${receipt.relative}`);
  fsyncSync(receipt.parent);
}
function discardGuarded(receipt: Receipt, quarantineName: string, expected: FileState): boolean {
  if (!liveMatches(receipt, expected)) return false;
  unlinkAt(receipt.parent, quarantineName);
  fsyncSync(receipt.parent);
  return liveMatches(receipt, expected);
}
async function rollbackReceipt(root: number, receipt: Receipt, hook: Hook): Promise<boolean> {
  if (receipt.stage === "pending") return !receipt.oldQuarantine && receipt.retained.length === 0;
  let capture = quarantine(receipt.parent, receipt.name);
  let actual: FileState;
  try {
    actual = capture ? readNamed(receipt.parent, capture) : absent();
  } catch (error) {
    preserveCompeting(receipt, capture);
    throw error;
  }
  const expected = receipt.stage === "installed" ? receipt.installed : absent();
  if (!same(actual, expected) && !actual.exists) {
    const owned = receipt.retained.find((name) => same(readNamed(receipt.parent, name), expected));
    if (owned) {
      capture = owned;
      actual = readNamed(receipt.parent, owned);
      receipt.retained = receipt.retained.filter((name) => name !== owned);
    }
  }
  if (!same(actual, expected)) {
    preserveCompeting(receipt, capture);
    return false;
  }
  if (receipt.expected.exists) {
    if (receipt.oldQuarantine) {
      if (!alias(receipt.parent, receipt.oldQuarantine, receipt.name)) {
        retain(receipt, capture);
        return false;
      }
    } else {
      try {
        writeNoClobber(receipt.parent, receipt.name, receipt.expected.data);
      } catch {
        retain(receipt, capture);
        return false;
      }
    }
    await hook("rollback-after-hardlink-before-quarantine-unlink", receipt.relative);
  }
  if (!liveMatches(receipt, receipt.expected)) {
    retain(receipt, capture);
    return false;
  }
  if (receipt.oldQuarantine) {
    if (!discardGuarded(receipt, receipt.oldQuarantine, receipt.expected)) {
      retain(receipt, capture);
      return false;
    }
    receipt.oldQuarantine = null;
  }
  if (capture && !discardGuarded(receipt, capture, receipt.expected)) {
    retain(receipt, capture);
    return false;
  }
  return attached(root, receipt.relative, receipt.parent);
}
async function commit(
  root: number,
  receipts: Receipt[],
  action: string,
  hook: Hook,
): Promise<void> {
  const captures: Array<{ receipt: Receipt; name: string | null }> = [];
  for (const receipt of receipts) {
    const name = quarantine(receipt.parent, receipt.name);
    let actual: FileState;
    try {
      actual = name ? readNamed(receipt.parent, name) : absent();
    } catch (error) {
      preserveCompeting(receipt, name);
      throw error;
    }
    if (!same(actual, receipt.installed)) {
      preserveCompeting(receipt, name);
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
    }
    retain(receipt, name);
    captures.push({ receipt, name });
  }
  for (const { receipt, name } of captures) {
    await hook(`${action}-after-match-before-unlink`, receipt.relative);
    if (name && !alias(receipt.parent, name, receipt.name))
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
    if (name)
      await hook(`${action}-commit-after-hardlink-before-quarantine-unlink`, receipt.relative);
    if (
      !attached(root, receipt.relative, receipt.parent) ||
      !liveMatches(receipt, receipt.installed)
    )
      throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
  }
  for (const { receipt, name } of captures) {
    if (name) {
      if (!discardGuarded(receipt, name, receipt.installed))
        throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
      receipt.retained = receipt.retained.filter((value) => value !== name);
    }
    if (receipt.oldQuarantine) {
      if (!discardGuarded(receipt, receipt.oldQuarantine, receipt.installed))
        throw new Error(`Concurrent edit prevented commit: ${receipt.relative}`);
      receipt.oldQuarantine = null;
    }
  }
}
export async function transact(
  root: number,
  mutations: Mutation[],
  action: "install" | "uninstall",
  hook: Hook = () => {},
): Promise<void> {
  const receipts: Receipt[] = [];
  try {
    for (const mutation of mutations) {
      if (mutation.relative === ".rae-profile-install.json") await hook(`${action}-after-files`);
      const parent = openParent(root, mutation.relative, mutation.replacement !== null);
      const receipt: Receipt = {
        ...mutation,
        parent: parent.fd,
        name: parent.name,
        oldQuarantine: null,
        installed: {
          exists: mutation.replacement !== null,
          data: mutation.replacement ?? Buffer.alloc(0),
        },
        stage: "pending",
        retained: [],
      };
      receipts.push(receipt);
      await apply(root, receipt, action, hook);
    }
    await commit(root, receipts, action, hook);
  } catch (error) {
    const conflicts: string[] = [];
    for (const receipt of [...receipts].reverse()) {
      try {
        if (!(await rollbackReceipt(root, receipt, hook))) conflicts.push(receipt.relative);
      } catch {
        conflicts.push(receipt.relative);
      }
    }
    if (conflicts.length) {
      const retained = recovery(
        root,
        receipts,
        conflicts,
        "concurrent modification prevented rollback",
      );
      throw new Error(
        `Concurrent edit prevented rollback; recovery retained at ${retained}/RECOVERY.json`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    for (const receipt of receipts) closeSync(receipt.parent);
  }
}

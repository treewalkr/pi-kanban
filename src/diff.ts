import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanError, type Attachment, type KanbanDb } from "./db";

/** One unified diff between two stored versions of a card file. */
export interface CardFileDiff {
  name: string; // the card-file name (kind)
  from: Attachment; // older version row
  to: Attachment; // newer version row
  patch: string; // unified patch, "" when identical
}

/**
 * Diff two texts via `git diff --no-index` over temp files named after their labels.
 * Exit 0 = identical, 1 = differences (the patch), anything else or a thrown spawn
 * (git missing) = unsupported.
 */
export function textDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): { supported: boolean; patch: string } {
  const tmp = mkdtempSync(join(tmpdir(), "kanban-diff-"));
  try {
    writeFileSync(join(tmp, oldLabel), oldText);
    writeFileSync(join(tmp, newLabel), newText);
    const res = Bun.spawnSync({
      cmd: ["git", "diff", "--no-index", "--unified=3", "--no-color", "--", oldLabel, newLabel],
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode === 0) return { supported: true, patch: "" };
    if (res.exitCode === 1) return { supported: true, patch: res.stdout.toString() };
    return { supported: false, patch: "" };
  } catch {
    return { supported: false, patch: "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Diff two versions of a card file; default pair = latest adjacent (to = max, from = max-1).
 * Throws KanbanError with self-correcting messages (same wording family as `cat`).
 */
export function cardFileDiff(
  db: KanbanDb,
  taskRef: string,
  kind: string,
  from?: number,
  to?: number,
): CardFileDiff {
  const versions = db.attachments(taskRef, kind); // unknown card throws not-found via resolveTask
  if (versions.length === 0) {
    const names = db.latestFiles(taskRef).map((f) => f.kind);
    throw new KanbanError(`no file '${kind}' on card — files: ${names.join(", ") || "(none)"}`, "not-found");
  }
  if (versions.length === 1) throw new KanbanError(`only v1 of '${kind}' — nothing to diff`, "conflict");
  const max = versions.at(-1)!.version;
  const toV = to ?? max;
  const fromV = from ?? toV - 1;
  for (const v of [fromV, toV]) {
    if (!versions.some((x) => x.version === v))
      throw new KanbanError(`no v${v} of '${kind}' — versions v1–v${max}`, "not-found");
  }
  if (fromV >= toV)
    throw new KanbanError(`invalid range: v${fromV} → v${toV} (from must be lower than to)`, "invalid");
  const fromRow = versions.find((x) => x.version === fromV)!;
  const toRow = versions.find((x) => x.version === toV)!;
  const { supported, patch } = textDiff(fromRow.content, toRow.content, `v${fromV}`, `v${toV}`);
  if (!supported) throw new KanbanError(`git unavailable — cannot diff '${kind}'`, "conflict");
  return { name: kind, from: fromRow, to: toRow, patch };
}

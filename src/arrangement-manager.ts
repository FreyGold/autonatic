import { App, TFile, TFolder } from "obsidian";
import type { ArrangementMove, ArrangementPlan } from "./arrangement-planner";
import { validateArrangementMoves } from "./arrangement-planner";
import { isRecord } from "./type-guards";

export interface ArrangementSnapshot {
  id: string;
  createdAt: number;
  instruction: string;
  scope: string;
  entries: { originalPath: string; currentPath: string }[];
  createdFolders: string[];
}

function isArrangementSnapshot(value: unknown): value is ArrangementSnapshot {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.createdFolders)) return false;
  return typeof value.id === "string" && typeof value.createdAt === "number"
    && typeof value.instruction === "string" && typeof value.scope === "string"
    && value.entries.every((entry: unknown) => isRecord(entry)
      && typeof entry.originalPath === "string" && typeof entry.currentPath === "string")
    && value.createdFolders.every((path: unknown) => typeof path === "string");
}

type MoveProgress = (completed: number, total: number, stage: string) => void;

export class VaultArrangementManager {
  private snapshots: ArrangementSnapshot[] = [];
  private saveQueue: Promise<void> = Promise.resolve();
  private busy = false;
  private readonly storagePath: string;

  constructor(private app: App, pluginId: string) {
    this.storagePath = `${app.vault.configDir}/plugins/${pluginId}/arrangement-snapshots.json`;
  }

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(this.storagePath)) return;
    const raw = JSON.parse(await adapter.read(this.storagePath)) as { version?: unknown; snapshots?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.snapshots)) {
      throw new Error("Arrangement snapshots have an unsupported format.");
    }
    if (!raw.snapshots.every(isArrangementSnapshot)) {
      throw new Error("Arrangement snapshots are damaged. No snapshots were overwritten.");
    }
    this.snapshots = raw.snapshots;
  }

  list(): ArrangementSnapshot[] {
    return this.snapshots.map((snapshot) => ({
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry })),
      createdFolders: [...snapshot.createdFolders],
    }));
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, snapshots: this.snapshots });
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.app.vault.adapter.write(this.storagePath, payload));
    return this.saveQueue;
  }

  /** Track later manual and plugin renames so older snapshots remain restorable. */
  async noteRenamed(oldPath: string, newPath: string, isFolder = false): Promise<void> {
    if (oldPath === newPath) return this.saveQueue;
    let changed = false;
    for (const snapshot of this.snapshots) {
      for (const entry of snapshot.entries) {
        if (entry.currentPath === oldPath || (isFolder && entry.currentPath.startsWith(`${oldPath}/`))) {
          entry.currentPath = `${newPath}${entry.currentPath.slice(oldPath.length)}`;
          changed = true;
        }
      }
    }
    return changed ? this.persist() : this.saveQueue;
  }

  async deleteSnapshot(id: string): Promise<void> {
    if (this.busy) throw new Error("Wait for the current arrangement to finish.");
    const before = this.snapshots.length;
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.id !== id);
    if (this.snapshots.length === before) throw new Error("Snapshot not found.");
    await this.persist();
  }

  private async ensureFolder(path: string, created: string[]): Promise<void> {
    if (!path) return;
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`${current} is a file, so it cannot be a folder.`);
      await this.app.vault.createFolder(current);
      created.push(current);
    }
  }

  private async removeEmptyFolders(paths: readonly string[]): Promise<void> {
    for (const path of [...new Set(paths)].sort((a, b) => b.split("/").length - a.split("/").length)) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.fileManager.trashFile(folder);
      }
    }
  }

  private preflight(moves: readonly ArrangementMove[], checkFreshness: boolean): { file: TFile; target: string }[] {
    const conflicts = validateArrangementMoves(this.app, moves);
    if (conflicts.length) throw new Error(`Cannot move notes: ${conflicts.slice(0, 3).join("; ")}`);
    return moves.map((move) => {
      const file = this.app.vault.getAbstractFileByPath(move.from);
      if (!(file instanceof TFile)) throw new Error(`The note ${move.from} is missing. Nothing was moved.`);
      if (checkFreshness && (file.stat.mtime !== move.mtime || file.stat.size !== move.size)) {
        throw new Error(`${move.from} changed after the preview. Plan the arrangement again.`);
      }
      return { file, target: move.to };
    });
  }

  private async execute(
    pending: { file: TFile; target: string }[],
    createdFolders: string[],
    log: { file: TFile; from: string; to: string }[],
    onProgress?: MoveProgress,
  ): Promise<void> {
    const total = pending.length;
    let completed = 0;
    let stageFolder = "";
    let stagedCount = 0;
    while (pending.length) {
      const sourcePaths = new Set(pending.map((item) => item.file.path));
      const nextIndex = pending.findIndex((item) => !sourcePaths.has(item.target));
      if (nextIndex >= 0) {
        const [item] = pending.splice(nextIndex, 1);
        await this.ensureFolder(item.target.split("/").slice(0, -1).join("/"), createdFolders);
        const from = item.file.path;
        await this.app.fileManager.renameFile(item.file, item.target);
        log.push({ file: item.file, from, to: item.target });
        await this.noteRenamed(from, item.target);
        completed++;
        onProgress?.(completed, total, "Moving notes");
        continue;
      }

      // A cycle such as A -> B and B -> A needs one temporary empty path.
      if (!stageFolder) {
        stageFolder = `__autonatic_arranging_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        await this.ensureFolder(stageFolder, createdFolders);
      }
      const item = pending[0];
      const temporary = `${stageFolder}/${++stagedCount}-${item.file.name}`;
      const from = item.file.path;
      await this.app.fileManager.renameFile(item.file, temporary);
      log.push({ file: item.file, from, to: temporary });
      await this.noteRenamed(from, temporary);
      onProgress?.(completed, total, "Resolving a path overlap");
    }
    if (stageFolder) {
      try { await this.removeEmptyFolders([stageFolder]); }
      catch (error) { console.warn("Could not remove the empty arrangement staging folder:", error); }
    }
  }

  private async rollBack(log: readonly { file: TFile; from: string; to: string }[]): Promise<void> {
    for (const step of [...log].reverse()) {
      await this.app.fileManager.renameFile(step.file, step.from);
      await this.noteRenamed(step.to, step.from);
    }
  }

  async apply(plan: ArrangementPlan, onProgress?: MoveProgress): Promise<ArrangementSnapshot> {
    if (this.busy) throw new Error("An arrangement is already in progress.");
    if (!plan.moves.length) throw new Error("The plan contains no moves.");
    this.busy = true;
    try {
      const pending = this.preflight(plan.moves, true);
      const snapshot: ArrangementSnapshot = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        createdAt: Date.now(),
        instruction: plan.instruction,
        scope: plan.scope,
        entries: this.app.vault.getMarkdownFiles().map((file) => ({ originalPath: file.path, currentPath: file.path })),
        createdFolders: [],
      };
      // Persistence must succeed before the first file is moved.
      this.snapshots.unshift(snapshot);
      try { await this.persist(); }
      catch (error) {
        this.snapshots = this.snapshots.filter((item) => item.id !== snapshot.id);
        throw error;
      }
      const log: { file: TFile; from: string; to: string }[] = [];
      const createdFolders: string[] = [];
      try {
        await this.execute(pending, createdFolders, log, onProgress);
        snapshot.createdFolders = createdFolders.filter((path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder);
        await this.persist();
        const sourceFolders = plan.moves.flatMap((move) => {
          const parts = move.from.split("/").slice(0, -1);
          return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
        });
        try { await this.removeEmptyFolders(sourceFolders); }
        catch (error) { console.warn("Could not remove every empty source folder:", error); }
        return this.list().find((item) => item.id === snapshot.id)!;
      } catch (error) {
        try {
          await this.rollBack(log);
          await this.removeEmptyFolders(createdFolders);
          this.snapshots = this.snapshots.filter((item) => item.id !== snapshot.id);
          await this.persist();
        } catch (rollbackError) {
          throw new Error(`Arrangement failed and could not fully roll back: ${String(rollbackError)}. The snapshot remains available.`, { cause: error });
        }
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }

  async restore(id: string, onProgress?: MoveProgress): Promise<number> {
    if (this.busy) throw new Error("An arrangement is already in progress.");
    this.busy = true;
    try {
      const snapshot = this.snapshots.find((item) => item.id === id);
      if (!snapshot) throw new Error("Snapshot not found.");
      const moves: ArrangementMove[] = snapshot.entries
        .filter((entry) => entry.currentPath !== entry.originalPath)
        .map((entry) => ({ from: entry.currentPath, to: entry.originalPath, reason: "Restore snapshot", mtime: 0, size: 0 }));
      if (!moves.length) return 0;
      const pending = this.preflight(moves, false);
      const log: { file: TFile; from: string; to: string }[] = [];
      const createdFolders: string[] = [];
      try {
        await this.execute(pending, createdFolders, log, onProgress);
        await this.persist();
        try { await this.removeEmptyFolders(snapshot.createdFolders); }
        catch (error) { console.warn("Could not remove every empty arrangement folder:", error); }
        return moves.length;
      } catch (error) {
        try {
          await this.rollBack(log);
          await this.removeEmptyFolders(createdFolders);
        } catch (rollbackError) {
          throw new Error(`Restore stopped and could not fully roll back: ${String(rollbackError)}. The snapshot remains available.`, { cause: error });
        }
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }
}

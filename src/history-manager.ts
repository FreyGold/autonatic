import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { NoteStyle } from "./prompts";

export interface FileSnapshot {
  path: string;
  isNewFile: boolean;
  previousContent?: string;
  newContent: string;
}

export interface GenerationHistoryRecord {
  id: string;
  timestamp: number;
  mode: string;
  description: string;
  files: FileSnapshot[];
  foldersCreated: string[];
}

export interface PromptHistoryItem {
  id: string;
  timestamp: number;
  rawText: string;
  customInstruction: string;
  mode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append";
  style: NoteStyle;
  attachedImages?: { id: string; name: string; dataUrl: string }[];
  preview: string;
}

export class HistoryConflictError extends Error {
  constructor(path: string, action: "undo" | "redo") {
    super(`Cannot ${action} "${path}" because it changed after generation.`);
    this.name = "HistoryConflictError";
  }
}

async function readFileContent(app: App, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  return file instanceof TFile ? app.vault.read(file) : null;
}

async function validateSnapshots(
  app: App,
  files: FileSnapshot[],
  direction: "undo" | "redo"
): Promise<void> {
  const states = new Map<string, string | null>();
  const ordered = direction === "undo" ? [...files].reverse() : files;

  for (const snapshot of ordered) {
    const path = normalizePath(snapshot.path);
    let current = states.get(path);
    if (!states.has(path)) {
      current = await readFileContent(app, path);
    }

    if (direction === "undo") {
      if (current !== snapshot.newContent) {
        throw new HistoryConflictError(path, direction);
      }
      if (!snapshot.isNewFile && snapshot.previousContent === undefined) {
        throw new HistoryConflictError(path, direction);
      }
      states.set(path, snapshot.isNewFile ? null : snapshot.previousContent!);
    } else {
      const expected = snapshot.isNewFile ? null : snapshot.previousContent;
      if (current !== expected) {
        throw new HistoryConflictError(path, direction);
      }
      states.set(path, snapshot.newContent);
    }
  }
}

async function applySnapshotUndo(app: App, snapshot: FileSnapshot): Promise<void> {
  const path = normalizePath(snapshot.path);
  const file = app.vault.getAbstractFileByPath(path);

  if (snapshot.isNewFile) {
    if (!(file instanceof TFile) || (await app.vault.read(file)) !== snapshot.newContent) {
      throw new HistoryConflictError(path, "undo");
    }
    await app.fileManager.trashFile(file);
    return;
  }

  if (!(file instanceof TFile) || snapshot.previousContent === undefined) {
    throw new HistoryConflictError(path, "undo");
  }
  await app.vault.process(file, (current) => {
    if (current !== snapshot.newContent) throw new HistoryConflictError(path, "undo");
    return snapshot.previousContent!;
  });
}

async function applySnapshotRedo(app: App, snapshot: FileSnapshot): Promise<void> {
  const path = normalizePath(snapshot.path);
  const file = app.vault.getAbstractFileByPath(path);

  if (snapshot.isNewFile) {
    if (file) throw new HistoryConflictError(path, "redo");
    await app.vault.create(path, snapshot.newContent);
    return;
  }

  if (!(file instanceof TFile) || snapshot.previousContent === undefined) {
    throw new HistoryConflictError(path, "redo");
  }
  await app.vault.process(file, (current) => {
    if (current !== snapshot.previousContent) throw new HistoryConflictError(path, "redo");
    return snapshot.newContent;
  });
}

export async function revertFileSnapshots(
  app: App,
  files: FileSnapshot[],
  foldersCreated: string[] = []
): Promise<void> {
  await validateSnapshots(app, files, "undo");
  const applied: FileSnapshot[] = [];

  try {
    for (const snapshot of [...files].reverse()) {
      await applySnapshotUndo(app, snapshot);
      applied.push(snapshot);
    }
  } catch (error) {
    for (const snapshot of [...applied].reverse()) {
      try {
        await applySnapshotRedo(app, snapshot);
      } catch (restoreError) {
        console.error("Failed to restore a file after an undo error:", restoreError);
      }
    }
    throw error;
  }

  for (const folderPath of [...foldersCreated].reverse()) {
    const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (folder instanceof TFolder && folder.children.length === 0) {
      try {
        await app.fileManager.trashFile(folder);
      } catch (error) {
        console.warn(`Could not remove empty generated folder "${folderPath}":`, error);
      }
    }
  }
}

async function reapplyFileSnapshots(
  app: App,
  files: FileSnapshot[],
  foldersCreated: string[] = []
): Promise<void> {
  await validateSnapshots(app, files, "redo");

  for (const folderPath of foldersCreated) {
    const path = normalizePath(folderPath);
    if (!app.vault.getAbstractFileByPath(path)) {
      await app.vault.createFolder(path);
    }
  }

  const applied: FileSnapshot[] = [];
  try {
    for (const snapshot of files) {
      await applySnapshotRedo(app, snapshot);
      applied.push(snapshot);
    }
  } catch (error) {
    for (const snapshot of [...applied].reverse()) {
      try {
        await applySnapshotUndo(app, snapshot);
      } catch (restoreError) {
        console.error("Failed to restore a file after a redo error:", restoreError);
      }
    }
    throw error;
  }
}

export class HistoryManager {
  private app: App;
  private undoStack: GenerationHistoryRecord[] = [];
  private redoStack: GenerationHistoryRecord[] = [];
  private promptHistory: PromptHistoryItem[] = [];
  private readonly MAX_GENERATION_HISTORY = 3;
  private readonly MAX_PROMPT_HISTORY = 5;
  private onHistoryChange?: () => void;

  constructor(
    app: App,
    initialUndo: GenerationHistoryRecord[] = [],
    initialRedo: GenerationHistoryRecord[] = [],
    initialPrompts: PromptHistoryItem[] = [],
    onHistoryChange?: () => void
  ) {
    this.app = app;
    this.undoStack = initialUndo.slice(-this.MAX_GENERATION_HISTORY);
    this.redoStack = initialRedo.slice(-this.MAX_GENERATION_HISTORY);
    this.promptHistory = initialPrompts.slice(0, this.MAX_PROMPT_HISTORY);
    this.onHistoryChange = onHistoryChange;
  }

  public recordGeneration(record: GenerationHistoryRecord) {
    this.undoStack.push(record);
    if (this.undoStack.length > this.MAX_GENERATION_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.onHistoryChange?.();
  }

  public recordPrompt(item: PromptHistoryItem) {
    this.promptHistory.unshift(item);
    if (this.promptHistory.length > this.MAX_PROMPT_HISTORY) {
      this.promptHistory.pop();
    }
    this.onHistoryChange?.();
  }

  public getPromptHistory(): PromptHistoryItem[] {
    return [...this.promptHistory];
  }

  public getUndoCount(): number {
    return this.undoStack.length;
  }

  public getRedoCount(): number {
    return this.redoStack.length;
  }

  public getUndoRecords(): GenerationHistoryRecord[] {
    return [...this.undoStack];
  }

  public getRedoRecords(): GenerationHistoryRecord[] {
    return [...this.redoStack];
  }

  public async undo(): Promise<GenerationHistoryRecord | null> {
    const record = this.undoStack[this.undoStack.length - 1];
    if (!record) return null;

    await revertFileSnapshots(this.app, record.files, record.foldersCreated);
    this.undoStack.pop();

    this.redoStack.push(record);
    if (this.redoStack.length > this.MAX_GENERATION_HISTORY) {
      this.redoStack.shift();
    }
    this.onHistoryChange?.();
    return record;
  }

  public async redo(): Promise<GenerationHistoryRecord | null> {
    const record = this.redoStack[this.redoStack.length - 1];
    if (!record) return null;

    await reapplyFileSnapshots(this.app, record.files, record.foldersCreated);
    this.redoStack.pop();

    this.undoStack.push(record);
    if (this.undoStack.length > this.MAX_GENERATION_HISTORY) {
      this.undoStack.shift();
    }
    this.onHistoryChange?.();
    return record;
  }

  public serialize(): { undo: GenerationHistoryRecord[]; redo: GenerationHistoryRecord[]; prompts: PromptHistoryItem[] } {
    return {
      undo: this.undoStack,
      redo: this.redoStack,
      prompts: this.promptHistory,
    };
  }
}

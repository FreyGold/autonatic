import { App, TFile, TFolder, normalizePath } from "obsidian";

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
  mode: "smart" | "multi_note" | "new_file" | "append";
  style: "concise" | "detailed";
  attachedImages?: { id: string; name: string; dataUrl: string }[];
  preview: string;
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
    const record = this.undoStack.pop();
    if (!record) return null;

    for (const fileSnap of record.files) {
      const normalized = normalizePath(fileSnap.path);
      const abstractFile = this.app.vault.getAbstractFileByPath(normalized);

      if (fileSnap.isNewFile) {
        if (abstractFile instanceof TFile) {
          await this.app.vault.delete(abstractFile);
        }
      } else if (fileSnap.previousContent !== undefined) {
        if (abstractFile instanceof TFile) {
          await this.app.vault.modify(abstractFile, fileSnap.previousContent);
        } else {
          await this.app.vault.create(normalized, fileSnap.previousContent);
        }
      }
    }

    for (const folderPath of [...record.foldersCreated].reverse()) {
      const normalized = normalizePath(folderPath);
      const folder = this.app.vault.getAbstractFileByPath(normalized);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.vault.delete(folder);
      }
    }

    this.redoStack.push(record);
    if (this.redoStack.length > this.MAX_GENERATION_HISTORY) {
      this.redoStack.shift();
    }
    this.onHistoryChange?.();
    return record;
  }

  public async redo(): Promise<GenerationHistoryRecord | null> {
    const record = this.redoStack.pop();
    if (!record) return null;

    for (const folderPath of record.foldersCreated) {
      const normalized = normalizePath(folderPath);
      if (!this.app.vault.getAbstractFileByPath(normalized)) {
        await this.app.vault.createFolder(normalized);
      }
    }

    for (const fileSnap of record.files) {
      const normalized = normalizePath(fileSnap.path);
      const abstractFile = this.app.vault.getAbstractFileByPath(normalized);

      if (fileSnap.isNewFile) {
        if (abstractFile instanceof TFile) {
          await this.app.vault.modify(abstractFile, fileSnap.newContent);
        } else {
          await this.app.vault.create(normalized, fileSnap.newContent);
        }
      } else {
        if (abstractFile instanceof TFile) {
          await this.app.vault.modify(abstractFile, fileSnap.newContent);
        } else {
          await this.app.vault.create(normalized, fileSnap.newContent);
        }
      }
    }

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

import { Plugin, MarkdownView, Editor, Notice, TFile } from "obsidian";
import { NemotronPluginSettings, DEFAULT_SETTINGS, NemotronSettingTab } from "./settings";
import { NemotronModal } from "./modal";
import { generateNemotronNote } from "./api";
import { buildUserPrompt } from "./prompts";
import { buildOrUpdateVaultIndex, VAULT_INDEX_FILENAME } from "./vault-indexer";
import { FileSnapshot, HistoryManager, revertFileSnapshots } from "./history-manager";
import { createMirroredExcalidrawDrawing } from "./excalidraw-generator";

export default class NemotronPlugin extends Plugin {
  declare settings: NemotronPluginSettings;
  historyManager!: HistoryManager;
  private updateDebounceTimer: any = null;

  async onload() {
    await this.loadSettings();

    const storedHistory = (await this.loadData())?.history || { undo: [], redo: [], prompts: [] };
    this.historyManager = new HistoryManager(
      this.app,
      storedHistory.undo || [],
      storedHistory.redo || [],
      storedHistory.prompts || [],
      () => this.saveHistory()
    );

    this.addRibbonIcon("wand", "Nemotron Note Crafter", () => {
      new NemotronModal(this.app, this).open();
    });

    this.addCommand({
      id: "open-nemotron-modal",
      name: "Open Note Crafter Modal",
      callback: () => {
        new NemotronModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "open-excalidraw-diagram-tab",
      name: "Open Excalidraw Diagram Generator",
      callback: () => {
        new NemotronModal(this.app, this, "", "excalidraw").open();
      },
    });

    this.addCommand({
      id: "generate-rich-excalidraw-diagram",
      name: "Generate Rich Excalidraw Architecture Diagram for Active Note",
      callback: async () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
          new Notice("Please open a markdown note in the editor first.");
          return;
        }

        if (!this.settings.apiKey || !this.settings.apiKey.trim()) {
          new Notice("Please enter your NVIDIA API Key in Settings first.");
          return;
        }

        const noteFile = activeView.file;
        const noteContent = await this.app.vault.read(noteFile);
        const rootExcalFolder = this.settings.excalidrawFolder || "Excalidrawings";
        const fileSnapshots: FileSnapshot[] = [];
        let foldersCreated: string[] = [];
        let generationRecorded = false;

        new Notice("AI Synthesizing Rich Excalidraw Architecture Diagram...", 8000);

        try {
          const res = await createMirroredExcalidrawDrawing(
            this.app,
            this.settings,
            noteFile,
            noteContent,
            rootExcalFolder
          );
          fileSnapshots.push(res.fileSnapshot);
          foldersCreated = res.foldersCreated;

          // Insert Top Link in Active Note
          const noteFolder = noteFile.parent ? (noteFile.parent.path === "/" ? "" : noteFile.parent.path) : "";
          const excalRelPath = noteFolder
            ? `${rootExcalFolder}/${noteFolder}/${noteFile.basename}.excalidraw`
            : `${rootExcalFolder}/${noteFile.basename}.excalidraw`;

          const linkHeader = `> [!example] Visual Architecture Diagram\n> **Excalidraw Overview:** [[${excalRelPath}|${noteFile.basename} Architecture]]\n\n`;

          let updatedNoteText = noteContent;
          if (!noteContent.includes(excalRelPath)) {
            const yamlMatch = noteContent.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n*)/);
            if (yamlMatch) {
              const yamlBlock = yamlMatch[1];
              const rest = noteContent.slice(yamlBlock.length).trimStart();
              updatedNoteText = `${yamlBlock}${linkHeader}${rest}`;
            } else {
              updatedNoteText = `${linkHeader}${noteContent.trimStart()}`;
            }
            await this.app.vault.process(noteFile, (current) => {
              if (current !== noteContent) {
                throw new Error(`Cannot add the diagram link because "${noteFile.path}" changed.`);
              }
              return updatedNoteText;
            });
            fileSnapshots.push({
              path: noteFile.path,
              isNewFile: false,
              previousContent: noteContent,
              newContent: updatedNoteText,
            });
          }

          this.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "excalidraw",
            description: `Rich Excalidraw: ${noteFile.basename}`,
            files: fileSnapshots,
            foldersCreated,
          });
          generationRecorded = true;

          try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(res.drawingFile);
          } catch (openError) {
            console.warn(`Created "${res.drawingPath}" but could not open it:`, openError);
          }
          new Notice(`Rich Excalidraw diagram generated in ${res.drawingPath}!`, 7000);
          this.scheduleIndexUpdate();
        } catch (err: any) {
          if (!generationRecorded && fileSnapshots.length > 0) {
            try {
              await revertFileSnapshots(this.app, fileSnapshots, foldersCreated);
            } catch (rollbackError) {
              console.error("Failed to restore files after Excalidraw error:", rollbackError);
            }
          }
          console.error("Excalidraw generation error:", err);
          new Notice(`Error generating diagram: ${err.message}`);
        }
      },
    });

    this.addCommand({
      id: "undo-last-generation",
      name: "Undo Last Generation",
      callback: async () => {
        try {
          const record = await this.historyManager.undo();
          if (record) {
            new Notice(`Undid generation: ${record.description}`);
            this.scheduleIndexUpdate();
          } else {
            new Notice("No generations to undo.");
          }
        } catch (err: any) {
          new Notice(err.message || "The generation cannot be undone safely.", 8000);
        }
      },
    });

    this.addCommand({
      id: "redo-last-generation",
      name: "Redo Last Generation",
      callback: async () => {
        try {
          const record = await this.historyManager.redo();
          if (record) {
            new Notice(`Redid generation: ${record.description}`);
            this.scheduleIndexUpdate();
          } else {
            new Notice("No generations to redo.");
          }
        } catch (err: any) {
          new Notice(err.message || "The generation cannot be redone safely.", 8000);
        }
      },
    });

    this.addCommand({
      id: "transform-selection-nemotron",
      name: "Transform Selected Text to Structured Note",
      editorCallback: async (editor: Editor, view) => {
        const selection = editor.getSelection();
        if (!selection || !selection.trim()) {
          new Notice("Please select text to transform with Nemotron.");
          return;
        }

        new Notice("Generating Nemotron Note from Selection...");

        const existingVaultNotes = this.app.vault
          .getMarkdownFiles()
          .map((f) => f.basename)
          .filter((b) => b && !b.startsWith("."));

        const prompt = buildUserPrompt(
          selection,
          "append",
          this.settings.defaultNoteStyle || "concise",
          undefined,
          existingVaultNotes,
          undefined,
          this.settings.enableProperties ?? true
        );

        try {
          const result = await generateNemotronNote(
            this.settings,
            prompt,
            undefined,
            this.settings.defaultNoteStyle || "concise"
          );
          
          if (view.file) {
            const currentContent = editor.getValue();
            editor.replaceSelection(result.content);
            const updatedContent = editor.getValue();

            this.historyManager.recordGeneration({
              id: `${Date.now()}`,
              timestamp: Date.now(),
              mode: "selection",
              description: `Editor selection transformation in ${view.file.basename}`,
              files: [
                {
                  path: view.file.path,
                  isNewFile: false,
                  previousContent: currentContent,
                  newContent: updatedContent,
                },
              ],
              foldersCreated: [],
            });
          } else {
            editor.replaceSelection(result.content);
          }

          new Notice("Replaced selection with Nemotron Note!");
          this.scheduleIndexUpdate();
        } catch (err: any) {
          console.error("Nemotron Note Crafter Selection Error:", err);
          new Notice(`Error: ${err.message}`);
        }
      },
    });

    this.addCommand({
      id: "rebuild-vault-knowledge-index",
      name: "Deep Analyze & Rebuild Knowledge Tree Index",
      callback: async () => {
        new Notice("Deep analyzing vault knowledge tree...");
        const index = await buildOrUpdateVaultIndex(this.app, this.settings);
        new Notice(`Knowledge tree indexed: ${index.totalNotes} notes across ${index.totalFolders} folders.`);
      },
    });

    this.registerEvent(this.app.vault.on("create", () => this.scheduleIndexUpdate()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME) {
        this.scheduleIndexUpdate();
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME) {
        this.scheduleIndexUpdate();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleIndexUpdate()));

    this.addSettingTab(new NemotronSettingTab(this.app, this));
  }

  public async scheduleIndexUpdate() {
    try {
      if (!this.settings.enableAutomaticIndexing) return;
      const exists = await this.app.vault.adapter.exists(VAULT_INDEX_FILENAME);
      if (!exists) return;

      if (this.updateDebounceTimer) {
        clearTimeout(this.updateDebounceTimer);
      }

      this.updateDebounceTimer = setTimeout(() => {
        buildOrUpdateVaultIndex(this.app, this.settings).catch((e) => {
          console.warn("Background vault index sync error:", e);
        });
      }, 1500);
    } catch {}
  }

  private async saveHistory() {
    const currentData = (await this.loadData()) || {};
    currentData.history = this.historyManager.serialize();
    await this.saveData(currentData);
  }

  onunload() {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    const currentData = (await this.loadData()) || {};
    Object.assign(currentData, this.settings);
    await this.saveData(currentData);
  }
}

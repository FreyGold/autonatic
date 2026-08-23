import { Plugin, MarkdownView, Editor, Notice } from "obsidian";
import { NemotronPluginSettings, DEFAULT_SETTINGS, NemotronSettingTab } from "./settings";
import { NemotronModal } from "./modal";
import { generateNemotronNote } from "./api";
import { buildUserPrompt } from "./prompts";
import { buildOrUpdateVaultIndex, VAULT_INDEX_FILENAME } from "./vault-indexer";
import { HistoryManager, GenerationHistoryRecord } from "./history-manager";

export default class NemotronPlugin extends Plugin {
  settings: NemotronPluginSettings;
  historyManager: HistoryManager;
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
      id: "undo-last-generation",
      name: "Undo Last Generation",
      callback: async () => {
        const record = await this.historyManager.undo();
        if (record) {
          new Notice(`Undid generation: ${record.description}`);
          this.scheduleIndexUpdate();
        } else {
          new Notice("No generations to undo.");
        }
      },
    });

    this.addCommand({
      id: "redo-last-generation",
      name: "Redo Last Generation",
      callback: async () => {
        const record = await this.historyManager.redo();
        if (record) {
          new Notice(`Redid generation: ${record.description}`);
          this.scheduleIndexUpdate();
        } else {
          new Notice("No generations to redo.");
        }
      },
    });

    this.addCommand({
      id: "transform-selection-nemotron",
      name: "Transform Selected Text to Structured Note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
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
            const currentContent = await this.app.vault.read(view.file);
            editor.replaceSelection(result.content);
            const updatedContent = await this.app.vault.read(view.file);

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

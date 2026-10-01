import { Plugin, MarkdownView, Editor, Notice, TFile, TFolder } from "obsidian";
import {
  NemotronPluginSettings,
  DEFAULT_SETTINGS,
  NemotronSettingTab,
} from "./settings";
import { resolveTextModel } from "./model-defaults";
import { NemotronModal } from "./modal";
import { generateNemotronNote } from "./api";
import { buildSelectionEditPrompt, buildUserPrompt, SelectionEditAction } from "./prompts";
import { buildOrUpdateVaultIndex, VAULT_INDEX_FILENAME } from "./vault-indexer";
import { FileSnapshot, HistoryManager, revertFileSnapshots } from "./history-manager";
import { createMirroredExcalidrawDrawing } from "./excalidraw-generator";
import { CapturedSelection, captureEditorSelection, replaceCapturedSelection } from "./selection-editor";
import { AskNotesSearch } from "./ask-notes-search";
import { AskNotesModal } from "./ask-notes-modal";
import { VaultArrangementManager } from "./arrangement-manager";
import { VaultArrangementModal } from "./arrangement-modal";

export default class NemotronPlugin extends Plugin {
  declare settings: NemotronPluginSettings;
  historyManager!: HistoryManager;
  askNotesSearch!: AskNotesSearch;
  arrangementManager!: VaultArrangementManager;
  arrangementError: string | null = null;
  private updateDebounceTimer: any = null;
  private askNotesDebounceTimer: any = null;
  private selectionEditInProgress = false;

  async onload() {
    await this.loadSettings();
    this.askNotesSearch = new AskNotesSearch(this.app, () => this.settings);
    this.arrangementManager = new VaultArrangementManager(this.app, this.manifest.id);
    try { await this.arrangementManager.load(); }
    catch (error) {
      this.arrangementError = error instanceof Error ? error.message : "Could not read arrangement snapshots.";
      console.error("Could not load arrangement snapshots:", error);
    }

    const storedHistory = (await this.loadData())?.history || { undo: [], redo: [], prompts: [] };
    this.historyManager = new HistoryManager(
      this.app,
      storedHistory.undo || [],
      storedHistory.redo || [],
      storedHistory.prompts || [],
      () => this.saveHistory()
    );

    this.addRibbonIcon("wand", "autonatic", () => {
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
      id: "ask-notes",
      name: "Ask Notes",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "h" }],
      callback: () => new AskNotesModal(this.app, this).open(),
    });

    this.addCommand({
      id: "organize-vault-notes",
      name: "Organize Notes and Manage Arrangement Snapshots",
      callback: () => new VaultArrangementModal(this.app, this).open(),
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
          new Notice("Please enter your NVIDIA NIM API key in Settings first.");
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

    const addSelectionCommand = (id: string, name: string, action: SelectionEditAction) => {
      this.addCommand({
        id,
        name,
        editorCallback: async (editor: Editor, view) => {
          await this.editSelectionWithAi(editor, view.file, action);
        },
      });
    };
    addSelectionCommand("transform-selection-nemotron", "Improve Highlighted Text with AI", "improve");
    addSelectionCommand("expand-selection-nemotron", "Expand Highlighted Text with Details", "expand");
    addSelectionCommand("regenerate-selection-nemotron", "Regenerate Highlighted Text with AI", "regenerate");

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const captured = this.captureSelection(editor);
      if (!captured) return;

      menu.addSeparator();
      menu.addItem((item) => item.setTitle("autonatic: Improve highlighted text").setIcon("sparkles")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "improve", captured); }));
      menu.addItem((item) => item.setTitle("autonatic: Expand with details").setIcon("list-plus")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "expand", captured); }));
      menu.addItem((item) => item.setTitle("autonatic: Regenerate highlighted text").setIcon("refresh-cw")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "regenerate", captured); }));
    }));

    this.addCommand({
      id: "rebuild-vault-knowledge-index",
      name: "Deep Analyze & Rebuild Knowledge Tree Index",
      callback: async () => {
        new Notice("Deep analyzing vault knowledge tree...");
        const index = await buildOrUpdateVaultIndex(this.app, this.settings);
        new Notice(`Knowledge tree indexed: ${index.totalNotes} notes across ${index.totalFolders} folders.`);
      },
    });

    this.registerEvent(this.app.vault.on("create", () => { void this.scheduleIndexUpdate(); this.scheduleAskNotesUpdate(); }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME) {
        void this.scheduleIndexUpdate();
        this.scheduleAskNotesUpdate();
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME) {
        void this.scheduleIndexUpdate();
        this.scheduleAskNotesUpdate();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.arrangementManager.noteRenamed(oldPath, file.path, file instanceof TFolder).catch((error) => {
        console.error("Could not update arrangement snapshots after a rename:", error);
      });
      void this.scheduleIndexUpdate();
      this.scheduleAskNotesUpdate();
    }));

    this.app.workspace.onLayoutReady(() => this.scheduleAskNotesUpdate());

    this.addSettingTab(new NemotronSettingTab(this.app, this));
  }

  private captureSelection(editor: Editor): CapturedSelection | null {
    return captureEditorSelection(editor);
  }

  private async editSelectionWithAi(
    editor: Editor,
    file: TFile | null,
    action: SelectionEditAction,
    captured: CapturedSelection | null = this.captureSelection(editor),
  ): Promise<void> {
    if (!captured) {
      new Notice("Highlight text before you use an autonatic action.");
      return;
    }
    if (!this.settings.apiKey?.trim()) {
      new Notice("Enter your NVIDIA NIM API key in the plugin settings first.");
      return;
    }
    if (this.selectionEditInProgress) {
      new Notice("A highlighted-text edit is already in progress.");
      return;
    }

    const actionLabel: Record<SelectionEditAction, string> = {
      improve: "Improving",
      expand: "Expanding",
      regenerate: "Regenerating",
    };
    this.selectionEditInProgress = true;
    new Notice(`${actionLabel[action]} highlighted text...`, 5000);

    try {
      const result = await generateNemotronNote(
        this.settings,
        buildSelectionEditPrompt(captured.text, action),
        undefined,
        this.settings.defaultNoteStyle || "concise",
      );
      const replacement = result.content.trim();
      if (!replacement) throw new Error("The AI returned an empty replacement.");
      const updatedDocument = replaceCapturedSelection(editor, captured, replacement);
      if (file) {
        this.historyManager.recordGeneration({
          id: `${Date.now()}`,
          timestamp: Date.now(),
          mode: `selection_${action}`,
          description: `${actionLabel[action]} text in ${file.basename}`,
          files: [{
            path: file.path,
            isNewFile: false,
            previousContent: captured.document,
            newContent: updatedDocument,
          }],
          foldersCreated: [],
        });
      }
      new Notice("Highlighted text updated.");
      this.scheduleIndexUpdate();
    } catch (error: any) {
          console.error("AI highlighted-text edit error:", error);
      new Notice(error.message || "The highlighted text could not be updated.", 8000);
    } finally {
      this.selectionEditInProgress = false;
    }
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

  public scheduleAskNotesUpdate() {
    if (!this.settings.askNotesEnabled || this.settings.askNotesPaused) return;
    if (this.askNotesDebounceTimer) clearTimeout(this.askNotesDebounceTimer);
    this.askNotesDebounceTimer = setTimeout(() => {
      void this.askNotesSearch.sync().catch((error) => {
        console.warn("Ask Notes index update failed:", error);
      });
    }, 1500);
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
    if (this.askNotesDebounceTimer) clearTimeout(this.askNotesDebounceTimer);
    this.askNotesSearch?.dispose();
  }

  async loadSettings() {
    const savedSettings = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.settings.model = resolveTextModel(savedSettings.model);

    let settingsChanged = savedSettings.model !== this.settings.model;
    if (savedSettings.propertiesOptInVersion !== DEFAULT_SETTINGS.propertiesOptInVersion) {
      this.settings.enableProperties = false;
      this.settings.propertiesOptInVersion = DEFAULT_SETTINGS.propertiesOptInVersion;
      settingsChanged = true;
    }
    if (settingsChanged) await this.saveSettings();
  }

  async saveSettings() {
    const currentData = (await this.loadData()) || {};
    Object.assign(currentData, this.settings);
    await this.saveData(currentData);
  }
}

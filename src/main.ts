import { Plugin, MarkdownView, Editor, Notice, TFile, TFolder } from "obsidian";
import {
  NemotronPluginSettings,
  DEFAULT_SETTINGS,
  NemotronSettingTab,
} from "./settings";
import { applyProviderModelDefaults, getGenerationApiKey, PROVIDERS, type AIProvider } from "./providers";
import { NemotronModal } from "./modal";
import { generateSelectionEdit } from "./api";
import type { SelectionEditAction } from "./prompts";
import { migrateDefaultNotePrompts } from "./prompt-defaults";
import {
  buildOrUpdateVaultIndex,
  LEGACY_VAULT_INDEX_FILENAME,
  migrateVaultIndexStorage,
  VAULT_INDEX_FILENAME,
  vaultIndexPath,
} from "./vault-indexer";
import { FileSnapshot, HistoryManager, revertFileSnapshots, type GenerationHistoryRecord, type PromptHistoryItem } from "./history-manager";
import { isRecord } from "./type-guards";
import { createMirroredExcalidrawDrawing } from "./excalidraw-generator";
import { CapturedSelection, captureEditorSelection, replaceCapturedSelection } from "./selection-editor";
import { AskNotesSearch } from "./ask-notes-search";
import { AskNotesModal } from "./ask-notes-modal";
import { VaultArrangementManager } from "./arrangement-manager";
import { VaultArrangementModal } from "./arrangement-modal";
import { WorkspaceNavigation } from "./workspace-ui";
import { AUTONATIC_MARK_ICON, registerAutonaticIcons } from "./brand";

export default class NemotronPlugin extends Plugin {
  declare settings: NemotronPluginSettings;
  historyManager!: HistoryManager;
  askNotesSearch!: AskNotesSearch;
  arrangementManager!: VaultArrangementManager;
  arrangementError: string | null = null;
  workspaceNavigation = new WorkspaceNavigation();
  generationWorkspace?: NemotronModal;
  private updateDebounceTimer: number | null = null;
  private askNotesDebounceTimer: number | null = null;
  private selectionEditInProgress = false;

  async onload() {
    registerAutonaticIcons();
    this.workspaceNavigation.setFactory("create", () => new NemotronModal(this.app, this));
    this.workspaceNavigation.setFactory("search", () => new AskNotesModal(this.app, this));
    this.workspaceNavigation.setFactory("organize", () => new VaultArrangementModal(this.app, this));
    await this.loadSettings();
    try { await migrateVaultIndexStorage(this.app); }
    catch (error) { console.warn("Could not migrate the legacy vault index:", error); }
    this.askNotesSearch = new AskNotesSearch(this.app, () => this.settings);
    this.arrangementManager = new VaultArrangementManager(this.app, this.manifest.id);
    try { await this.arrangementManager.load(); }
    catch (error) {
      this.arrangementError = error instanceof Error ? error.message : "Could not read arrangement snapshots.";
      console.error("Could not load arrangement snapshots:", error);
    }

    const storedData = (await this.loadData()) as unknown;
    const storedHistory = isRecord(storedData) && isRecord(storedData.history)
      ? storedData.history : {};
    const undo = Array.isArray(storedHistory.undo) ? storedHistory.undo as GenerationHistoryRecord[] : [];
    const redo = Array.isArray(storedHistory.redo) ? storedHistory.redo as GenerationHistoryRecord[] : [];
    const prompts = Array.isArray(storedHistory.prompts) ? storedHistory.prompts as PromptHistoryItem[] : [];
    this.historyManager = new HistoryManager(
      this.app,
      undo,
      redo,
      prompts,
      () => { void this.saveHistory(); }
    );

    this.addRibbonIcon(AUTONATIC_MARK_ICON, "Open autonatic", () => {
      this.openWorkspace();
    });

    this.addCommand({
      id: "open-nemotron-modal",
      name: "Open note crafter modal",
      callback: () => {
        this.openWorkspace();
      },
    });

    this.addCommand({
      id: "open-excalidraw-diagram-tab",
      name: "Open Excalidraw diagram generator",
      callback: () => {
        this.openWorkspace("excalidraw");
      },
    });

    this.addCommand({
      id: "ask-notes",
      name: "Ask notes",
      callback: () => this.openWorkspace("notes", "search"),
    });

    this.addCommand({
      id: "organize-vault-notes",
      name: "Organize notes and manage arrangement snapshots",
      callback: () => this.openWorkspace("notes", "organize"),
    });

    this.addCommand({
      id: "generate-rich-excalidraw-diagram",
      name: "Generate rich Excalidraw architecture diagram for active note",
      callback: async () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
          new Notice("Please open a Markdown note in the editor first.");
          return;
        }

        if (!getGenerationApiKey(this.settings).trim()) {
          new Notice(`Please enter your ${PROVIDERS[this.settings.generationProvider].label} API key in Settings first.`);
          return;
        }

        const noteFile = activeView.file;
        const noteContent = await this.app.vault.read(noteFile);
        const rootExcalFolder = this.settings.excalidrawFolder || "Excalidrawings";
        const fileSnapshots: FileSnapshot[] = [];
        let foldersCreated: string[] = [];
        let generationRecorded = false;

        new Notice("AI synthesizing rich Excalidraw architecture diagram...", 8000);

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
          void this.scheduleIndexUpdate();
        } catch (err: unknown) {
          if (!generationRecorded && fileSnapshots.length > 0) {
            try {
              await revertFileSnapshots(this.app, fileSnapshots, foldersCreated);
            } catch (rollbackError) {
              console.error("Failed to restore files after Excalidraw error:", rollbackError);
            }
          }
          console.error("Excalidraw generation error:", err);
          new Notice(`Error generating diagram: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.addCommand({
      id: "undo-last-generation",
      name: "Undo last generation",
      callback: async () => {
        try {
          const record = await this.historyManager.undo();
          if (record) {
            new Notice(`Undid generation: ${record.description}`);
            void this.scheduleIndexUpdate();
          } else {
            new Notice("No generations to undo.");
          }
        } catch (err: unknown) {
          new Notice(err instanceof Error ? err.message : "The generation cannot be undone safely.", 8000);
        }
      },
    });

    this.addCommand({
      id: "redo-last-generation",
      name: "Redo last generation",
      callback: async () => {
        try {
          const record = await this.historyManager.redo();
          if (record) {
            new Notice(`Redid generation: ${record.description}`);
            void this.scheduleIndexUpdate();
          } else {
            new Notice("No generations to redo.");
          }
        } catch (err: unknown) {
          new Notice(err instanceof Error ? err.message : "The generation cannot be redone safely.", 8000);
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
      menu.addItem((item) => item.setTitle("Autonatic: Improve highlighted text").setIcon("sparkles")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "improve", captured); }));
      menu.addItem((item) => item.setTitle("Autonatic: Expand with details").setIcon("list-plus")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "expand", captured); }));
      menu.addItem((item) => item.setTitle("Autonatic: Regenerate highlighted text").setIcon("refresh-cw")
        .onClick(() => { void this.editSelectionWithAi(editor, info.file, "regenerate", captured); }));
    }));

    this.addCommand({
      id: "rebuild-vault-knowledge-index",
      name: "Deep analyze & rebuild knowledge tree index",
      callback: async () => {
        new Notice("Deep analyzing vault knowledge tree...");
        const index = await buildOrUpdateVaultIndex(this.app, this.settings);
        new Notice(`Knowledge tree indexed: ${index.totalNotes} notes across ${index.totalFolders} folders.`);
      },
    });

    this.registerEvent(this.app.vault.on("create", () => { void this.scheduleIndexUpdate(); this.scheduleAskNotesUpdate(); }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME && file.name !== LEGACY_VAULT_INDEX_FILENAME) {
        void this.scheduleIndexUpdate();
        this.scheduleAskNotesUpdate();
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.name !== VAULT_INDEX_FILENAME && file.name !== LEGACY_VAULT_INDEX_FILENAME) {
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

  public openWorkspace(tab: "notes" | "excalidraw" = "notes", page: "create" | "search" | "organize" = "create"): void {
    if (this.generationWorkspace) {
      this.generationWorkspace.reopenGeneration();
      return;
    }
    new NemotronModal(this.app, this, "", tab, page).open();
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
    if (!getGenerationApiKey(this.settings).trim()) {
      new Notice(`Enter your ${PROVIDERS[this.settings.generationProvider].label} API key in the plugin settings first.`);
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
      const result = await generateSelectionEdit(
        this.settings,
        captured.text,
        action,
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
      void this.scheduleIndexUpdate();
    } catch (error: unknown) {
          console.error("AI highlighted-text edit error:", error);
      new Notice(error instanceof Error ? error.message : "The highlighted text could not be updated.", 8000);
    } finally {
      this.selectionEditInProgress = false;
    }
  }

  public async scheduleIndexUpdate() {
    try {
      if (!this.settings.enableAutomaticIndexing) return;
      const exists = await this.app.vault.adapter.exists(vaultIndexPath(this.app));
      if (!exists) return;

      if (this.updateDebounceTimer) {
        window.clearTimeout(this.updateDebounceTimer);
      }

      this.updateDebounceTimer = window.setTimeout(() => {
        buildOrUpdateVaultIndex(this.app, this.settings).catch((e) => {
          console.warn("Background vault index sync error:", e);
        });
      }, 1500);
    } catch {
      // Automatic indexing is best-effort and will retry on the next vault change.
    }
  }

  public scheduleAskNotesUpdate() {
    if (!this.settings.askNotesEnabled || this.settings.askNotesPaused) return;
    if (this.askNotesDebounceTimer) window.clearTimeout(this.askNotesDebounceTimer);
    this.askNotesDebounceTimer = window.setTimeout(() => {
      void this.askNotesSearch.sync().catch((error) => {
        console.warn("Ask Notes index update failed:", error);
      });
    }, 1500);
  }

  private async saveHistory() {
    const loaded = (await this.loadData()) as unknown;
    const currentData: Record<string, unknown> = isRecord(loaded) ? loaded : {};
    currentData.history = this.historyManager.serialize();
    await this.saveData(currentData);
  }

  onunload() {
    this.generationWorkspace?.disposeGeneration();
    if (this.updateDebounceTimer) {
      window.clearTimeout(this.updateDebounceTimer);
    }
    if (this.askNotesDebounceTimer) window.clearTimeout(this.askNotesDebounceTimer);
    this.askNotesSearch?.dispose();
  }

  async loadSettings() {
    const savedSettings = ((await this.loadData()) as Partial<NemotronPluginSettings> | null) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.settings.providers = Object.assign({}, DEFAULT_SETTINGS.providers,
      Object.fromEntries(Object.entries(savedSettings.providers || {}).map(([provider, config]) => [
        provider, { ...DEFAULT_SETTINGS.providers[provider as keyof typeof DEFAULT_SETTINGS.providers], ...(config as object) },
      ])));
    this.settings.providers.nvidia = {
      ...this.settings.providers.nvidia,
      apiKey: this.settings.providers.nvidia.apiKey || savedSettings.apiKey || "",
      baseUrl: this.settings.providers.nvidia.baseUrl === DEFAULT_SETTINGS.providers.nvidia.baseUrl && savedSettings.baseUrl
        ? savedSettings.baseUrl : this.settings.providers.nvidia.baseUrl,
      model: this.settings.providers.nvidia.model || savedSettings.model || "",
      visionModel: this.settings.providers.nvidia.visionModel || savedSettings.visionModel || "",
    };
    if (!this.settings.generationProvider) this.settings.generationProvider = "nvidia";
    if (!this.settings.embeddingProvider) this.settings.embeddingProvider = "nvidia";
    let settingsChanged = migrateDefaultNotePrompts(this.settings);
    for (const provider of Object.keys(PROVIDERS) as AIProvider[]) {
      if (applyProviderModelDefaults(provider, this.settings.providers[provider])) settingsChanged = true;
    }
    this.settings.apiKey = this.settings.providers.nvidia.apiKey;
    this.settings.baseUrl = this.settings.providers.nvidia.baseUrl;
    this.settings.model = this.settings.providers.nvidia.model;
    this.settings.visionModel = this.settings.providers.nvidia.visionModel;
    if (savedSettings.visionModel && !savedSettings.providers?.nvidia?.visionModel) settingsChanged = true;
    if (savedSettings.propertiesOptInVersion !== DEFAULT_SETTINGS.propertiesOptInVersion) {
      this.settings.enableProperties = false;
      this.settings.propertiesOptInVersion = DEFAULT_SETTINGS.propertiesOptInVersion;
      settingsChanged = true;
    }
    if (typeof this.settings.defaultFolder !== "string" || !this.settings.defaultFolder.trim()) {
      this.settings.defaultFolder = DEFAULT_SETTINGS.defaultFolder;
      settingsChanged = true;
    }
    if (settingsChanged) await this.saveSettings();
  }

  async saveSettings() {
    const loaded = (await this.loadData()) as unknown;
    const currentData: Record<string, unknown> = isRecord(loaded) ? loaded : {};
    Object.assign(currentData, this.settings);
    await this.saveData(currentData);
  }
}

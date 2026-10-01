import { App, PluginSettingTab, Setting, Notice, TFolder } from "obsidian";
import type NemotronPlugin from "./main";
import { CONCISE_OBSIDIAN_SKILL_PROMPT, DETAILED_OBSIDIAN_SKILL_PROMPT, type NoteStyle } from "./prompts";
import { buildOrUpdateVaultIndex, loadVaultIndex } from "./vault-indexer";
import { DESTINATION_MODE_OPTIONS, type DestinationMode } from "./destination-modes";
import { DEFAULT_TEXT_MODEL } from "./model-defaults";
import { FolderNavigator } from "./folder-nav";

export interface NemotronPluginSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  defaultDestinationMode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append";
  defaultNoteStyle: NoteStyle;
  enableProperties: boolean;
  propertiesOptInVersion: number;
  enableExcalidrawMindMap: boolean;
  excalidrawFolder: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  enableThinking: boolean;
  defaultFolder: string;
  systemPrompt: string;
  detailedPrompt: string;
  autoOpenCreatedNote: boolean;
  enableAutomaticIndexing: boolean;
  allowRemoteVaultIndexing: boolean;
  excludedFolders: string;
  maxVaultContextNotes: number;
  confirmMultiFileChanges: boolean;
  maxAutomaticDiagrams: number;
  askNotesEnabled: boolean;
  askNotesPaused: boolean;
  askNotesFolders: string[];
}

export const DEFAULT_SETTINGS: NemotronPluginSettings = {
  apiKey: "",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  model: DEFAULT_TEXT_MODEL,
  visionModel: "meta/llama-3.2-11b-vision-instruct",
  defaultDestinationMode: "smart",
  defaultNoteStyle: "concise",
  enableProperties: false,
  propertiesOptInVersion: 1,
  enableExcalidrawMindMap: false,
  excalidrawFolder: "Excalidrawings",
  temperature: 1.0,
  topP: 0.95,
  maxTokens: 16384,
  enableThinking: true,
  defaultFolder: "",
  systemPrompt: CONCISE_OBSIDIAN_SKILL_PROMPT,
  detailedPrompt: DETAILED_OBSIDIAN_SKILL_PROMPT,
  autoOpenCreatedNote: true,
  enableAutomaticIndexing: false,
  allowRemoteVaultIndexing: false,
  excludedFolders: "Private, Templates",
  maxVaultContextNotes: 40,
  confirmMultiFileChanges: true,
  maxAutomaticDiagrams: 3,
  askNotesEnabled: false,
  askNotesPaused: false,
  askNotesFolders: [],
};

export class NemotronSettingTab extends PluginSettingTab {
  plugin: NemotronPlugin;
  private askFolderNavigator?: FolderNavigator;
  private unsubscribeAskStatus?: () => void;

  constructor(app: App, plugin: NemotronPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    this.askFolderNavigator?.destroy();
    this.unsubscribeAskStatus?.();
    containerEl.empty();

    containerEl.addClass("autonatic-settings");
    containerEl.createEl("h2", { text: "autonatic" });
    containerEl.createEl("h3", { text: "Privacy and cost" });
    new Setting(containerEl).setName("Automatic index updates").setDesc("Update the local vault index after a file changes.").addToggle((c) => c.setValue(this.plugin.settings.enableAutomaticIndexing).onChange(async (v) => { this.plugin.settings.enableAutomaticIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("AI summaries for placement index").setDesc("Send short excerpts to NVIDIA to summarize the local index. Automatic appends separately send the target note, or excerpts from a long target, for duplicate review. Ask Notes has separate consent below.").addToggle((c) => c.setValue(this.plugin.settings.allowRemoteVaultIndexing).onChange(async (v) => { this.plugin.settings.allowRemoteVaultIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Excluded folders").setDesc("Comma-separated folder paths that indexing must ignore.").addText((c) => c.setValue(this.plugin.settings.excludedFolders).onChange(async (v) => { this.plugin.settings.excludedFolders = v; await this.plugin.saveSettings(); this.plugin.scheduleAskNotesUpdate(); }));
    new Setting(containerEl).setName("Maximum context notes").setDesc("Limit the note summaries sent with one generation request.").addSlider((c) => c.setLimits(5, 100, 5).setValue(this.plugin.settings.maxVaultContextNotes).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxVaultContextNotes = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Confirm multi-file changes").setDesc("Show the planned file count before a multi-note write.").addToggle((c) => c.setValue(this.plugin.settings.confirmMultiFileChanges).onChange(async (v) => { this.plugin.settings.confirmMultiFileChanges = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Maximum automatic diagrams").setDesc("Limit useful diagrams created or updated after one note operation. Zero disables automatic diagrams.").addSlider((c) => c.setLimits(0, 10, 1).setValue(this.plugin.settings.maxAutomaticDiagrams).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxAutomaticDiagrams = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "NVIDIA NIM" });
    const apiKeySetting = new Setting(containerEl)
      .setName("NVIDIA NIM API Key")
      .setDesc("Your personal API key (starts with nvapi-...). Saved in this plugin's Obsidian settings.");

    let apiKeyInputEl: HTMLInputElement;

    apiKeySetting.addText((text) => {
      text
        .setPlaceholder("nvapi-...")
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          await this.plugin.saveSettings();
        });
      apiKeyInputEl = text.inputEl;
      apiKeyInputEl.type = "password";
      apiKeyInputEl.style.minWidth = "240px";
    });

    // Reveal / Mask toggle
    apiKeySetting.addButton((btn) => {
      btn.setButtonText("Show/Hide").setTooltip("Toggle visibility").onClick(() => {
        if (apiKeyInputEl) {
          apiKeyInputEl.type = apiKeyInputEl.type === "password" ? "text" : "password";
        }
      });
    });
    apiKeySetting.addButton((btn) => btn.setButtonText("Get key").onClick(() => {
      window.open("https://build.nvidia.com", "_blank");
    }));

    containerEl.createEl("h3", { text: "Ask Notes" });
    containerEl.createEl("p", {
      text: "Choose folders before enabling search. Indexing sends their Markdown text to NVIDIA for embeddings. Matching passages are shown unchanged. Exact term lookups can use the local index; natural-language questions also send your query to NVIDIA for semantic matching. API usage may incur charges. Vectors and excerpts stay in local device storage, outside the vault.",
      cls: "autonatic-settings-help",
    });
    const includedList = containerEl.createDiv({ cls: "autonatic-included-folders" });
    const renderIncluded = () => {
      includedList.empty();
      if (!this.plugin.settings.askNotesFolders.length) {
        includedList.createSpan({ text: "No folders selected", cls: "autonatic-settings-muted" });
      }
      for (const folder of this.plugin.settings.askNotesFolders) {
        const row = includedList.createDiv({ cls: "autonatic-included-folder" });
        row.createSpan({ text: folder || "Vault root (all folders)" });
        const remove = row.createEl("button", { text: "Remove" });
        remove.type = "button";
        remove.addEventListener("click", async () => {
          this.plugin.settings.askNotesFolders = this.plugin.settings.askNotesFolders.filter((path) => path !== folder);
          if (!this.plugin.settings.askNotesFolders.length) this.plugin.settings.askNotesEnabled = false;
          await this.plugin.saveSettings();
          if (!this.plugin.settings.askNotesEnabled) {
            try { await this.plugin.askNotesSearch.clear(); }
            catch (error) { new Notice(error instanceof Error ? error.message : "Could not clear local search data."); }
          }
          else this.plugin.scheduleAskNotesUpdate();
          renderIncluded();
        });
      }
    };
    renderIncluded();
    const folderPicker = containerEl.createDiv({ cls: "autonatic-folder-picker" });
    folderPicker.createEl("label", { text: "Add a folder and its subfolders" });
    let selectedFolder = "";
    this.askFolderNavigator = new FolderNavigator(this.app, folderPicker, "", (path) => { selectedFolder = path; });
    const addFolder = folderPicker.createEl("button", { text: "Include folder" });
    addFolder.type = "button";
    addFolder.addEventListener("click", async () => {
      if (selectedFolder && !(this.app.vault.getAbstractFileByPath(selectedFolder) instanceof TFolder)) {
        new Notice("Choose an existing folder.");
        return;
      }
      if (!this.plugin.settings.askNotesFolders.includes(selectedFolder)) {
        this.plugin.settings.askNotesFolders.push(selectedFolder);
        await this.plugin.saveSettings();
        this.plugin.scheduleAskNotesUpdate();
        renderIncluded();
      }
    });
    const askIndexStatus = containerEl.createDiv({ cls: "autonatic-settings-muted" });
    this.unsubscribeAskStatus = this.plugin.askNotesSearch.subscribe((message) => {
      askIndexStatus.setText(message);
      if (message.startsWith("Ready:")) void this.plugin.askNotesSearch.status().then((status) => {
        askIndexStatus.setText(`On this device: ${status.notes} notes, ${status.chunks} passages.`);
      });
    });
    void this.plugin.askNotesSearch.status().then((status) => {
      askIndexStatus.setText(`On this device: ${status.notes} notes, ${status.chunks} passages. ${status.message}`);
    }).catch((error: Error) => askIndexStatus.setText(error.message));
    new Setting(containerEl)
      .setName("Enable Ask Notes")
      .setDesc("Enable passage search. Selected notes are sent for indexing embeddings; semantic search sends only the query. No answer is generated.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.askNotesEnabled).onChange(async (enabled) => {
        if (enabled && (!this.plugin.settings.askNotesFolders.length || !this.plugin.settings.apiKey.trim())) {
          new Notice("Choose a folder and add your NVIDIA NIM API key first.");
          toggle.setValue(false);
          return;
        }
        this.plugin.settings.askNotesEnabled = enabled;
        await this.plugin.saveSettings();
        if (enabled) this.plugin.scheduleAskNotesUpdate();
        else {
          try { await this.plugin.askNotesSearch.clear(); }
          catch (error) { new Notice(error instanceof Error ? error.message : "Could not clear local search data."); }
        }
        await this.display();
      }));
    new Setting(containerEl)
      .setName("Pause background indexing")
      .setDesc("Keep the current local index but stop automatic updates.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.askNotesPaused).onChange(async (paused) => {
        this.plugin.settings.askNotesPaused = paused;
        await this.plugin.saveSettings();
        if (!paused) this.plugin.scheduleAskNotesUpdate();
      }));
    new Setting(containerEl)
      .setName("Local search index")
      .setDesc("Rebuild after a model or indexing problem, or clear all stored passages and vectors.")
      .addButton((button) => button.setButtonText("Rebuild").onClick(async () => {
        if (!this.plugin.settings.askNotesEnabled) { new Notice("Enable Ask Notes first."); return; }
        if (this.plugin.settings.askNotesPaused) { new Notice("Resume background indexing before rebuilding."); return; }
        button.setDisabled(true);
        try {
          await this.plugin.askNotesSearch.rebuild((message) => askIndexStatus.setText(message));
          await this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Indexing failed.", 7000);
          button.setDisabled(false);
        }
      }))
      .addButton((button) => button.setButtonText("Clear").onClick(async () => {
        this.plugin.settings.askNotesEnabled = false;
        await this.plugin.saveSettings();
        try { await this.plugin.askNotesSearch.clear(); }
        catch (error) { new Notice(error instanceof Error ? error.message : "Could not clear local search data."); }
        await this.display();
      }));

    // 1-Click Paste Button
    apiKeySetting.addButton((btn) => {
      btn.setButtonText("Paste").setTooltip("Paste API key from clipboard").onClick(async () => {
        let text = "";
        try {
          const electron = (window as any).require ? (window as any).require("electron") : null;
          if (electron && electron.clipboard) {
            text = electron.clipboard.readText();
          }
        } catch {}

        if (!text && navigator.clipboard && navigator.clipboard.readText) {
          try {
            text = await navigator.clipboard.readText();
          } catch {}
        }

        if (text && text.trim()) {
          this.plugin.settings.apiKey = text.trim();
          await this.plugin.saveSettings();
          if (apiKeyInputEl) {
            apiKeyInputEl.value = text.trim();
          }
          btn.setButtonText("Pasted!");
          setTimeout(() => btn.setButtonText("Paste"), 2000);
        }
      });
    });

    containerEl.createEl("h3", { text: "Note creation" });
    // Default Destination Mode
    new Setting(containerEl)
      .setName("Default note creation")
      .setDesc("Choose the starting creation and placement behavior when opening the Note Crafter.")
      .addDropdown((dropdown) => {
        for (const option of DESTINATION_MODE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        return dropdown
          .setValue(this.plugin.settings.defaultDestinationMode || "smart")
          .onChange(async (value) => {
            this.plugin.settings.defaultDestinationMode = value as DestinationMode;
            await this.plugin.saveSettings();
          });
      });

    // Vault Knowledge Index Status & Populate
    const indexData = await loadVaultIndex(this.app);
    const noteCount = indexData?.totalNotes || 0;
    const folderCount = indexData?.totalFolders || 0;

    new Setting(containerEl)
      .setName("Hierarchical Vault Knowledge Tree")
      .setDesc(
        `Used for placing generated notes. Separate from Ask Notes search. Status: ${
          indexData ? `Indexed ${noteCount} notes across ${folderCount} folders.` : "Not yet generated."
        }`
      )
      .addButton((btn) => {
        btn.setButtonText("Deep Analyze & Rebuild Knowledge Tree").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Analyzing notes with AI...");
          try {
            const updated = await buildOrUpdateVaultIndex(this.app, this.plugin.settings, (curr, total, status) => {
              btn.setButtonText(status.slice(0, 35) + "...");
            });
            new Notice(`Hierarchical Knowledge Tree indexed: ${updated.totalNotes} notes across ${updated.totalFolders} folders.`);
            await this.display();
          } catch (e: any) {
            new Notice(`Error during deep indexing: ${e.message}`);
            btn.setDisabled(false);
            btn.setButtonText("Deep Analyze & Rebuild Knowledge Tree");
          }
        });
      });

    // Useful Excalidraw diagram settings
    containerEl.createEl("h3", { text: "Useful Excalidraw Diagrams" });

    new Setting(containerEl)
      .setName("Create useful diagrams after note placement")
      .setDesc("Check completed note changes. Create or update a drawing only when it improves understanding. Other notes are skipped.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableExcalidrawMindMap ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableExcalidrawMindMap = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excalidraw Mirrored Root Folder")
      .setDesc("Root folder where mirrored Excalidraw diagrams are saved.")
      .addText((text) =>
        text
          .setPlaceholder("Excalidrawings")
          .setValue(this.plugin.settings.excalidrawFolder || "Excalidrawings")
          .onChange(async (value) => {
            this.plugin.settings.excalidrawFolder = value.trim() || "Excalidrawings";
            await this.plugin.saveSettings();
          })
      );

    // YAML Properties Generation Toggle
    new Setting(containerEl)
      .setName("Generate YAML Properties / Frontmatter")
      .setDesc("Opt in to generated YAML properties (title, tags, aliases, created, summary) at the top of notes. Off creates plain notes without frontmatter.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableProperties ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableProperties = value;
            await this.plugin.saveSettings();
          })
      );

    // Default Note Style
    new Setting(containerEl)
      .setName("Default Note Style")
      .setDesc("Choose the default output style. Bare is source-locked for pasted chat histories.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("concise", "Concise & Punchy (Smart Brevity)")
          .addOption("detailed", "Detailed & Comprehensive")
          .addOption("bare", "Bare (Source Only)")
          .setValue(this.plugin.settings.defaultNoteStyle || "concise")
          .onChange(async (value) => {
            this.plugin.settings.defaultNoteStyle = value as NoteStyle;
            await this.plugin.saveSettings();
          })
      );

    const advancedHeading = containerEl.createEl("h3", { text: "Advanced AI settings" });
    // Base URL
    new Setting(containerEl)
      .setName("API Base URL")
      .setDesc("The OpenAI-compatible base URL for the currently supported NVIDIA NIM provider.")
      .addText((text) =>
        text
          .setPlaceholder("https://integrate.api.nvidia.com/v1")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Text Model Name
    new Setting(containerEl)
      .setName("Text Model Name")
      .setDesc("Model identifier to use for note architecture and synthesis.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_TEXT_MODEL)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Vision Model Name
    new Setting(containerEl)
      .setName("Vision Model Name")
      .setDesc("Multimodal OCR model used to read and transcribe attached photos/screenshots.")
      .addText((text) =>
        text
          .setPlaceholder("meta/llama-3.2-11b-vision-instruct")
          .setValue(this.plugin.settings.visionModel)
          .onChange(async (value) => {
            this.plugin.settings.visionModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Enable Thinking / Reasoning
    new Setting(containerEl)
      .setName("Enable Thinking (Reasoning)")
      .setDesc("Enable deep reasoning tokens before generating structured notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableThinking)
          .onChange(async (value) => {
            this.plugin.settings.enableThinking = value;
            await this.plugin.saveSettings();
          })
      );

    // Temperature
    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Sampling temperature (0.0 - 2.0).")
      .addSlider((slider) =>
        slider
          .setLimits(0.0, 2.0, 0.05)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    // Top P
    new Setting(containerEl)
      .setName("Top P")
      .setDesc("Nucleus sampling probability (0.0 - 1.0).")
      .addSlider((slider) =>
        slider
          .setLimits(0.0, 1.0, 0.01)
          .setValue(this.plugin.settings.topP)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.topP = value;
            await this.plugin.saveSettings();
          })
      );

    // Max Tokens
    new Setting(containerEl)
      .setName("Max Generation Tokens")
      .setDesc("Maximum tokens for total generation.")
      .addText((text) =>
        text
          .setPlaceholder("16384")
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const parsed = parseInt(value);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxTokens = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    // Default Folder
    new Setting(containerEl)
      .setName("Fallback Default Folder")
      .setDesc("Fallback vault folder path (leave blank to auto-detect last modified note folder).")
      .addText((text) =>
        text
          .setPlaceholder("Auto-detected")
          .setValue(this.plugin.settings.defaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.defaultFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Auto-open created note
    new Setting(containerEl)
      .setName("Auto-open Created Notes")
      .setDesc("Automatically open newly created notes in the editor.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpenCreatedNote)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenCreatedNote = value;
            await this.plugin.saveSettings();
          })
      );

    // Concise Skill System Prompt
    new Setting(containerEl)
      .setName("Concise Skill Prompt")
      .setDesc("System instructions used for Concise mode.")
      .addTextArea((textArea) => {
        textArea
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 8;
        textArea.inputEl.cols = 50;
      });

    // Detailed Skill System Prompt
    new Setting(containerEl)
      .setName("Detailed Skill Prompt")
      .setDesc("System instructions used for Detailed mode.")
      .addTextArea((textArea) => {
        textArea
          .setValue(this.plugin.settings.detailedPrompt || DETAILED_OBSIDIAN_SKILL_PROMPT)
          .onChange(async (value) => {
            this.plugin.settings.detailedPrompt = value;
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 8;
        textArea.inputEl.cols = 50;
      });

    // Reset prompt button
    new Setting(containerEl)
      .setName("Reset Prompts to Default")
      .setDesc("Restore default Concise and Detailed Obsidian formatting prompts.")
      .addButton((btn) =>
        btn.setButtonText("Reset to Default").onClick(async () => {
          this.plugin.settings.systemPrompt = CONCISE_OBSIDIAN_SKILL_PROMPT;
          this.plugin.settings.detailedPrompt = DETAILED_OBSIDIAN_SKILL_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    const advancedDetails = containerEl.createEl("details", { cls: "autonatic-settings-advanced" });
    advancedDetails.createEl("summary", { text: "Advanced AI settings" });
    let next = advancedHeading.nextSibling;
    while (next && next !== advancedDetails) {
      const following = next.nextSibling;
      advancedDetails.appendChild(next);
      next = following;
    }
    advancedHeading.replaceWith(advancedDetails);
  }

  hide(): void {
    this.askFolderNavigator?.destroy();
    this.unsubscribeAskStatus?.();
    super.hide();
  }
}

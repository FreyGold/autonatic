import { App, PluginSettingTab, Setting, Notice, TFolder } from "obsidian";
import type NemotronPlugin from "./main";
import { CONCISE_OBSIDIAN_SKILL_PROMPT, DETAILED_OBSIDIAN_SKILL_PROMPT, type NoteStyle } from "./prompts";
import { buildOrUpdateVaultIndex, loadVaultIndex } from "./vault-indexer";
import { DESTINATION_MODE_OPTIONS, type DestinationMode } from "./destination-modes";
import { FolderNavigator } from "./folder-nav";
import { defaultProviderConfigs, EMBEDDING_PROVIDERS, fetchProviderModels, PROVIDERS, type AIProvider } from "./providers";
import type { SettingsSection } from "./workspace-ui";
import { renderAutonaticBrand } from "./brand";

export interface NemotronPluginSettings {
  generationProvider: AIProvider;
  embeddingProvider: AIProvider;
  providers: Record<AIProvider, { apiKey: string; baseUrl: string; model: string; embeddingModel: string; availableModels: string[]; availableEmbeddingModels: string[] }>;
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
  generationProvider: "nvidia",
  embeddingProvider: "nvidia",
  providers: defaultProviderConfigs(),
  apiKey: "",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  model: "",
  visionModel: "",
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
  private activeSection: SettingsSection = "providers";
  private navigationController?: AbortController;
  private renderVersion = 0;

  constructor(app: App, plugin: NemotronPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const root = this.containerEl;
    const renderVersion = ++this.renderVersion;
    this.askFolderNavigator?.destroy();
    this.unsubscribeAskStatus?.();
    this.navigationController?.abort();
    this.navigationController = new AbortController();
    root.empty();
    root.addClass("autonatic-settings");
    const heading = root.createDiv({ cls: "autonatic-settings-heading" });
    renderAutonaticBrand(heading, this.plugin.manifest.version);
    heading.createEl("p", { text: "Providers, note preferences, and vault permissions." });
    const nav = root.createDiv({ cls: "autonatic-settings-nav", attr: { role: "tablist", "aria-label": "Plugin settings" } });
    const sections = {} as Record<SettingsSection, HTMLElement>;
    const buttons = new Map<SettingsSection, HTMLButtonElement>();
    const selectSection = (section: SettingsSection) => {
      this.activeSection = section;
      for (const [id, button] of buttons) {
        const active = id === section;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
        sections[id].hidden = !active;
      }
    };
    const pages: Array<[SettingsSection, string]> = [["providers", "Providers"], ["creation", "Creation"], ["search", "Search"], ["privacy", "Privacy"], ["advanced", "Advanced"]];
    for (const [index, [id, label]] of pages.entries()) {
      const button = nav.createEl("button", { text: label, attr: { type: "button", role: "tab", id: `autonatic-settings-tab-${id}`, "aria-controls": `autonatic-settings-${id}` } });
      sections[id] = root.createEl("section", { cls: "autonatic-settings-section", attr: { role: "tabpanel", id: `autonatic-settings-${id}`, "aria-labelledby": button.id } });
      buttons.set(id, button);
      button.addEventListener("click", () => selectSection(id));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + pages.length) % pages.length;
        selectSection(pages[next][0]);
        buttons.get(pages[next][0])?.focus();
      });
    }
    selectSection(this.activeSection);
    document.addEventListener("autonatic:settings-section", ((event: CustomEvent<SettingsSection>) => {
      if (buttons.has(event.detail)) selectSection(event.detail);
    }) as EventListener, { signal: this.navigationController.signal });
    let containerEl = sections.privacy;
    containerEl.createEl("h3", { text: "Privacy and cost" });
    new Setting(containerEl).setName("Automatic index updates").setDesc("Update the local vault index after a file changes.").addToggle((c) => c.setValue(this.plugin.settings.enableAutomaticIndexing).onChange(async (v) => { this.plugin.settings.enableAutomaticIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("AI summaries for placement index").setDesc("Send short excerpts to the selected generation provider to summarize the local index. Automatic appends separately send the target note, or excerpts from a long target, for duplicate review. Search has separate consent in the Search settings.").addToggle((c) => c.setValue(this.plugin.settings.allowRemoteVaultIndexing).onChange(async (v) => { this.plugin.settings.allowRemoteVaultIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Excluded folders").setDesc("Comma-separated folder paths that indexing must ignore.").addText((c) => c.setValue(this.plugin.settings.excludedFolders).onChange(async (v) => { this.plugin.settings.excludedFolders = v; await this.plugin.saveSettings(); this.plugin.scheduleAskNotesUpdate(); }));
    new Setting(containerEl).setName("Maximum context notes").setDesc("Limit the note summaries sent with one generation request.").addSlider((c) => c.setLimits(5, 100, 5).setValue(this.plugin.settings.maxVaultContextNotes).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxVaultContextNotes = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Confirm multi-file changes").setDesc("Show the planned file count before a multi-note write.").addToggle((c) => c.setValue(this.plugin.settings.confirmMultiFileChanges).onChange(async (v) => { this.plugin.settings.confirmMultiFileChanges = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Maximum automatic diagrams").setDesc("Limit useful diagrams created or updated after one note operation. Zero disables automatic diagrams.").addSlider((c) => c.setLimits(0, 10, 1).setValue(this.plugin.settings.maxAutomaticDiagrams).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxAutomaticDiagrams = v; await this.plugin.saveSettings(); }));

    containerEl = sections.providers;
    containerEl.createEl("h3", { text: "AI providers" });
    new Setting(containerEl)
      .setName("Generation provider")
      .setDesc("Provider used for note generation, planning, diagrams, and image transcription.")
      .addDropdown((dropdown) => {
        for (const [id, provider] of Object.entries(PROVIDERS)) dropdown.addOption(id, provider.label);
        return dropdown.setValue(this.plugin.settings.generationProvider || "nvidia").onChange(async (value) => {
          this.plugin.settings.generationProvider = value as AIProvider;
          await this.plugin.saveSettings();
          this.display();
        });
      });
    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc("Used for Ask Notes semantic search. Claude and Groq do not provide compatible embedding APIs.")
      .addDropdown((dropdown) => {
        for (const provider of EMBEDDING_PROVIDERS) dropdown.addOption(provider, PROVIDERS[provider].label);
        return dropdown.setValue(this.plugin.settings.embeddingProvider || "nvidia").onChange(async (value) => {
          this.plugin.settings.embeddingProvider = value as AIProvider;
          await this.plugin.saveSettings();
          if (this.plugin.settings.askNotesEnabled) {
            await this.plugin.askNotesSearch.clear();
            const selected = this.plugin.settings.providers[value as AIProvider];
            if (selected.apiKey.trim() && selected.embeddingModel.trim()
              && selected.availableEmbeddingModels.includes(selected.embeddingModel)) {
              this.plugin.scheduleAskNotesUpdate();
            }
          }
          this.display();
        });
      });

    containerEl.createEl("h4", { text: "Provider credentials and models" });
    const providerEntries = Object.entries(PROVIDERS) as [AIProvider, typeof PROVIDERS[AIProvider]][];
    const providerOrder = (id: AIProvider) => id === this.plugin.settings.generationProvider ? 0 : id === this.plugin.settings.embeddingProvider ? 1 : 2;
    providerEntries.sort(([a], [b]) => providerOrder(a) - providerOrder(b));
    for (const [providerId, provider] of providerEntries) {
      const config = this.plugin.settings.providers[providerId];
      const details = containerEl.createEl("details", { cls: "autonatic-provider-settings" });
      details.open = providerId === this.plugin.settings.generationProvider || providerId === this.plugin.settings.embeddingProvider;
      details.createEl("summary", { text: provider.label });
      const invalidateProviderModels = async () => {
        const hadCatalog = config.availableModels.length > 0 || config.availableEmbeddingModels.length > 0;
        config.availableModels = [];
        config.availableEmbeddingModels = [];
        config.model = "";
        config.embeddingModel = "";
        if (providerId === "nvidia") this.plugin.settings.model = "";
        if (hadCatalog && this.plugin.settings.askNotesEnabled && this.plugin.settings.embeddingProvider === providerId) {
          await this.plugin.askNotesSearch.clear();
        }
      };
      let keyInput: HTMLInputElement;
      new Setting(details).setName("API key").setDesc("Stored in this plugin's Obsidian settings.").addText((text) => {
        text.setPlaceholder("Paste API key").setValue(config.apiKey).onChange(async (value) => {
          if (value.trim() !== config.apiKey) await invalidateProviderModels();
          config.apiKey = value.trim();
          if (providerId === "nvidia") this.plugin.settings.apiKey = config.apiKey;
          await this.plugin.saveSettings();
        });
        keyInput = text.inputEl;
        keyInput.type = "password";
      }).addButton((button) => button.setButtonText("Show/Hide").onClick(() => {
        keyInput.type = keyInput.type === "password" ? "text" : "password";
      })).addButton((button) => button.setButtonText("Get key").onClick(() => window.open(provider.keyUrl, "_blank")))
        .addButton((button) => button.setButtonText("Paste").onClick(async () => {
          try {
            const electron = (window as any).require?.("electron");
            const value = electron?.clipboard?.readText?.() || await navigator.clipboard?.readText?.() || "";
            if (value.trim()) {
              if (value.trim() !== config.apiKey) await invalidateProviderModels();
              config.apiKey = value.trim();
              if (providerId === "nvidia") this.plugin.settings.apiKey = config.apiKey;
              keyInput.value = config.apiKey;
              await this.plugin.saveSettings();
            }
          } catch { new Notice("Could not read the clipboard."); }
        }));
      new Setting(details).setName("Available models").setDesc("Fetch the models available to this API key. This request also checks that the key is accepted.")
        .addButton((button) => button.setButtonText("Test key & fetch models").onClick(async () => {
          const apiKey = keyInput.value.trim();
          if (!apiKey) { new Notice(`Enter a ${provider.label} API key first.`); return; }
          config.apiKey = apiKey;
          config.baseUrl = config.baseUrl.trim() || provider.baseUrl;
          if (providerId === "nvidia") this.plugin.settings.apiKey = apiKey;
          await this.plugin.saveSettings();
          button.setDisabled(true);
          button.setButtonText("Fetching…");
          try {
            const models = await fetchProviderModels(providerId, config.baseUrl, apiKey);
            config.availableModels = models.chat;
            config.availableEmbeddingModels = models.embeddings;
            if (config.model && !models.chat.includes(config.model)) {
              config.model = "";
              if (providerId === "nvidia") this.plugin.settings.model = "";
            }
            if (config.embeddingModel && !models.embeddings.includes(config.embeddingModel)) config.embeddingModel = "";
            await this.plugin.saveSettings();
            new Notice(`Key accepted. Found ${models.chat.length} chat models${EMBEDDING_PROVIDERS.includes(providerId) ? ` and ${models.embeddings.length} embedding models` : ""}.`);
            await this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not fetch provider models.", 7000);
            button.setDisabled(false);
            button.setButtonText("Test key & fetch models");
          }
        }));
      new Setting(details).setName("Chat model").setDesc("Choose a model returned by the provider. Fetch models after adding your key.").addDropdown((dropdown) => {
        dropdown.addOption("", config.availableModels.length ? "Select a model" : "Fetch models first");
        for (const model of config.availableModels) dropdown.addOption(model, model);
        return dropdown.setValue(config.availableModels.includes(config.model) ? config.model : "").onChange(async (value) => {
          config.model = value;
          if (providerId === "nvidia") this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });
      new Setting(details).setName("API base URL").setDesc("Change only when using a compatible custom endpoint.").addText((text) => text
        .setPlaceholder(provider.baseUrl).setValue(config.baseUrl).onChange(async (value) => {
          const nextUrl = value.trim() || provider.baseUrl;
          if (nextUrl !== config.baseUrl) await invalidateProviderModels();
          config.baseUrl = nextUrl;
          if (providerId === "nvidia") this.plugin.settings.baseUrl = config.baseUrl;
          await this.plugin.saveSettings();
        }));
      if (EMBEDDING_PROVIDERS.includes(providerId)) {
        new Setting(details).setName("Embedding model").setDesc("Choose an embedding model returned by the provider.").addDropdown((dropdown) => {
          dropdown.addOption("", config.availableEmbeddingModels.length ? "Select an embedding model" : "Fetch models first");
          for (const model of config.availableEmbeddingModels) dropdown.addOption(model, model);
          return dropdown.setValue(config.availableEmbeddingModels.includes(config.embeddingModel) ? config.embeddingModel : "").onChange(async (value) => {
            if (value === config.embeddingModel) return;
            config.embeddingModel = value;
            await this.plugin.saveSettings();
            if (this.plugin.settings.askNotesEnabled && this.plugin.settings.embeddingProvider === providerId) {
              await this.plugin.askNotesSearch.clear();
              this.plugin.scheduleAskNotesUpdate();
            }
          });
        });
      }
    }

    containerEl = sections.search;
    containerEl.createEl("h3", { text: "Search your notes" });
    containerEl.createEl("p", {
      text: "Choose folders before enabling search. Indexing sends their Markdown text to your selected embedding provider. Matching passages are shown unchanged. Exact term lookups can use the local index; natural-language questions also send your query to that provider for semantic matching. API usage may incur charges. Vectors and excerpts stay in local device storage, outside the vault.",
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
        const embeddingConfig = this.plugin.settings.providers[this.plugin.settings.embeddingProvider];
        if (enabled && (!this.plugin.settings.askNotesFolders.length || !embeddingConfig.apiKey.trim() || !embeddingConfig.embeddingModel.trim())) {
          new Notice("Choose a folder, fetch models, and select an embedding model first.");
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

    containerEl = sections.creation;
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
    if (renderVersion !== this.renderVersion) return;
    const noteCount = indexData?.totalNotes || 0;
    const folderCount = indexData?.totalFolders || 0;

    new Setting(containerEl)
      .setName("Placement index")
      .setDesc(
        `Used for placing generated notes. Separate from Ask Notes search. Status: ${
          indexData ? `Indexed ${noteCount} notes across ${folderCount} folders.` : "Not yet generated."
        }`
      )
      .addButton((btn) => {
        btn.setButtonText("Rebuild index").onClick(async () => {
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
            btn.setButtonText("Rebuild index");
          }
        });
      });

    // Useful Excalidraw diagram settings
    containerEl.createEl("h3", { text: "Diagrams and formatting" });

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
          .addOption("concise", "Concise")
          .addOption("detailed", "Detailed")
          .addOption("bare", "Source only")
          .setValue(this.plugin.settings.defaultNoteStyle || "concise")
          .onChange(async (value) => {
            this.plugin.settings.defaultNoteStyle = value as NoteStyle;
            await this.plugin.saveSettings();
          })
      );

    containerEl = sections.advanced;
    containerEl.createEl("h3", { text: "Advanced AI settings" });
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

    // These preferences belong with note creation, even though advanced controls render here.
    new Setting(sections.creation)
      .setName("Default folder")
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
    new Setting(sections.creation)
      .setName("Open created notes")
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
  }

  hide(): void {
    this.renderVersion++;
    this.navigationController?.abort();
    this.askFolderNavigator?.destroy();
    this.unsubscribeAskStatus?.();
    document.dispatchEvent(new CustomEvent("autonatic:settings-updated"));
    super.hide();
  }
}

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type NemotronPlugin from "./main";
import { CONCISE_OBSIDIAN_SKILL_PROMPT, DETAILED_OBSIDIAN_SKILL_PROMPT } from "./prompts";
import { buildOrUpdateVaultIndex, loadVaultIndex } from "./vault-indexer";
import { DESTINATION_MODE_OPTIONS, type DestinationMode } from "./destination-modes";
import { DEFAULT_TEXT_MODEL } from "./model-defaults";

export interface NemotronPluginSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  defaultDestinationMode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append";
  defaultNoteStyle: "concise" | "detailed";
  enableProperties: boolean;
  enableAutoSplitLongNotes: boolean;
  maxNoteWordCount: number;
  splitNamingFormat: "part_suffix" | "parenthesis" | "continued";
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
}

export const DEFAULT_SETTINGS: NemotronPluginSettings = {
  apiKey: "",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  model: DEFAULT_TEXT_MODEL,
  visionModel: "meta/llama-3.2-11b-vision-instruct",
  defaultDestinationMode: "smart",
  defaultNoteStyle: "concise",
  enableProperties: true,
  enableAutoSplitLongNotes: true,
  maxNoteWordCount: 600,
  splitNamingFormat: "part_suffix",
  enableExcalidrawMindMap: true,
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
};

export class NemotronSettingTab extends PluginSettingTab {
  plugin: NemotronPlugin;

  constructor(app: App, plugin: NemotronPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Nemotron Note Crafter Settings" });
    containerEl.createEl("h3", { text: "Privacy and cost controls" });
    new Setting(containerEl).setName("Automatic index updates").setDesc("Update the local vault index after a file changes.").addToggle((c) => c.setValue(this.plugin.settings.enableAutomaticIndexing).onChange(async (v) => { this.plugin.settings.enableAutomaticIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Send note excerpts for indexing").setDesc("Consent: send short note excerpts to NVIDIA during index builds. Off uses local metadata only.").addToggle((c) => c.setValue(this.plugin.settings.allowRemoteVaultIndexing).onChange(async (v) => { this.plugin.settings.allowRemoteVaultIndexing = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Excluded folders").setDesc("Comma-separated folder paths that indexing must ignore.").addText((c) => c.setValue(this.plugin.settings.excludedFolders).onChange(async (v) => { this.plugin.settings.excludedFolders = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Maximum context notes").setDesc("Limit the note summaries sent with one generation request.").addSlider((c) => c.setLimits(5, 100, 5).setValue(this.plugin.settings.maxVaultContextNotes).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxVaultContextNotes = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Confirm multi-file changes").setDesc("Show the planned file count before a multi-note write.").addToggle((c) => c.setValue(this.plugin.settings.confirmMultiFileChanges).onChange(async (v) => { this.plugin.settings.confirmMultiFileChanges = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Maximum automatic diagrams").setDesc("Limit useful diagrams created or updated after one note operation. Zero disables automatic diagrams.").addSlider((c) => c.setLimits(0, 10, 1).setValue(this.plugin.settings.maxAutomaticDiagrams).setDynamicTooltip().onChange(async (v) => { this.plugin.settings.maxAutomaticDiagrams = v; await this.plugin.saveSettings(); }));

    // NVIDIA NIM Quick Link & Helper Card
    const nimCard = containerEl.createDiv({ cls: "nemotron-nim-card" });
    const nimLeft = nimCard.createDiv({ cls: "nemotron-nim-left" });
    nimLeft.createEl("strong", { text: "Need an NVIDIA API Key?" });
    nimLeft.createEl("p", {
      text: "NVIDIA NIM offers developer API access for models like Nemotron 3 Super and Llama 3.2 Vision.",
      cls: "nemotron-nim-desc",
    });
    
    const nimBtn = nimCard.createEl("button", {
      text: "Open NVIDIA NIM (build.nvidia.com)",
      cls: "mod-cta nemotron-nim-btn",
    });
    nimBtn.setAttribute("type", "button");
    nimBtn.addEventListener("click", () => {
      window.open("https://build.nvidia.com", "_blank");
    });

    // API Key Setting with Instant Paste
    const apiKeySetting = new Setting(containerEl)
      .setName("NVIDIA API Key")
      .setDesc("Your personal API key (starts with nvapi-...). Stored locally on your device.");

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

    // Default Destination Mode
    new Setting(containerEl)
      .setName("Default Destination Mode")
      .setDesc("Choose default placement behavior when opening the Note Crafter modal.")
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
        `Maintains a nested JSON tree (.nemotron-vault-index.json) of folders, subfolders, and notes with topics and 'about' summaries. Status: ${
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
          .setValue(this.plugin.settings.enableExcalidrawMindMap ?? true)
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

    // Auto-Split Long Notes & Atomic Sizing Section
    containerEl.createEl("h3", { text: "Atomic Note Sizing & Auto-Splitting" });

    new Setting(containerEl)
      .setName("Auto-Split Long Notes (Part 2 Sequence)")
      .setDesc("When appending to a note that exceeds the optimal word count, automatically creates a sequential Part 2 note with two-way breadcrumb links.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoSplitLongNotes ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoSplitLongNotes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max Note Word Count (Optimal Atomic Length)")
      .setDesc("The target maximum length for a concise note before auto-splitting into a new part (Recommended: 400 - 800 words).")
      .addSlider((slider) =>
        slider
          .setLimits(200, 1500, 50)
          .setValue(this.plugin.settings.maxNoteWordCount || 600)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxNoteWordCount = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Split Note Naming Convention")
      .setDesc("How subsequent continuation notes are named.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("part_suffix", "Title - Part 2 (Recommended)")
          .addOption("parenthesis", "Title (Part 2)")
          .addOption("continued", "Title - Continued")
          .setValue(this.plugin.settings.splitNamingFormat || "part_suffix")
          .onChange(async (value) => {
            this.plugin.settings.splitNamingFormat = value as "part_suffix" | "parenthesis" | "continued";
            await this.plugin.saveSettings();
          })
      );

    // YAML Properties Generation Toggle
    new Setting(containerEl)
      .setName("Generate YAML Properties / Frontmatter")
      .setDesc("Generate YAML properties (title, tags, aliases, created, summary) at the top of notes. Turn off to generate plain notes without frontmatter.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableProperties ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableProperties = value;
            await this.plugin.saveSettings();
          })
      );

    // Default Note Style
    new Setting(containerEl)
      .setName("Default Note Style")
      .setDesc("Choose default output length and structure (Concise vs Detailed).")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("concise", "Concise & Punchy (Smart Brevity)")
          .addOption("detailed", "Detailed & Comprehensive")
          .setValue(this.plugin.settings.defaultNoteStyle || "concise")
          .onChange(async (value) => {
            this.plugin.settings.defaultNoteStyle = value as "concise" | "detailed";
            await this.plugin.saveSettings();
          })
      );

    // Base URL
    new Setting(containerEl)
      .setName("API Base URL")
      .setDesc("The OpenAI-compatible base URL for NVIDIA API.")
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
  }
}

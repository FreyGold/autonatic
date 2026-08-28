import { App, Modal, Notice, MarkdownView, normalizePath, TFile, TFolder, Menu } from "obsidian";
import type NemotronPlugin from "./main";
import { generateNemotronNote, sanitizeMermaidDiagrams } from "./api";
import { buildUserPrompt } from "./prompts";
import { CustomSelect, SelectOption } from "./custom-select";
import { FolderNavigator } from "./folder-nav";
import {
  buildOrUpdateVaultIndex,
  formatVaultTreeForAI,
  extractSmartDecision,
  extractAtomicDecompositionPlan,
  loadVaultIndex,
  enforceMaxDepthFolder,
  VAULT_INDEX_FILENAME,
} from "./vault-indexer";
import {
  isPathInFolder,
  resolveFolderWithinScope,
  selectStrongRelatedNote,
  selectVaultContext,
} from "./privacy-controls";
import type { VaultKnowledgeIndex } from "./vault-indexer";
import { FileSnapshot, PromptHistoryItem, revertFileSnapshots } from "./history-manager";
import {
  createMirroredExcalidrawDrawing,
  createStandaloneRichExcalidrawDrawing,
} from "./excalidraw-generator";
import type { DiagramOptions, DiagramType, DiagramTheme } from "./diagram-engine";

interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
}

export class NemotronModal extends Modal {
  plugin: NemotronPlugin;
  initialText: string;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  attachedImages: AttachedImage[] = [];
  excalAttachedImages: AttachedImage[] = [];
  pasteListener!: (e: ClipboardEvent) => void;
  selectedMode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append" = "smart";
  selectedStyle: "concise" | "detailed" = "concise";
  enableExcalidrawInNoteTab: boolean = true;
  historyRowEl!: HTMLElement;
  modeSelectComponent!: CustomSelect;
  styleSelectComponent!: CustomSelect;
  private selectComponents: CustomSelect[] = [];
  private folderNavigators: FolderNavigator[] = [];
  private updateModeUI?: (mode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append") => Promise<void>;
  renderGalleryCallback?: () => void;
  renderExcalGalleryCallback?: () => void;
  inputTextAreaEl?: HTMLTextAreaElement;
  customInputEl?: HTMLInputElement;
  activeTab: "notes" | "excalidraw" = "notes";

  constructor(app: App, plugin: NemotronPlugin, initialText: string = "", defaultTab: "notes" | "excalidraw" = "notes") {
    super(app);
    this.plugin = plugin;
    this.initialText = initialText;
    this.activeTab = defaultTab;
    this.enableExcalidrawInNoteTab = plugin.settings.enableExcalidrawMindMap ?? true;
  }

  async onOpen() {
    const { contentEl } = this;
    this.selectComponents.forEach((select) => select.destroy());
    this.selectComponents = [];
    this.folderNavigators.forEach((navigator) => navigator.destroy());
    this.folderNavigators = [];
    contentEl.empty();
    contentEl.addClass("nemotron-modal-container");

    // Header Title
    const headerRow = contentEl.createDiv({ cls: "nemotron-modal-header-row" });
    headerRow.createEl("h2", { text: "Nemotron Note Crafter", cls: "nemotron-modal-title" });

    // History Toolbar Row (Undo / Redo up to 3 generations & Recent Prompts up to 5)
    this.historyRowEl = contentEl.createDiv({ cls: "nemotron-history-toolbar" });
    this.renderHistoryToolbar();

    // Inline API Key Management Bar
    const apiKeyBar = contentEl.createDiv({ cls: "nemotron-api-key-bar" });
    this.renderApiKeySection(apiKeyBar);

    // Modal Nav Tabs (Note Crafter vs Excalidraw Diagram)
    const tabNav = contentEl.createDiv({ cls: "nemotron-modal-nav-tabs" });
    const noteTabBtn = tabNav.createEl("button", {
      text: "Note Crafter",
      cls: `nemotron-tab-btn ${this.activeTab === "notes" ? "is-active" : ""}`,
    });
    const excalTabBtn = tabNav.createEl("button", {
      text: "Excalidraw Diagram",
      cls: `nemotron-tab-btn ${this.activeTab === "excalidraw" ? "is-active" : ""}`,
    });

    const notePane = contentEl.createDiv({ cls: `nemotron-tab-pane ${this.activeTab === "notes" ? "" : "is-hidden"}` });
    const excalPane = contentEl.createDiv({ cls: `nemotron-tab-pane ${this.activeTab === "excalidraw" ? "" : "is-hidden"}` });

    noteTabBtn.addEventListener("click", () => {
      this.activeTab = "notes";
      noteTabBtn.addClass("is-active");
      excalTabBtn.removeClass("is-active");
      notePane.removeClass("is-hidden");
      excalPane.addClass("is-hidden");
    });

    excalTabBtn.addEventListener("click", () => {
      this.activeTab = "excalidraw";
      excalTabBtn.addClass("is-active");
      noteTabBtn.removeClass("is-active");
      excalPane.removeClass("is-hidden");
      notePane.addClass("is-hidden");
    });

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasActiveNote = !!(activeView && activeView.file);

    // TAB 1: Note Crafter Pane
    this.renderNoteCrafterPane(notePane, activeView, hasActiveNote);

    // TAB 2: Excalidraw Diagram Pane
    this.renderExcalidrawPane(excalPane, activeView, hasActiveNote);
  }

  // ==========================================
  // TAB 1: NOTE CRAFTER PANE
  // ==========================================
  private renderNoteCrafterPane(paneEl: HTMLElement, activeView: MarkdownView | null, hasActiveNote: boolean) {
    const modeOptions: SelectOption[] = [
      {
        value: "smart",
        label: "Smart Placement (Single Note)",
        description: "AI analyzes your vault hierarchy to place the note in the best folder or note.",
      },
      {
        value: "multi_note",
        label: "Atomic Decomposition (Multi-Note)",
        description: "Splits input into distinct atomic notes, auto-creating new files and/or appending across relevant vault notes.",
      },
      {
        value: "multi_note_folder",
        label: "Create Multiple Notes in Folder",
        description: "Splits the input into separate new notes and saves every note in one selected directory.",
      },
      {
        value: "new_file",
        label: "Create New Note File",
        description: "Manually pick a destination folder and title for a new note file.",
      },
      {
        value: "append",
        label: hasActiveNote ? `Append to Active Note (${activeView?.file?.basename})` : "Append to Active Note",
        description: hasActiveNote
          ? `Pastes formatted note section directly to the end of "${activeView?.file?.basename}".`
          : "Disabled: Open a note in the editor first to append.",
        disabled: !hasActiveNote,
      },
    ];

    const defaultMode = this.plugin.settings.defaultDestinationMode || "smart";
    this.selectedMode = defaultMode;

    const modeContainer = paneEl.createDiv({ cls: "nemotron-form-row" });
    const modeLabel = modeContainer.createEl("label", { text: "Destination Mode:", cls: "nemotron-label" });
    modeLabel.id = "nemotron-destination-mode-label";
    modeLabel.htmlFor = "nemotron-destination-mode";

    let initialFolder = this.plugin.settings.defaultFolder || "";
    if (!initialFolder) {
      if (hasActiveNote && activeView?.file?.parent) {
        initialFolder = activeView.file.parent.path;
      } else {
        const mdFiles = this.app.vault.getMarkdownFiles();
        if (mdFiles.length > 0) {
          const sorted = mdFiles.slice().sort((a, b) => b.stat.mtime - a.stat.mtime);
          const lastEdited = sorted[0];
          if (lastEdited && lastEdited.parent && lastEdited.parent.path !== "/" && lastEdited.parent.path !== ".") {
            initialFolder = lastEdited.parent.path;
          }
        }
      }
    }
    if (initialFolder === "/" || initialFolder === ".") initialFolder = "";

    const smartModeInfo = paneEl.createDiv({ cls: "nemotron-smart-info-banner" });
    this.renderSmartBanner(smartModeInfo);

    let limitSmartToFolder = false;
    let currentSmartScopeFolder = initialFolder;
    const smartScopeOptionsDiv = paneEl.createDiv({ cls: "nemotron-smart-scope-options" });
    const smartScopeToggleRow = smartScopeOptionsDiv.createDiv({ cls: "nemotron-checkbox-row nemotron-smart-scope-toggle" });
    const smartScopeCheckbox = smartScopeToggleRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    smartScopeCheckbox.id = "nemotron-smart-folder-scope-toggle";
    smartScopeCheckbox.setAttribute("aria-controls", "nemotron-smart-folder-scope-options");

    const smartScopeToggleLabel = smartScopeToggleRow.createEl("label", { cls: "nemotron-checkbox-label" });
    smartScopeToggleLabel.htmlFor = smartScopeCheckbox.id;
    smartScopeToggleLabel.createSpan({ text: "Limit Smart Placement to a folder", cls: "nemotron-checkbox-title" });
    smartScopeToggleLabel.createSpan({
      text: " Smart can create or append only in this folder and its subfolders.",
      cls: "nemotron-checkbox-desc",
    });

    const smartScopeFolderOptions = smartScopeOptionsDiv.createDiv({ cls: "nemotron-smart-scope-folder" });
    smartScopeFolderOptions.id = "nemotron-smart-folder-scope-options";
    const smartScopeFolderRow = smartScopeFolderOptions.createDiv({ cls: "nemotron-form-row" });
    smartScopeFolderRow.createEl("label", { text: "Smart Placement Folder:", cls: "nemotron-label" });
    smartScopeFolderRow.createEl("div", {
      text: "The limit includes all notes and folders below the selected folder.",
      cls: "nemotron-folder-scope-help",
    });
    const smartFolderNavigator = new FolderNavigator(
      this.app,
      smartScopeFolderRow,
      initialFolder,
      (newPath) => {
        currentSmartScopeFolder = newPath;
      },
    );
    this.folderNavigators.push(smartFolderNavigator);

    const updateSmartScopeVisibility = () => {
      limitSmartToFolder = smartScopeCheckbox.checked;
      smartScopeCheckbox.setAttribute("aria-expanded", limitSmartToFolder ? "true" : "false");
      smartScopeFolderOptions.style.display = limitSmartToFolder ? "block" : "none";
    };
    smartScopeCheckbox.addEventListener("change", updateSmartScopeVisibility);
    updateSmartScopeVisibility();

    const newNoteOptionsDiv = paneEl.createDiv({ cls: "nemotron-new-note-options" });

    const titleRow = newNoteOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    const titleLabel = titleRow.createEl("label", { text: "Note Title (optional):", cls: "nemotron-label" });
    const titleInput = titleRow.createEl("input", {
      type: "text",
      placeholder: "Auto-detected from note content if left blank",
      cls: "nemotron-input",
    });
    titleInput.id = "nemotron-note-title";
    titleInput.name = "note-title";
    titleLabel.htmlFor = titleInput.id;

    const folderRow = newNoteOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    folderRow.createEl("label", { text: "Target Folder Location:", cls: "nemotron-label" });
    
    let currentSelectedFolder = initialFolder;
    const folderNavigator = new FolderNavigator(
      this.app,
      folderRow,
      initialFolder,
      (newPath) => {
        currentSelectedFolder = newPath;
      }
    );
    this.folderNavigators.push(folderNavigator);

    const updateModeUI = async (mode: "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append") => {
      this.selectedMode = mode;
      if (mode === "smart") {
        smartModeInfo.style.display = "flex";
        smartScopeOptionsDiv.style.display = "block";
        await this.renderSmartBanner(smartModeInfo);
        newNoteOptionsDiv.style.display = "none";
      } else if (mode === "multi_note") {
        smartModeInfo.style.display = "flex";
        smartScopeOptionsDiv.style.display = "none";
        await this.renderSmartBanner(smartModeInfo);
        newNoteOptionsDiv.style.display = "none";
      } else if (mode === "new_file" || mode === "multi_note_folder") {
        smartModeInfo.style.display = "none";
        smartScopeOptionsDiv.style.display = "none";
        newNoteOptionsDiv.style.display = "block";
        titleRow.style.display = mode === "new_file" ? "block" : "none";
      } else {
        smartModeInfo.style.display = "none";
        smartScopeOptionsDiv.style.display = "none";
        newNoteOptionsDiv.style.display = "none";
      }
    };
    this.updateModeUI = updateModeUI;

    updateModeUI(defaultMode);

    this.modeSelectComponent = new CustomSelect(
      modeContainer,
      modeOptions,
      defaultMode,
      (val) => {
        updateModeUI(val as "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append");
      },
      { controlId: "nemotron-destination-mode", labelId: modeLabel.id },
    );
    this.selectComponents.push(this.modeSelectComponent);

    // 2. Note Output Style Selector
    const styleContainer = paneEl.createDiv({ cls: "nemotron-form-row" });
    const styleLabel = styleContainer.createEl("label", { text: "Note Depth & Style:", cls: "nemotron-label" });
    styleLabel.id = "nemotron-note-style-label";
    styleLabel.htmlFor = "nemotron-note-style";

    const styleOptions: SelectOption[] = [
      {
        value: "concise",
        label: "Concise & Punchy (Default)",
        description: "Smart Brevity & Atomic structure. High signal-to-noise ratio, bold lead-ins, no fluff.",
      },
      {
        value: "detailed",
        label: "Detailed & Comprehensive",
        description: "In-depth explanations, full architecture diagrams, trade-offs, and complete code walkthroughs.",
      },
    ];

    const defaultStyle = this.plugin.settings.defaultNoteStyle || "concise";
    this.selectedStyle = defaultStyle;

    this.styleSelectComponent = new CustomSelect(
      styleContainer,
      styleOptions,
      defaultStyle,
      (val) => {
        this.selectedStyle = val as "concise" | "detailed";
      },
      { controlId: "nemotron-note-style", labelId: styleLabel.id },
    );
    this.selectComponents.push(this.styleSelectComponent);

    // 3. Excalidraw Rich Architecture Diagram Toggle Row
    const excalRow = paneEl.createDiv({ cls: "nemotron-form-row nemotron-checkbox-row" });
    const excalCheckbox = excalRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    excalCheckbox.id = "nemotron-note-excalidraw-toggle";
    excalCheckbox.checked = this.enableExcalidrawInNoteTab;
    excalCheckbox.addEventListener("change", () => {
      this.enableExcalidrawInNoteTab = excalCheckbox.checked;
    });

    const excalLabel = excalRow.createEl("label", { cls: "nemotron-checkbox-label" });
    excalLabel.setAttribute("for", "nemotron-note-excalidraw-toggle");
    excalLabel.createSpan({ text: "Generate Rich Excalidraw Architecture Diagram ", cls: "nemotron-checkbox-title" });
    excalLabel.createSpan({
      text: `(Deep AI multi-container subsystems, cards & flows mirrored in /${this.plugin.settings.excalidrawFolder || "Excalidrawings"})`,
      cls: "nemotron-checkbox-desc",
    });

    // 4. Multi-Image Input Section
    const imageRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const imageHeaderRow = imageRow.createDiv({ cls: "nemotron-image-header" });
    imageHeaderRow.createEl("label", { text: "Photos / Images / Screenshots (optional):", cls: "nemotron-label" });
    const imageCountBadge = imageHeaderRow.createSpan({ cls: "nemotron-image-badge", text: "0 attached" });
    imageCountBadge.style.display = "none";

    const dropzone = imageRow.createDiv({ cls: "nemotron-image-dropzone" });
    const dropzonePrompt = dropzone.createDiv({ cls: "nemotron-dropzone-prompt" });
    
    dropzonePrompt.createSpan({ text: "Paste image (Ctrl+V), drag & drop multiple files, or ", cls: "nemotron-dropzone-text" });
    const browseLink = dropzonePrompt.createEl("a", { text: "browse files", cls: "nemotron-browse-link" });
    dropzonePrompt.createSpan({ text: " | ", cls: "nemotron-dropzone-sep" });
    const pasteBtn = dropzonePrompt.createEl("button", {
      text: "Paste from Clipboard",
      cls: "nemotron-paste-clipboard-btn",
    });
    pasteBtn.setAttribute("type", "button");

    const hiddenFileInput = dropzone.createEl("input", {
      type: "file",
      cls: "nemotron-hidden-file-input",
    });
    hiddenFileInput.accept = "image/*";
    hiddenFileInput.multiple = true;

    browseLink.addEventListener("click", (e) => {
      e.preventDefault();
      hiddenFileInput.click();
    });

    const imageGallery = imageRow.createDiv({ cls: "nemotron-image-gallery" });
    imageGallery.style.display = "none";

    const renderGallery = () => {
      imageGallery.empty();
      if (this.attachedImages.length === 0) {
        imageGallery.style.display = "none";
        imageCountBadge.style.display = "none";
        return;
      }

      imageGallery.style.display = "flex";
      imageCountBadge.style.display = "inline-block";
      imageCountBadge.setText(`${this.attachedImages.length} attached`);

      const topBar = imageGallery.createDiv({ cls: "nemotron-gallery-topbar" });
      topBar.createSpan({ text: `Attached Images (${this.attachedImages.length}):`, cls: "nemotron-gallery-title" });
      
      const clearAllBtn = topBar.createEl("button", { text: "Clear All", cls: "nemotron-clear-all-btn" });
      clearAllBtn.setAttribute("type", "button");
      clearAllBtn.addEventListener("click", () => {
        this.attachedImages = [];
        renderGallery();
      });

      const cardsGrid = imageGallery.createDiv({ cls: "nemotron-gallery-grid" });

      this.attachedImages.forEach((img, idx) => {
        const card = cardsGrid.createDiv({ cls: "nemotron-image-card" });
        
        const thumb = card.createEl("img", { cls: "nemotron-card-thumb" });
        thumb.src = img.dataUrl;

        const info = card.createDiv({ cls: "nemotron-card-info" });
        info.createDiv({ text: `Image #${idx + 1}`, cls: "nemotron-card-num" });
        info.createDiv({ text: img.name, cls: "nemotron-card-name" });

        const removeBtn = card.createEl("button", { text: "Remove", cls: "nemotron-card-remove" });
        removeBtn.setAttribute("type", "button");
        removeBtn.setAttribute("title", "Remove image");
        removeBtn.addEventListener("click", () => {
          this.attachedImages = this.attachedImages.filter((item) => item.id !== img.id);
          renderGallery();
        });
      });
    };

    this.renderGalleryCallback = renderGallery;

    const addImage = (dataUrl: string, name: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      this.attachedImages.push({ id, name, dataUrl });
      renderGallery();
    };

    const handleFile = (file: File | Blob, customName?: string) => {
      if (file.type && !file.type.startsWith("image/")) {
        return false;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        if (result) {
          const name = customName || (file as File).name || `Image-${this.attachedImages.length + 1}.png`;
          addImage(result, name);
          new Notice(`Attached: ${name}`);
        }
      };
      reader.readAsDataURL(file);
      return true;
    };

    const tryReadSystemClipboard = async (): Promise<boolean> => {
      try {
        const electron = (window as any).require ? (window as any).require("electron") : null;
        if (electron && electron.clipboard) {
          const nativeImage = electron.clipboard.readImage();
          if (nativeImage && !nativeImage.isEmpty()) {
            const dataUrl = nativeImage.toDataURL();
            const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
            addImage(dataUrl, `Screenshot-${timeStr}.png`);
            new Notice("Image pasted from system clipboard!");
            return true;
          }
        }
      } catch {}

      try {
        if (navigator.clipboard && navigator.clipboard.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            for (const type of item.types) {
              if (type.startsWith("image/")) {
                const blob = await item.getType(type);
                handleFile(blob, `Clipboard-Image-${this.attachedImages.length + 1}.png`);
                return true;
              }
            }
          }
        }
      } catch {}

      return false;
    };

    pasteBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const success = await tryReadSystemClipboard();
      if (!success) {
        new Notice("No image found in clipboard. Copy an image or screenshot first.");
      }
    });

    hiddenFileInput.addEventListener("change", () => {
      if (hiddenFileInput.files && hiddenFileInput.files.length > 0) {
        for (let i = 0; i < hiddenFileInput.files.length; i++) {
          handleFile(hiddenFileInput.files[i]);
        }
        hiddenFileInput.value = "";
      }
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.addClass("is-dragover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.removeClass("is-dragover");
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.removeClass("is-dragover");
      if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          handleFile(e.dataTransfer.files[i]);
        }
      }
    });

    this.pasteListener = async (e: ClipboardEvent) => {
      let handled = false;

      if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
        for (let i = 0; i < e.clipboardData.files.length; i++) {
          const f = e.clipboardData.files[i];
          if (f.type.startsWith("image/")) {
            e.preventDefault();
            handleFile(f);
            handled = true;
          }
        }
      }

      if (!handled && e.clipboardData?.items) {
        for (let i = 0; i < e.clipboardData.items.length; i++) {
          const item = e.clipboardData.items[i];
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              handleFile(file);
              handled = true;
            }
          }
        }
      }

      if (!handled) {
        const systemSuccess = await tryReadSystemClipboard();
        if (systemSuccess) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener("paste", this.pasteListener, true);

    // 5. Custom Instruction row
    const customRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    customRow.createEl("label", { text: "Custom Instructions (optional):", cls: "nemotron-label" });
    const customInput = customRow.createEl("input", {
      type: "text",
      placeholder: "e.g., Decompose into atomic concepts, place each in relevant folder...",
      cls: "nemotron-input",
    });
    this.customInputEl = customInput;

    // 6. Input Text area
    const inputAreaRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    inputAreaRow.createEl("label", { text: "Raw Input Text (optional if photos are attached):", cls: "nemotron-label" });
    const inputTextArea = inputAreaRow.createEl("textarea", {
      cls: "nemotron-textarea",
      placeholder: "Paste or write text, or attach photos / screenshots above...",
    });
    inputTextArea.value = this.initialText;
    inputTextArea.rows = 5;
    this.inputTextAreaEl = inputTextArea;

    // Status area
    const statusDiv = paneEl.createDiv({ cls: "nemotron-status" });
    statusDiv.setAttribute("role", "status");
    statusDiv.setAttribute("aria-live", "polite");
    statusDiv.style.display = "none";

    // Streaming Preview Area
    const previewContainer = paneEl.createDiv({ cls: "nemotron-preview-container" });
    previewContainer.style.display = "none";
    
    const reasoningDetails = previewContainer.createEl("details", { cls: "nemotron-reasoning-box" });
    reasoningDetails.createEl("summary", { text: "Thinking Process (Nemotron Reasoning)" });
    const reasoningPre = reasoningDetails.createEl("pre", { cls: "nemotron-reasoning-content" });

    const contentPreviewBox = previewContainer.createEl("div", { cls: "nemotron-content-box" });
    contentPreviewBox.createEl("h4", { text: "Formatted Note Preview:" });
    const contentPre = contentPreviewBox.createEl("pre", { cls: "nemotron-preview-content" });

    // Buttons
    const buttonRow = paneEl.createDiv({ cls: "nemotron-button-row" });
    const generateBtn = buttonRow.createEl("button", {
      text: "Transform to Obsidian Note",
      cls: "mod-cta",
    });
    const cancelBtn = buttonRow.createEl("button", {
      text: "Cancel",
    });

    cancelBtn.addEventListener("click", () => {
      if (this.isGenerating && this.abortController) {
        this.abortController.abort();
      }
      this.close();
    });

    generateBtn.addEventListener("click", async () => {
      if (!this.plugin.settings.apiKey || !this.plugin.settings.apiKey.trim()) {
        new Notice("Please enter your NVIDIA API Key first.");
        statusDiv.style.display = "block";
        statusDiv.setText("Error: NVIDIA API Key is required. Please set it above or in Settings.");
        return;
      }

      const rawText = inputTextArea.value.trim();
      const hasImages = this.attachedImages.length > 0;

      if (!rawText && !hasImages) {
        new Notice("Please enter text or attach at least one image to transform.");
        return;
      }

      const mode = this.selectedMode;
      const enableProperties = this.plugin.settings.enableProperties ?? true;
      const customInstruction = customInput.value.trim();
      const smartScopeFolder = mode === "smart" && limitSmartToFolder
        ? currentSmartScopeFolder
        : undefined;

      if (smartScopeFolder) {
        const scopeTarget = this.app.vault.getAbstractFileByPath(normalizePath(smartScopeFolder));
        if (!(scopeTarget instanceof TFolder)) {
          new Notice(`The Smart Placement folder does not exist: ${smartScopeFolder}`);
          return;
        }
      }

      const previewSnippet = rawText.slice(0, 60) || (hasImages ? `${this.attachedImages.length} attached image(s)` : "Note generation");
      this.plugin.historyManager.recordPrompt({
        id: `${Date.now()}`,
        timestamp: Date.now(),
        rawText,
        customInstruction,
        mode,
        style: this.selectedStyle,
        attachedImages: [...this.attachedImages],
        preview: previewSnippet,
      });

      const existingVaultNotes = this.app.vault
        .getMarkdownFiles()
        .filter((file) => smartScopeFolder === undefined || isPathInFolder(file.path, smartScopeFolder))
        .map((f) => f.basename)
        .filter((b) => b && !b.startsWith("."));

      const promptText = rawText || "Extract, analyze, and synthesize all key concepts, instructions, and code from the attached image(s).";
      let vaultKnowledgeTreeText: string | undefined = undefined;
      let vaultIndexForPlacement: VaultKnowledgeIndex | null = null;
      if (mode === "smart" || mode === "multi_note") {
        statusDiv.style.display = "block";
        statusDiv.setText("Analyzing vault knowledge tree...");
        const vaultIndex = await buildOrUpdateVaultIndex(this.app, this.plugin.settings);
        vaultIndexForPlacement = vaultIndex;
        const notes = selectVaultContext(
          vaultIndex,
          promptText,
          this.plugin.settings.maxVaultContextNotes,
          mode === "smart" ? smartScopeFolder : undefined,
        );
        vaultKnowledgeTreeText = notes.map((note) => `- ${note.path}: ${note.about}`).join("\n");
      }

      const prompt = buildUserPrompt(
        promptText,
        mode,
        this.selectedStyle,
        customInstruction,
        existingVaultNotes,
        vaultKnowledgeTreeText,
        enableProperties,
        smartScopeFolder,
      );

      this.isGenerating = true;
      generateBtn.disabled = true;
      generateBtn.setText("Generating...");
      statusDiv.style.display = "block";
      statusDiv.setText(
        mode === "multi_note_folder"
          ? "Decomposing input into new notes for the selected folder..."
          : mode === "multi_note"
          ? "Decomposing into atomic notes & routing across vault..."
          : mode === "smart"
          ? smartScopeFolder !== undefined
            ? `Analyzing notes in ${smartScopeFolder || "Vault Root"}...`
            : "Analyzing vault tree & generating note..."
          : "Starting note generation..."
      );
      previewContainer.style.display = "block";
      reasoningPre.setText("");
      contentPre.setText("");

      this.abortController = new AbortController();
      const fileSnapshots: FileSnapshot[] = [];
      const foldersCreatedList: string[] = [];
      let generationRecorded = false;

      try {
        const imageUrls = this.attachedImages.map((img) => img.dataUrl);
        const result = await generateNemotronNote(
          this.plugin.settings,
          prompt,
          imageUrls.length > 0 ? imageUrls : undefined,
          this.selectedStyle,
          {
            onStatus: (status) => {
              statusDiv.setText(status);
            },
            onReasoning: (chunk) => {
              reasoningPre.setText(reasoningPre.getText() + chunk);
            },
            onContent: (chunk) => {
              contentPre.setText(contentPre.getText() + chunk);
              contentPre.scrollTop = contentPre.scrollHeight;
            },
          },
          this.abortController.signal
        );

        statusDiv.setText("Placing notes and generating rich Excalidraw diagrams...");

        if (mode === "multi_note" || mode === "multi_note_folder") {
          const plan = extractAtomicDecompositionPlan(result.content);
          let createdCount = 0;
          let appendedCount = 0;
          const fixedTargetFolder = mode === "multi_note_folder" ? currentSelectedFolder : undefined;

          for (const item of plan) {
            try {
              if (fixedTargetFolder !== undefined) {
                const { snaps, foldersCreated } = await this.createNewNoteFile(
                  item.content,
                  item.title,
                  fixedTargetFolder,
                  enableProperties,
                  this.enableExcalidrawInNoteTab,
                  null,
                );
                fileSnapshots.push(...snaps);
                foldersCreatedList.push(...foldersCreated);
                createdCount++;
              } else if (item.action === "append_to_note" && item.targetNotePath) {
                const targetFile = this.app.vault.getAbstractFileByPath(normalizePath(item.targetNotePath));
                if (targetFile instanceof TFile) {
                  const { snaps, foldersCreated } = await this.appendToFile(targetFile, item.content, enableProperties, item.reason);
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  appendedCount++;
                } else {
                  const folder = enforceMaxDepthFolder(item.targetFolder || "");
                  const { snaps, foldersCreated } = await this.createNewNoteFile(item.content, item.title, folder, enableProperties, this.enableExcalidrawInNoteTab);
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  createdCount++;
                }
              } else {
                const folder = enforceMaxDepthFolder(item.targetFolder || "");
                const { snaps, foldersCreated } = await this.createNewNoteFile(item.content, item.title, folder, enableProperties, this.enableExcalidrawInNoteTab);
                fileSnapshots.push(...snaps);
                foldersCreatedList.push(...foldersCreated);
                createdCount++;
              }
            } catch (itemErr: any) {
              throw new Error(`Failed to process "${item.title}": ${itemErr.message}`, { cause: itemErr });
            }
          }

          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode,
            description: mode === "multi_note_folder"
              ? `Created ${createdCount} notes in ${fixedTargetFolder || "Vault Root"}`
              : `Atomic Decomposition: ${createdCount} created, ${appendedCount} updated`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });
          generationRecorded = true;

          new Notice(mode === "multi_note_folder"
            ? `Created ${createdCount} note(s) in ${fixedTargetFolder || "Vault Root"}.`
            : `Atomic Decomposition Complete: ${createdCount} note(s) created, ${appendedCount} note(s) processed.`, 8000);

          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else if (mode === "smart") {
          const { decision, cleanedContent } = extractSmartDecision(result.content);
          const requestedTargetIsInScope = decision?.action === "append_to_note" && decision.targetNotePath
            ? smartScopeFolder === undefined || isPathInFolder(decision.targetNotePath, smartScopeFolder)
            : false;
          const requestedTarget = requestedTargetIsInScope && decision?.targetNotePath
            ? this.app.vault.getAbstractFileByPath(normalizePath(decision.targetNotePath))
            : null;
          const relatedNote = vaultIndexForPlacement
            ? selectStrongRelatedNote(vaultIndexForPlacement, cleanedContent, smartScopeFolder)
            : null;
          const relatedTarget = relatedNote
            ? this.app.vault.getAbstractFileByPath(normalizePath(relatedNote.path))
            : null;
          const appendTarget = requestedTarget instanceof TFile
            ? requestedTarget
            : relatedTarget instanceof TFile
            ? relatedTarget
            : null;

          if (appendTarget) {
            const usedLocalMatch = !(requestedTarget instanceof TFile);
            const reason = usedLocalMatch
              ? `The generated content strongly matches the existing note "${appendTarget.basename}".`
              : decision!.reason;
            const { snaps, foldersCreated } = await this.appendToFile(appendTarget, cleanedContent, enableProperties, reason);
            fileSnapshots.push(...snaps);
            foldersCreatedList.push(...foldersCreated);
            new Notice(`Smart appended to: ${appendTarget.path}\nReason: ${reason}`, 7000);
          } else if (decision?.action === "append_to_note" && requestedTargetIsInScope) {
            throw new Error(`Smart placement selected a missing note: ${decision.targetNotePath}. No file was created.`);
          } else {
            const rawFolder = decision?.action === "create_new_note" ? decision.targetFolder : undefined;
            const targetFolder = resolveFolderWithinScope(rawFolder, smartScopeFolder);
            const title = decision?.title || titleInput.value.trim();
            const { snaps, foldersCreated } = await this.createNewNoteFile(cleanedContent, title, targetFolder, enableProperties, this.enableExcalidrawInNoteTab);
            fileSnapshots.push(...snaps);
            foldersCreatedList.push(...foldersCreated);
            const outsideScopeTarget = decision?.action === "append_to_note" && !requestedTargetIsInScope;
            const reason = outsideScopeTarget
              ? `The suggested note was outside the selected folder scope. A new note was created inside ${smartScopeFolder || "Vault Root"}.`
              : decision?.reason;
            const reasonMsg = reason ? `\nReason: ${reason}` : "";
            new Notice(`Smart Placed in folder: "${targetFolder || "Vault Root"}"${reasonMsg}`, 7000);
          }

          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "smart",
            description: `Smart note: ${fileSnapshots[0]?.path || "Note"}`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });
          generationRecorded = true;

          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else if (mode === "new_file") {
          const targetFolder = enforceMaxDepthFolder(currentSelectedFolder);
          const { snaps, foldersCreated } = await this.createNewNoteFile(result.content, titleInput.value.trim(), targetFolder, enableProperties, this.enableExcalidrawInNoteTab);
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);
          
          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "new_file",
            description: `Created note: ${snaps[0]?.path || "New note"}`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });
          generationRecorded = true;

          new Notice("Obsidian note created with Rich Excalidraw Diagram!");
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else {
          const { snaps, foldersCreated } = await this.appendToActiveNote(result.content, enableProperties, customInstruction || "Appended section via Nemotron");
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);

          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "append",
            description: `Appended to note: ${snaps[0]?.path || "Active note"}`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });
          generationRecorded = true;

          new Notice("Appended note section successfully!");
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        }

        this.close();
      } catch (err: any) {
        if (!generationRecorded && fileSnapshots.length > 0) {
          try {
            await revertFileSnapshots(this.app, fileSnapshots, Array.from(new Set(foldersCreatedList)));
          } catch (rollbackError) {
            console.error("Failed to restore files after generation error:", rollbackError);
            new Notice("Generation failed. Some files could not be restored. Review the error log.", 10000);
          }
        }
        if (err.name === "AbortError") {
          new Notice("Generation cancelled.");
        } else {
          console.error("Nemotron Note Crafter Error:", err);
          statusDiv.setText(`Error: ${err.message}`);
          new Notice(`Error generating note: ${err.message}`);
        }
      } finally {
        this.isGenerating = false;
        generateBtn.disabled = false;
        generateBtn.setText("Transform to Obsidian Note");
      }
    });
  }

  // ==========================================
  // TAB 2: EXCALIDRAW DIAGRAM PANE (WITH LIVE THINKING & PREVIEW)
  // ==========================================
  private renderExcalidrawPane(paneEl: HTMLElement, activeView: MarkdownView | null, hasActiveNote: boolean) {
    const infoCard = paneEl.createDiv({ cls: "nemotron-info-card" });
    infoCard.setText(
      "Generate high-effort AI architecture diagrams and systems maps using Nemotron's deep visual synthesizer. Creates multi-container subsystems, detailed component cards, and labeled data flows in /Excalidrawings."
    );

    // 1. Diagram Target Source
    const sourceOptions: SelectOption[] = [
      {
        value: "active_note",
        label: hasActiveNote ? `Active Note (${activeView?.file?.basename})` : "Active Note",
        description: hasActiveNote
          ? `Generates rich architecture diagram solely from "${activeView?.file?.basename}".`
          : "Disabled: Open a note in the editor first.",
        disabled: !hasActiveNote,
      },
      {
        value: "standalone",
        label: "Standalone Diagram (Without Note)",
        description: "Creates an independent Excalidraw drawing from your custom prompt, architecture spec, or images.",
      },
    ];

    const defaultSource = hasActiveNote ? "active_note" : "standalone";
    let selectedSource: "active_note" | "standalone" = defaultSource;

    const sourceContainer = paneEl.createDiv({ cls: "nemotron-form-row" });
    const sourceLabel = sourceContainer.createEl("label", { text: "Diagram Target Source:", cls: "nemotron-label" });
    sourceLabel.id = "nemotron-diagram-source-label";
    sourceLabel.htmlFor = "nemotron-diagram-source";

    // Standalone Options (Title & Subfolder)
    const standaloneOptionsDiv = paneEl.createDiv({ cls: "nemotron-standalone-excal-options" });
    standaloneOptionsDiv.style.display = defaultSource === "standalone" ? "block" : "none";

    const titleRow = standaloneOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    const drawingTitleLabel = titleRow.createEl("label", { text: "Drawing title", cls: "nemotron-label" });
    const drawingTitleInput = titleRow.createEl("input", {
      type: "text",
      placeholder: hasActiveNote ? `${activeView?.file?.basename} Architecture` : "System Architecture Diagram",
      cls: "nemotron-input",
    });
    drawingTitleInput.id = "nemotron-drawing-title";
    drawingTitleInput.name = "drawing-title";
    drawingTitleLabel.htmlFor = drawingTitleInput.id;

    const folderRow = standaloneOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    const excalFolderLabel = folderRow.createEl("label", { text: "Target folder in Excalidrawings", cls: "nemotron-label" });
    const excalFolderInput = folderRow.createEl("input", {
      type: "text",
      placeholder: "e.g. Backend/Architecture or leave blank for root Excalidrawings",
      cls: "nemotron-input",
    });
    excalFolderInput.id = "nemotron-drawing-folder";
    excalFolderInput.name = "drawing-folder";
    excalFolderLabel.htmlFor = excalFolderInput.id;

    // Toggle: Link back to active note
    const linkBackRow = paneEl.createDiv({ cls: "nemotron-form-row nemotron-checkbox-row" });
    const linkBackCheckbox = linkBackRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    linkBackCheckbox.id = "nemotron-excal-linkback";
    linkBackCheckbox.checked = hasActiveNote;
    linkBackCheckbox.disabled = !hasActiveNote;

    const linkBackLabel = linkBackRow.createEl("label", { cls: "nemotron-checkbox-label" });
    linkBackLabel.setAttribute("for", "nemotron-excal-linkback");
    linkBackLabel.createSpan({ text: "Insert Visual Architecture link at the top of active note", cls: "nemotron-checkbox-title" });

    const sourceSelect = new CustomSelect(
      sourceContainer,
      sourceOptions,
      defaultSource,
      (val) => {
        selectedSource = val as "active_note" | "standalone";
        if (selectedSource === "standalone") {
          standaloneOptionsDiv.style.display = "block";
          linkBackCheckbox.disabled = true;
          linkBackCheckbox.checked = false;
        } else {
          standaloneOptionsDiv.style.display = "none";
          linkBackCheckbox.disabled = false;
          linkBackCheckbox.checked = true;
        }
      },
      { controlId: "nemotron-diagram-source", labelId: sourceLabel.id },
    );
    this.selectComponents.push(sourceSelect);

    const diagramControls = paneEl.createEl("fieldset", { cls: "nemotron-diagram-controls" });
    diagramControls.createEl("legend", { text: "Diagram design" });
    const addSelect = (id: string, labelText: string, choices: [string, string][], initial: string, change: (value: string) => void) => {
      const row = diagramControls.createDiv({ cls: "nemotron-form-row" });
      const label = row.createEl("label", { text: labelText, cls: "nemotron-label" });
      label.id = `${id}-label`;
      label.htmlFor = id;
      const select = new CustomSelect(
        row,
        choices.map(([value, optionLabel]) => ({ value, label: optionLabel })),
        initial,
        change,
        { controlId: id, labelId: label.id },
      );
      this.selectComponents.push(select);
    };
    let diagramType: DiagramType | "auto" = "auto";
    let diagramDetail: DiagramOptions["detail"] = "balanced";
    let diagramDirection: DiagramOptions["direction"] = "right";
    let diagramTheme: DiagramTheme = "dark";
    addSelect("nemotron-diagram-type", "Diagram type", [["auto", "Automatic"], ["mind-map", "Mind map"], ["flowchart", "Flowchart"], ["architecture", "Architecture"], ["timeline", "Timeline"], ["decision-tree", "Decision tree"], ["comparison", "Comparison"]], diagramType, (value) => { diagramType = value as DiagramType | "auto"; });
    addSelect("nemotron-diagram-detail", "Detail level", [["compact", "Compact"], ["balanced", "Balanced"], ["detailed", "Detailed"]], diagramDetail, (value) => { diagramDetail = value as DiagramOptions["detail"]; });
    addSelect("nemotron-diagram-direction", "Flow direction", [["right", "Left to right"], ["down", "Top to bottom"]], diagramDirection, (value) => { diagramDirection = value as DiagramOptions["direction"]; });
    addSelect("nemotron-diagram-theme", "Canvas theme", [["dark", "Dark"], ["light", "Light"]], diagramTheme, (value) => { diagramTheme = value as DiagramTheme; });

    // Custom instructions & text input
    const excalPromptRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const excalPromptLabel = excalPromptRow.createEl("label", { text: "Diagram source or instructions", cls: "nemotron-label" });
    const excalPromptArea = excalPromptRow.createEl("textarea", {
      cls: "nemotron-textarea",
      placeholder: hasActiveNote
        ? "Optional: Add specific architectural focus or subsystem requirements..."
        : "Describe the system components, data pipeline, state machine, or microservices...",
    });
    excalPromptArea.rows = 4;
    excalPromptArea.id = "nemotron-diagram-prompt";
    excalPromptArea.name = "diagram-prompt";
    excalPromptLabel.htmlFor = excalPromptArea.id;

    // Status area for Tab 2
    const excalStatusDiv = paneEl.createDiv({ cls: "nemotron-status" });
    excalStatusDiv.setAttribute("role", "status");
    excalStatusDiv.setAttribute("aria-live", "polite");
    excalStatusDiv.style.display = "none";

    // Streaming Preview Area for Tab 2 (Thinking Process & Live Schema Preview)
    const excalPreviewContainer = paneEl.createDiv({ cls: "nemotron-preview-container" });
    excalPreviewContainer.style.display = "none";
    
    const excalReasoningDetails = excalPreviewContainer.createEl("details", { cls: "nemotron-reasoning-box" });
    excalReasoningDetails.createEl("summary", { text: "Thinking Process (Nemotron Reasoning)" });
    const excalReasoningPre = excalReasoningDetails.createEl("pre", { cls: "nemotron-reasoning-content" });

    const excalContentPreviewBox = excalPreviewContainer.createEl("div", { cls: "nemotron-content-box" });
    excalContentPreviewBox.createEl("h4", { text: "Architecture Plan & Diagram Schema Preview:" });
    const excalContentPre = excalContentPreviewBox.createEl("pre", { cls: "nemotron-preview-content" });

    // Buttons for Tab 2
    const excalButtonRow = paneEl.createDiv({ cls: "nemotron-button-row" });
    const generateExcalBtn = excalButtonRow.createEl("button", {
      text: "Generate Excalidraw diagram",
      cls: "mod-cta",
    });
    const cancelExcalBtn = excalButtonRow.createEl("button", {
      text: "Cancel",
    });

    cancelExcalBtn.addEventListener("click", () => {
      if (this.isGenerating && this.abortController) {
        this.abortController.abort();
      }
      this.close();
    });

    generateExcalBtn.addEventListener("click", async () => {
      if (!this.plugin.settings.apiKey || !this.plugin.settings.apiKey.trim()) {
        new Notice("Please enter your NVIDIA API Key first.");
        excalStatusDiv.style.display = "block";
        excalStatusDiv.setText("Error: NVIDIA API Key is required. Please set it above or in Settings.");
        return;
      }

      this.isGenerating = true;
      generateExcalBtn.disabled = true;
      generateExcalBtn.setText("Designing diagram...");
      excalStatusDiv.style.display = "block";
      excalStatusDiv.setText("Extracting concepts and relationships with Nemotron...");

      excalPreviewContainer.style.display = "block";
      excalReasoningPre.setText("");
      excalContentPre.setText("");

      this.abortController = new AbortController();
      const fileSnapshots: FileSnapshot[] = [];
      const foldersCreatedList: string[] = [];
      let generationRecorded = false;

      try {
        let contentToAnalyze = "";
        let noteTitle = "";
        let targetNoteFile: TFile | null = null;

        if (selectedSource === "active_note" && activeView?.file) {
          targetNoteFile = activeView.file;
          noteTitle = activeView.file.basename;
          contentToAnalyze = await this.app.vault.read(activeView.file);
          if (excalPromptArea.value.trim()) {
            contentToAnalyze += `\n\nAdditional Requirements:\n${excalPromptArea.value.trim()}`;
          }
        } else {
          noteTitle = drawingTitleInput.value.trim() || "System Architecture Diagram";
          contentToAnalyze = excalPromptArea.value.trim() || noteTitle;
        }

        const rootExcalFolder = this.plugin.settings.excalidrawFolder || "Excalidrawings";
        const diagramOptions: Partial<DiagramOptions> = {
          type: diagramType,
          detail: diagramDetail,
          direction: diagramDirection,
          theme: diagramTheme,
          maxNodes: diagramDetail === "compact" ? 7 : diagramDetail === "detailed" ? 14 : 10,
        };
        const streamCallbacks = {
          onStatus: (status: string) => {
            excalStatusDiv.setText(status);
          },
          onReasoning: (chunk: string) => {
            excalReasoningPre.setText(excalReasoningPre.getText() + chunk);
          },
          onContent: (chunk: string) => {
            excalContentPre.setText(excalContentPre.getText() + chunk);
            excalContentPre.scrollTop = excalContentPre.scrollHeight;
          },
        };

        if (selectedSource === "active_note" && targetNoteFile) {
          const res = await createMirroredExcalidrawDrawing(
            this.app,
            this.plugin.settings,
            targetNoteFile,
            contentToAnalyze,
            rootExcalFolder,
            streamCallbacks,
            this.abortController.signal,
            diagramOptions
          );
          fileSnapshots.push(res.fileSnapshot);
          foldersCreatedList.push(...res.foldersCreated);

          if (linkBackCheckbox.checked) {
            const existingNoteText = await this.app.vault.read(targetNoteFile);
            const noteFolder = targetNoteFile.parent ? (targetNoteFile.parent.path === "/" ? "" : targetNoteFile.parent.path) : "";
            const excalRelPath = noteFolder
              ? `${rootExcalFolder}/${noteFolder}/${targetNoteFile.basename}.excalidraw`
              : `${rootExcalFolder}/${targetNoteFile.basename}.excalidraw`;

            const linkHeader = `> [!example] Visual Architecture Diagram\n> **Excalidraw Overview:** [[${excalRelPath}|${targetNoteFile.basename} Architecture]]\n\n`;

            if (!existingNoteText.includes(excalRelPath)) {
              let updatedNoteText = "";
              const yamlMatch = existingNoteText.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n*)/);
              if (yamlMatch) {
                const yamlBlock = yamlMatch[1];
                const rest = existingNoteText.slice(yamlBlock.length).trimStart();
                updatedNoteText = `${yamlBlock}${linkHeader}${rest}`;
              } else {
                updatedNoteText = `${linkHeader}${existingNoteText.trimStart()}`;
              }

              await this.app.vault.process(targetNoteFile, (current) => {
                if (current !== existingNoteText) {
                  throw new Error(`Cannot add the diagram link because "${targetNoteFile.path}" changed.`);
                }
                return updatedNoteText;
              });
              fileSnapshots.push({
                path: targetNoteFile.path,
                isNewFile: false,
                previousContent: existingNoteText,
                newContent: updatedNoteText,
              });
            }
          }

          try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(res.drawingFile);
          } catch (openError) {
            console.warn(`Created "${res.drawingPath}" but could not open it:`, openError);
          }
          new Notice(`Rich Excalidraw diagram generated in ${res.drawingPath}!`, 7000);
        } else {
          const customSubfolder = excalFolderInput.value.trim();
          const targetDir = customSubfolder ? `${rootExcalFolder}/${customSubfolder}` : rootExcalFolder;
          const res = await createStandaloneRichExcalidrawDrawing(
            this.app,
            this.plugin.settings,
            noteTitle,
            contentToAnalyze,
            targetDir,
            hasActiveNote && activeView?.file ? activeView.file.path : undefined,
            streamCallbacks,
            this.abortController.signal,
            diagramOptions
          );

          fileSnapshots.push(res.fileSnapshot);
          foldersCreatedList.push(...res.foldersCreated);

          try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(res.drawingFile);
          } catch (openError) {
            console.warn(`Created "${res.drawingPath}" but could not open it:`, openError);
          }
          new Notice(`Standalone Rich Excalidraw diagram generated in ${res.drawingPath}!`, 7000);
        }

        this.plugin.historyManager.recordGeneration({
          id: `${Date.now()}`,
          timestamp: Date.now(),
          mode: "excalidraw",
          description: `Excalidraw: ${noteTitle}`,
          files: fileSnapshots,
          foldersCreated: Array.from(new Set(foldersCreatedList)),
        });
        generationRecorded = true;

        this.renderHistoryToolbar();
        this.close();
      } catch (err: any) {
        if (!generationRecorded && fileSnapshots.length > 0) {
          try {
            await revertFileSnapshots(this.app, fileSnapshots, Array.from(new Set(foldersCreatedList)));
          } catch (rollbackError) {
            console.error("Failed to restore files after Excalidraw error:", rollbackError);
            new Notice("Diagram generation failed. Some files could not be restored. Review the error log.", 10000);
          }
        }
        if (err.name === "AbortError") {
          new Notice("Excalidraw generation cancelled.");
        } else {
          console.error("Excalidraw generation error:", err);
          excalStatusDiv.setText(`Error: ${err.message}`);
          new Notice(`Error: ${err.message}`);
        }
      } finally {
        this.isGenerating = false;
        generateExcalBtn.disabled = false;
        generateExcalBtn.setText("Generate Rich Excalidraw Canvas");
      }
    });
  }

  private renderHistoryToolbar() {
    this.historyRowEl.empty();

    const undoCount = this.plugin.historyManager.getUndoCount();
    const redoCount = this.plugin.historyManager.getRedoCount();
    const promptHistory = this.plugin.historyManager.getPromptHistory();

    if (undoCount === 0 && redoCount === 0 && promptHistory.length === 0) {
      this.historyRowEl.style.display = "none";
      return;
    }

    this.historyRowEl.style.display = "flex";

    const genGroup = this.historyRowEl.createDiv({ cls: "nemotron-history-group" });
    genGroup.createSpan({ text: "Generations:", cls: "nemotron-history-label" });

    const undoBtn = genGroup.createEl("button", {
      text: `Undo (${undoCount})`,
      cls: `nemotron-history-btn ${undoCount === 0 ? "is-disabled" : ""}`,
    });
    undoBtn.disabled = undoCount === 0;
    undoBtn.setAttribute("type", "button");
    undoBtn.addEventListener("click", async () => {
      try {
        const record = await this.plugin.historyManager.undo();
        if (record) {
          new Notice(`Undid: ${record.description}`);
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        }
      } catch (err: any) {
        new Notice(err.message || "The generation cannot be undone safely.", 8000);
      }
    });

    const redoBtn = genGroup.createEl("button", {
      text: `Redo (${redoCount})`,
      cls: `nemotron-history-btn ${redoCount === 0 ? "is-disabled" : ""}`,
    });
    redoBtn.disabled = redoCount === 0;
    redoBtn.setAttribute("type", "button");
    redoBtn.addEventListener("click", async () => {
      try {
        const record = await this.plugin.historyManager.redo();
        if (record) {
          new Notice(`Redid: ${record.description}`);
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        }
      } catch (err: any) {
        new Notice(err.message || "The generation cannot be redone safely.", 8000);
      }
    });

    if (promptHistory.length > 0) {
      const promptGroup = this.historyRowEl.createDiv({ cls: "nemotron-history-group nemotron-prompt-history-group" });
      promptGroup.createSpan({ text: "Prompts:", cls: "nemotron-history-label" });

      const promptBtn = promptGroup.createEl("button", {
        text: `Recent Prompts (${promptHistory.length}) v`,
        cls: "nemotron-history-btn nemotron-prompt-btn",
      });
      promptBtn.setAttribute("type", "button");

      promptBtn.addEventListener("click", (e: MouseEvent) => {
        const menu = new Menu();
        promptHistory.forEach((p, idx) => {
          const timeStr = new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const rawExcerpt = p.preview.replace(/\s+/g, " ").trim();
          const excerpt = rawExcerpt.length > 36 ? rawExcerpt.slice(0, 36) + "..." : rawExcerpt;
          menu.addItem((item) => {
            item.setTitle(`[#${idx + 1}] ${timeStr} - ${excerpt}`)
                .onClick(() => {
                  this.loadPromptIntoModal(p);
                  new Notice(`Restored prompt from history (${timeStr})`);
                });
          });
        });

        const rect = promptBtn.getBoundingClientRect();
        menu.showAtPosition({ x: rect.right, y: rect.bottom + 4, left: true });
      });
    }
  }

  private loadPromptIntoModal(item: PromptHistoryItem) {
    if (this.inputTextAreaEl) {
      this.inputTextAreaEl.value = item.rawText;
    }
    if (this.customInputEl) {
      this.customInputEl.value = item.customInstruction || "";
    }

    if (item.mode && this.modeSelectComponent) {
      this.modeSelectComponent.setValue(item.mode);
      void this.updateModeUI?.(item.mode);
    }

    if (item.style && this.styleSelectComponent) {
      this.selectedStyle = item.style;
      this.styleSelectComponent.setValue(item.style);
    }

    if (item.attachedImages && Array.isArray(item.attachedImages)) {
      this.attachedImages = [...item.attachedImages];
      if (this.renderGalleryCallback) {
        this.renderGalleryCallback();
      }
    }
  }

  private async renderSmartBanner(containerEl: HTMLElement) {
    containerEl.empty();

    const exists = await this.app.vault.adapter.exists(VAULT_INDEX_FILENAME);

    if (!exists) {
      const topRow = containerEl.createDiv({ cls: "nemotron-smart-top-row" });
      const textDiv = topRow.createDiv({ cls: "nemotron-smart-info-text" });
      textDiv.createSpan({
        text: "Hierarchical Knowledge Tree (.nemotron-vault-index.json) required for Smart Placement and Atomic Decomposition.",
      });

      const populateBtn = topRow.createEl("button", {
        text: "Deep Analyze & Populate Knowledge Tree",
        cls: "mod-cta nemotron-reindex-btn",
      });
      populateBtn.setAttribute("type", "button");

      const progressBox = containerEl.createDiv({ cls: "nemotron-index-progress-box" });
      progressBox.style.display = "none";

      const progressHeader = progressBox.createDiv({ cls: "nemotron-index-progress-header" });
      const phaseTitle = progressHeader.createSpan({ text: "Vault Semantic Analysis Progress" });
      const pctSpan = progressHeader.createSpan({ text: "0%", cls: "nemotron-index-progress-pct" });

      const barBg = progressBox.createDiv({ cls: "nemotron-index-progress-bar-bg" });
      const barFill = barBg.createDiv({ cls: "nemotron-index-progress-bar-fill" });

      const statusTextDiv = progressBox.createDiv({ cls: "nemotron-index-progress-status" });
      statusTextDiv.setText("Starting analysis...");

      populateBtn.addEventListener("click", async () => {
        populateBtn.disabled = true;
        populateBtn.setText("Analyzing...");
        progressBox.style.display = "flex";

        try {
          const index = await buildOrUpdateVaultIndex(
            this.app,
            this.plugin.settings,
            (curr, total, status) => {
              const pct = total > 0 ? Math.round((curr / total) * 100) : 0;
              pctSpan.setText(`${pct}%`);
              barFill.style.width = `${pct}%`;
              statusTextDiv.setText(status);
              phaseTitle.setText(curr === total ? "Finalizing Hierarchy..." : "Analyzing Vault Knowledge...");
            }
          );
          new Notice(`Hierarchical Knowledge Tree populated: ${index.totalNotes} notes across ${index.totalFolders} folders.`);
          await this.renderSmartBanner(containerEl);
        } catch (err: any) {
          new Notice(`Error during deep indexing: ${err.message}`);
          populateBtn.setText("Deep Analyze & Populate Knowledge Tree");
          populateBtn.disabled = false;
          progressBox.style.display = "none";
        }
      });
    } else {
      const textDiv = containerEl.createDiv({ cls: "nemotron-smart-info-text" });
      const isMulti = this.selectedMode === "multi_note";
      textDiv.createSpan({
        text: isMulti
          ? "Atomic Decomposition Active: Input will be decomposed into multiple atomic notes and routed/appended across your vault."
          : "Smart Auto-Routing Active: AI analyzes your vault tree & topics to automatically place this note or append to the right note.",
      });
    }
  }

  private renderApiKeySection(containerEl: HTMLElement) {
    containerEl.empty();

    const isSet = !!(this.plugin.settings.apiKey && this.plugin.settings.apiKey.trim());

    if (!isSet) {
      const card = containerEl.createDiv({ cls: "nemotron-api-setup-card" });
      
      const header = card.createDiv({ cls: "nemotron-api-setup-header" });
      header.createSpan({ text: "NVIDIA API Key Required", cls: "nemotron-api-setup-title" });
      
      const nimLink = header.createEl("a", {
        text: "Open NVIDIA NIM (build.nvidia.com)",
        cls: "nemotron-nim-link",
      });
      nimLink.addEventListener("click", (e) => {
        e.preventDefault();
        window.open("https://build.nvidia.com", "_blank");
      });

      const inputRow = card.createDiv({ cls: "nemotron-api-input-row" });
      const keyInput = inputRow.createEl("input", {
        type: "password",
        placeholder: "Paste your key here (nvapi-...)",
        cls: "nemotron-input nemotron-api-input",
      });

      const revealBtn = inputRow.createEl("button", { text: "Show", cls: "nemotron-icon-btn" });
      revealBtn.setAttribute("type", "button");
      revealBtn.setAttribute("title", "Show/hide key");
      revealBtn.addEventListener("click", () => {
        keyInput.type = keyInput.type === "password" ? "text" : "password";
        revealBtn.setText(keyInput.type === "password" ? "Show" : "Hide");
      });

      const pasteKeyBtn = inputRow.createEl("button", {
        text: "Paste",
        cls: "nemotron-paste-clipboard-btn",
      });
      pasteKeyBtn.setAttribute("type", "button");
      pasteKeyBtn.addEventListener("click", async () => {
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
          keyInput.value = text.trim();
        }
      });

      const saveKeyBtn = inputRow.createEl("button", {
        text: "Save",
        cls: "mod-cta nemotron-save-key-btn",
      });
      saveKeyBtn.setAttribute("type", "button");
      saveKeyBtn.addEventListener("click", async () => {
        const val = keyInput.value.trim();
        if (!val) {
          new Notice("Please enter a valid API key.");
          return;
        }
        this.plugin.settings.apiKey = val;
        await this.plugin.saveSettings();
        new Notice("NVIDIA API key saved successfully!");
        this.renderApiKeySection(containerEl);
      });
    } else {
      const chipRow = containerEl.createDiv({ cls: "nemotron-api-chip-row" });
      const maskedKey = `${this.plugin.settings.apiKey.slice(0, 8)}...${this.plugin.settings.apiKey.slice(-4)}`;
      chipRow.createSpan({ text: `NVIDIA Key: ${maskedKey}`, cls: "nemotron-api-chip-text" });

      const editBtn = chipRow.createEl("a", { text: "Change", cls: "nemotron-chip-link" });
      editBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.plugin.settings.apiKey = "";
        this.renderApiKeySection(containerEl);
      });

      const nimLink = chipRow.createEl("a", {
        text: "NVIDIA NIM",
        cls: "nemotron-chip-link",
      });
      nimLink.addEventListener("click", (e) => {
        e.preventDefault();
        window.open("https://build.nvidia.com", "_blank");
      });
    }
  }

  onClose() {
    if (this.isGenerating && this.abortController) {
      this.abortController.abort();
    }
    if (this.pasteListener) {
      window.removeEventListener("paste", this.pasteListener, true);
    }
    this.selectComponents.forEach((select) => select.destroy());
    this.selectComponents = [];
    this.folderNavigators.forEach((navigator) => navigator.destroy());
    this.folderNavigators = [];
    this.updateModeUI = undefined;
    const { contentEl } = this;
    contentEl.empty();
  }

  private async createNewNoteFile(
    content: string,
    requestedTitle?: string,
    requestedFolder?: string,
    enableProperties: boolean = true,
    generateExcalidraw: boolean = true,
    folderDepthLimit: number | null = 2,
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    let title = requestedTitle;
    let finalContent = sanitizeMermaidDiagrams(content);
    const snaps: FileSnapshot[] = [];
    const foldersCreated: string[] = [];

    if (!enableProperties) {
      finalContent = finalContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
    }

    if (!title) {
      const yamlTitleMatch = finalContent.match(/^title:\s*["']?([^"'\n\r]+)["']?/m);
      if (yamlTitleMatch) {
        title = yamlTitleMatch[1].trim();
      } else {
        const headingMatch = finalContent.match(/^#\s+(.+)$/m);
        if (headingMatch) {
          title = headingMatch[1].trim();
        } else {
          const dateStr = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
          title = `Nemotron Note ${dateStr}`;
        }
      }
    }

    let safeTitle = title.replace(/[\\/:\*\?"<>\|]/g, "_").trim();
    if (!safeTitle) {
      const dateStr = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
      safeTitle = `Nemotron Note ${dateStr}`;
    }

    if (requestedFolder?.split(/[\\/]+/).some((segment) => segment === "..")) {
      throw new Error("The target folder cannot contain a parent-directory segment.");
    }
    const selectedFolder = folderDepthLimit === null
      ? normalizePath(requestedFolder || "").replace(/^\/+|\/+$/g, "")
      : enforceMaxDepthFolder(requestedFolder, folderDepthLimit);
    let folder = selectedFolder ? normalizePath(selectedFolder) : "";
    if (folder === "." || folder === "/") folder = "";

    if (folder) {
      const segments = folder.split("/");
      let currentPath = "";
      for (const segment of segments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const exists = this.app.vault.getAbstractFileByPath(currentPath);
        if (!exists) {
          await this.app.vault.createFolder(currentPath);
          foldersCreated.push(currentPath);
        }
      }
    }

    let filePath = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;
    filePath = normalizePath(filePath);

    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      const altTitle = `${safeTitle} (${counter})`;
      filePath = folder ? `${folder}/${altTitle}.md` : `${altTitle}.md`;
      filePath = normalizePath(filePath);
      counter++;
    }

    const excalFolder = this.plugin.settings.excalidrawFolder || "Excalidrawings";
    const newFile = (await this.app.vault.create(filePath, finalContent)) as TFile;

    const noteSnapshot: FileSnapshot = {
      path: filePath,
      isNewFile: true,
      newContent: finalContent,
    };
    snaps.push(noteSnapshot);

    // Generate High-Effort Mirrored Excalidraw Architecture Drawing with Nemotron
    if (generateExcalidraw) {
      try {
        const excalRes = await createMirroredExcalidrawDrawing(
          this.app,
          this.plugin.settings,
          newFile,
          finalContent,
          excalFolder
        );
        const actualTitle = newFile.basename;
        const excalRelPath = folder
          ? `${excalFolder}/${folder}/${actualTitle}.excalidraw`
          : `${excalFolder}/${actualTitle}.excalidraw`;
        const excalHeader = `> [!example] Visual Architecture Diagram\n> **Excalidraw Overview:** [[${excalRelPath}|${actualTitle} Architecture]]\n\n`;
        const yamlMatch = finalContent.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n*)/);
        const linkedContent = yamlMatch
          ? `${yamlMatch[1]}${excalHeader}${finalContent.slice(yamlMatch[1].length).trimStart()}`
          : `${excalHeader}${finalContent.trimStart()}`;

        try {
          await this.app.vault.process(newFile, (current) => {
            if (current !== finalContent) {
              throw new Error(`Cannot add the diagram link because "${newFile.path}" changed.`);
            }
            return linkedContent;
          });
        } catch (linkError) {
          await revertFileSnapshots(this.app, [excalRes.fileSnapshot], excalRes.foldersCreated);
          throw linkError;
        }

        finalContent = linkedContent;
        noteSnapshot.newContent = linkedContent;
        snaps.push(excalRes.fileSnapshot);
        foldersCreated.push(...excalRes.foldersCreated);
      } catch (exErr) {
        console.warn("Excalidraw generation warning:", exErr);
      }
    }

    if (this.plugin.settings.autoOpenCreatedNote) {
      try {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(newFile as TFile);
      } catch (openError) {
        console.warn(`Created "${newFile.path}" but could not open it:`, openError);
      }
    }

    return {
      snaps,
      foldersCreated,
    };
  }

  private async appendToFile(
    file: TFile,
    content: string,
    enableProperties: boolean = true,
    reason?: string
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    const existingContent = await this.app.vault.read(file);
    let finalExistingContent = existingContent;
    const sanitizedIncomingContent = sanitizeMermaidDiagrams(content);
    const snaps: FileSnapshot[] = [];
    const foldersCreated: string[] = [];

    const countWords = (text: string) => text.trim().split(/\s+/).filter((w) => w.length > 0).length;
    const currentWordCount = countWords(existingContent);
    const newWordCount = countWords(sanitizedIncomingContent);
    const maxWords = this.plugin.settings.maxNoteWordCount || 600;
    const autoSplitEnabled = this.plugin.settings.enableAutoSplitLongNotes ?? true;

    // Check if appending would exceed optimal atomic note length
    if (autoSplitEnabled && currentWordCount + newWordCount > maxWords && currentWordCount >= 200) {
      let baseTitle = file.basename;
      let nextPartNum = 2;

      const partSuffixMatch = baseTitle.match(/^(.*?)\s*-\s*Part\s*(\d+)$/i);
      const parenMatch = baseTitle.match(/^(.*?)\s*\(Part\s*(\d+)\)$/i);
      const continuedMatch = baseTitle.match(/^(.*?)\s*-\s*Continued(?:\s*(\d+))?$/i);

      if (partSuffixMatch) {
        baseTitle = partSuffixMatch[1].trim();
        nextPartNum = parseInt(partSuffixMatch[2], 10) + 1;
      } else if (parenMatch) {
        baseTitle = parenMatch[1].trim();
        nextPartNum = parseInt(parenMatch[2], 10) + 1;
      } else if (continuedMatch) {
        baseTitle = continuedMatch[1].trim();
        nextPartNum = (continuedMatch[2] ? parseInt(continuedMatch[2], 10) : 2) + 1;
      }

      const namingFormat = this.plugin.settings.splitNamingFormat || "part_suffix";
      let nextPartTitle = `${baseTitle} - Part ${nextPartNum}`;
      if (namingFormat === "parenthesis") {
        nextPartTitle = `${baseTitle} (Part ${nextPartNum})`;
      } else if (namingFormat === "continued") {
        nextPartTitle = nextPartNum === 2 ? `${baseTitle} - Continued` : `${baseTitle} - Continued ${nextPartNum}`;
      }

      const forwardContinuation = `\n\n---\n> [!info] Continued in [[${nextPartTitle}]]\n`;
      const updatedPart1Content = existingContent.trimEnd() + forwardContinuation;

      const currentDate = new Date().toISOString().split("T")[0];
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const timestampFormatted = `${currentDate} ${hours}:${minutes}`;

      const reasonLine = reason && reason.trim() ? `\n> **Reason:** ${reason.trim()}` : "";
      const bodyToAppend = sanitizedIncomingContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

      let part2Content = "";
      if (enableProperties) {
        part2Content += `---
title: "${nextPartTitle}"
aliases: []
tags:
  - notes
created: "${currentDate}"
part: ${nextPartNum}
continued_from: "[[${file.basename}]]"
summary: "Continuation of [[${file.basename}]]"
---

`;
      }

      part2Content += `> [!info] Continued from [[${file.basename}]]\n\n`;
      part2Content += `> [!info] Created on ${timestampFormatted}${reasonLine}\n\n`;
      part2Content += bodyToAppend + "\n";

      const targetFolder = file.parent ? (file.parent.path === "/" ? "" : file.parent.path) : "";
      const newPartRes = await this.createNewNoteFile(part2Content, nextPartTitle, targetFolder, enableProperties, this.enableExcalidrawInNoteTab);
      snaps.push(...newPartRes.snaps);
      foldersCreated.push(...newPartRes.foldersCreated);

      try {
        await this.app.vault.process(file, (current) => {
          if (current !== existingContent) {
            throw new Error(`Cannot split "${file.path}" because it changed during generation.`);
          }
          return updatedPart1Content;
        });
      } catch (updateError) {
        await revertFileSnapshots(this.app, newPartRes.snaps, newPartRes.foldersCreated);
        throw updateError;
      }

      snaps.push({
        path: file.path,
        isNewFile: false,
        previousContent: existingContent,
        newContent: updatedPart1Content,
      });

      new Notice(`Note reached optimal length (${currentWordCount} words). Created sequence: [[${nextPartTitle}]]`, 8000);
      return { snaps, foldersCreated };
    }

    // Normal In-Place Append
    const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(existingContent);
    if (enableProperties && !hasFrontmatter) {
      const currentDate = new Date().toISOString().split("T")[0];
      const frontmatterBlock = `---
title: "${file.basename}"
aliases: []
tags:
  - notes
created: "${currentDate}"
summary: "Note covering ${file.basename}"
---

`;
      finalExistingContent = frontmatterBlock + existingContent.trimStart();
    }

    const bodyToAppend = sanitizedIncomingContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const timestampFormatted = `${dateStr} ${hours}:${minutes}`;

    const reasonLine = reason && reason.trim() ? `\n> **Reason:** ${reason.trim()}` : "";
    const updateHeader = `\n\n---\n> [!info] Appended on ${timestampFormatted}${reasonLine}\n\n`;

    const updatedContent = finalExistingContent.trimEnd() + updateHeader + bodyToAppend + "\n";
    await this.app.vault.modify(file, updatedContent);

    if (this.plugin.settings.autoOpenCreatedNote) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }

    snaps.push({
      path: file.path,
      isNewFile: false,
      previousContent: existingContent,
      newContent: updatedContent,
    });

    return { snaps, foldersCreated };
  }

  private async appendToActiveNote(
    content: string,
    enableProperties: boolean = true,
    reason?: string
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      throw new Error("No active markdown note found to append to.");
    }

    return await this.appendToFile(activeView.file, content, enableProperties, reason);
  }
}

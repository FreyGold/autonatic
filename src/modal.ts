import { App, Modal, Notice, MarkdownView, normalizePath, TFile, TFolder, Menu } from "obsidian";
import type NemotronPlugin from "./main";
import { generateNemotronNote, sanitizeMermaidDiagrams, streamChatCompletion } from "./api";
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
  resolveAtomicPlacementPlan,
  resolveAtomicPlacementTarget,
  resolveFolderWithinScope,
  selectStrongRelatedNote,
  selectVaultContext,
} from "./privacy-controls";
import {
  DESTINATION_MODE_OPTIONS,
  supportsPlacementFolderScope,
  type DestinationMode,
} from "./destination-modes";
import type { VaultKnowledgeIndex } from "./vault-indexer";
import { organizeAtomicPlan } from "./atomic-organization-planner";
import { normalizeGeneratedNoteMarkdown } from "./generated-markdown";
import { FileSnapshot, PromptHistoryItem, revertFileSnapshots } from "./history-manager";
import {
  createMirroredExcalidrawDrawing,
  createStandaloneRichExcalidrawDrawing,
  getMirroredDrawingPath,
  planUsefulDiagrams,
} from "./excalidraw-generator";
import type { SmartNoteChange } from "./useful-diagram-planner";
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
  selectedMode: DestinationMode = "smart";
  selectedStyle: "concise" | "detailed" = "concise";
  enableExcalidrawInNoteTab: boolean = true;
  historyRowEl!: HTMLElement;
  modeSelectComponent!: CustomSelect;
  styleSelectComponent!: CustomSelect;
  private selectComponents: CustomSelect[] = [];
  private folderNavigators: FolderNavigator[] = [];
  private updateModeUI?: (mode: DestinationMode) => Promise<void>;
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
    const modeOptions: SelectOption[] = DESTINATION_MODE_OPTIONS.map((option) => option.value === "append"
      ? {
          ...option,
          label: hasActiveNote ? `Append to Active Note (${activeView?.file?.basename})` : option.label,
          description: hasActiveNote
            ? `Adds the generated content to "${activeView?.file?.basename}".`
            : "Disabled: Open a note in the editor first to append.",
          disabled: !hasActiveNote,
        }
      : { ...option });

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

    let limitPlacementToFolder = false;
    let currentPlacementScopeFolder = initialFolder;
    const smartScopeOptionsDiv = paneEl.createDiv({ cls: "nemotron-smart-scope-options" });
    const smartScopeToggleRow = smartScopeOptionsDiv.createDiv({ cls: "nemotron-checkbox-row nemotron-smart-scope-toggle" });
    const smartScopeCheckbox = smartScopeToggleRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    smartScopeCheckbox.id = "nemotron-smart-folder-scope-toggle";
    smartScopeCheckbox.setAttribute("aria-controls", "nemotron-smart-folder-scope-options");

    const smartScopeToggleLabel = smartScopeToggleRow.createEl("label", { cls: "nemotron-checkbox-label" });
    smartScopeToggleLabel.htmlFor = smartScopeCheckbox.id;
    smartScopeToggleLabel.createSpan({ text: "Limit note placement to a folder", cls: "nemotron-checkbox-title" });
    smartScopeToggleLabel.createSpan({
      text: " Smart Placement and Atomic Decomposition can create or append only in this folder and its subfolders.",
      cls: "nemotron-checkbox-desc",
    });

    const smartScopeFolderOptions = smartScopeOptionsDiv.createDiv({ cls: "nemotron-smart-scope-folder" });
    smartScopeFolderOptions.id = "nemotron-smart-folder-scope-options";
    const smartScopeFolderRow = smartScopeFolderOptions.createDiv({ cls: "nemotron-form-row" });
    smartScopeFolderRow.createEl("label", { text: "Placement Folder:", cls: "nemotron-label" });
    smartScopeFolderRow.createEl("div", {
      text: "The limit includes all notes and folders below the selected folder.",
      cls: "nemotron-folder-scope-help",
    });
    const smartFolderNavigator = new FolderNavigator(
      this.app,
      smartScopeFolderRow,
      initialFolder,
      (newPath) => {
        currentPlacementScopeFolder = newPath;
      },
    );
    this.folderNavigators.push(smartFolderNavigator);

    const updateSmartScopeVisibility = () => {
      limitPlacementToFolder = smartScopeCheckbox.checked;
      smartScopeCheckbox.setAttribute("aria-expanded", limitPlacementToFolder ? "true" : "false");
      smartScopeFolderOptions.style.display = limitPlacementToFolder ? "block" : "none";
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

    const updateModeUI = async (mode: DestinationMode) => {
      this.selectedMode = mode;
      if (supportsPlacementFolderScope(mode)) {
        smartModeInfo.style.display = "flex";
        smartScopeOptionsDiv.style.display = "block";
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
        updateModeUI(val as DestinationMode);
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

    // 3. Useful Excalidraw Diagram Toggle Row
    const excalRow = paneEl.createDiv({ cls: "nemotron-form-row nemotron-checkbox-row" });
    const excalCheckbox = excalRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    excalCheckbox.id = "nemotron-note-excalidraw-toggle";
    excalCheckbox.checked = this.enableExcalidrawInNoteTab;
    excalCheckbox.addEventListener("change", () => {
      this.enableExcalidrawInNoteTab = excalCheckbox.checked;
    });

    const excalLabel = excalRow.createEl("label", { cls: "nemotron-checkbox-label" });
    excalLabel.setAttribute("for", "nemotron-note-excalidraw-toggle");
    excalLabel.createSpan({ text: "Create useful diagrams after note placement", cls: "nemotron-checkbox-title" });
    excalLabel.createSpan({
      text: ` Smart can create, update, or skip diagrams. Approved drawings are mirrored in /${this.plugin.settings.excalidrawFolder || "Excalidrawings"}.`,
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
      const placementScopeFolder = supportsPlacementFolderScope(mode) && limitPlacementToFolder
        ? currentPlacementScopeFolder
        : undefined;

      if (placementScopeFolder) {
        const scopeTarget = this.app.vault.getAbstractFileByPath(normalizePath(placementScopeFolder));
        if (!(scopeTarget instanceof TFolder)) {
          new Notice(`The placement folder does not exist: ${placementScopeFolder}`);
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
        .filter((file) => placementScopeFolder === undefined || isPathInFolder(file.path, placementScopeFolder))
        .map((f) => f.basename)
        .filter((b) => b && !b.startsWith("."));
      const existingVaultFolders = this.app.vault
        .getAllLoadedFiles()
        .filter((entry): entry is TFolder => entry instanceof TFolder)
        .map((folder) => folder.path)
        .filter((path) => path && path !== placementScopeFolder)
        .filter((path) => placementScopeFolder === undefined || isPathInFolder(path, placementScopeFolder));

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
          placementScopeFolder,
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
        placementScopeFolder,
        existingVaultFolders,
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
          ? placementScopeFolder !== undefined
            ? `Analyzing notes in ${placementScopeFolder || "Vault Root"}...`
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

        const finishUsefulDiagrams = async () => {
          if (!this.enableExcalidrawInNoteTab) return;
          const summary = await this.createUsefulDiagramsAfterPlacement(
            fileSnapshots,
            foldersCreatedList,
            (status) => statusDiv.setText(status),
            this.abortController?.signal,
          );
          const updatedText = summary.updated > 0 ? `, ${summary.updated} updated` : "";
          const failedText = summary.failed > 0 ? `, ${summary.failed} failed` : "";
          new Notice(
            `Useful diagrams: ${summary.created} created${updatedText}, ${summary.skipped} skipped${failedText}.`,
            8000,
          );
        };

        if (mode === "multi_note" || mode === "multi_note_folder") {
          let plan = extractAtomicDecompositionPlan(result.content);
          if (mode === "multi_note") {
            statusDiv.setText("Reviewing the complete note and folder plan...");
            plan = await organizeAtomicPlan(
              plan,
              {
                scopeFolder: placementScopeFolder,
                existingFolders: existingVaultFolders,
              },
              async (systemPrompt, userPrompt) => {
                const organizationResult = await streamChatCompletion(
                  {
                    ...this.plugin.settings,
                    temperature: 0.2,
                    topP: 0.9,
                  },
                  systemPrompt,
                  userPrompt,
                  { onStatus: (status) => statusDiv.setText(status) },
                  this.abortController?.signal,
                );
                return organizationResult.content;
              },
            );
          }
          statusDiv.setText("Placing notes...");
          const placementPlan = mode === "multi_note"
            ? resolveAtomicPlacementPlan(plan, placementScopeFolder, existingVaultFolders)
            : [];
          let createdCount = 0;
          let appendedCount = 0;
          const fixedTargetFolder = mode === "multi_note_folder" ? currentSelectedFolder : undefined;

          for (const [itemIndex, item] of plan.entries()) {
            try {
              if (fixedTargetFolder !== undefined) {
                const { snaps, foldersCreated } = await this.createNewNoteFile(
                  item.content,
                  item.title,
                  fixedTargetFolder,
                  enableProperties,
                  null,
                );
                fileSnapshots.push(...snaps);
                foldersCreatedList.push(...foldersCreated);
                createdCount++;
              } else {
                const target = placementPlan[itemIndex] || resolveAtomicPlacementTarget(item, placementScopeFolder);
                const targetFile = target.action === "append_to_note"
                  ? this.app.vault.getAbstractFileByPath(normalizePath(target.targetNotePath))
                  : null;
                if (targetFile instanceof TFile) {
                  const { snaps, foldersCreated } = await this.appendToFile(targetFile, item.content, enableProperties, item.reason);
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  appendedCount++;
                } else {
                  const { snaps, foldersCreated } = await this.createNewNoteFile(
                    item.content,
                    item.title,
                    target.targetFolder,
                    enableProperties,
                  );
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  createdCount++;
                }
              }
            } catch (itemErr: any) {
              throw new Error(`Failed to process "${item.title}": ${itemErr.message}`, { cause: itemErr });
            }
          }

          await finishUsefulDiagrams();

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
            ? placementScopeFolder === undefined || isPathInFolder(decision.targetNotePath, placementScopeFolder)
            : false;
          const requestedTarget = requestedTargetIsInScope && decision?.targetNotePath
            ? this.app.vault.getAbstractFileByPath(normalizePath(decision.targetNotePath))
            : null;
          const relatedNote = vaultIndexForPlacement
            ? selectStrongRelatedNote(vaultIndexForPlacement, cleanedContent, placementScopeFolder)
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
            const targetFolder = resolveFolderWithinScope(rawFolder, placementScopeFolder);
            const title = decision?.title || titleInput.value.trim();
            const { snaps, foldersCreated } = await this.createNewNoteFile(cleanedContent, title, targetFolder, enableProperties);
            fileSnapshots.push(...snaps);
            foldersCreatedList.push(...foldersCreated);
            const outsideScopeTarget = decision?.action === "append_to_note" && !requestedTargetIsInScope;
            const reason = outsideScopeTarget
              ? `The suggested note was outside the selected folder scope. A new note was created inside ${placementScopeFolder || "Vault Root"}.`
              : decision?.reason;
            const reasonMsg = reason ? `\nReason: ${reason}` : "";
            new Notice(`Smart Placed in folder: "${targetFolder || "Vault Root"}"${reasonMsg}`, 7000);
          }

          await finishUsefulDiagrams();

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
          const { snaps, foldersCreated } = await this.createNewNoteFile(result.content, titleInput.value.trim(), targetFolder, enableProperties);
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);

          await finishUsefulDiagrams();
          
          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "new_file",
            description: `Created note: ${snaps[0]?.path || "New note"}`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });
          generationRecorded = true;

          new Notice("Obsidian note created successfully!");
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else {
          const { snaps, foldersCreated } = await this.appendToActiveNote(result.content, enableProperties, customInstruction || "Appended section via Nemotron");
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);

          await finishUsefulDiagrams();

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
    const exists = await this.app.vault.adapter.exists(VAULT_INDEX_FILENAME);
    containerEl.empty();

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
          ? "Atomic Decomposition Active: Keeps notes at the right level, reuses relevant folders, and creates a folder when the AI identifies a durable topic."
          : "Smart Auto-Routing Active: AI analyzes your vault tree & topics to automatically place this note or append to the right note.",
      });
    }
  }

  private renderApiKeySection(containerEl: HTMLElement) {
    containerEl.empty();

    const modelRow = containerEl.createDiv({ cls: "nemotron-current-model-row" });
    modelRow.createSpan({ text: "Current model", cls: "nemotron-current-model-label" });
    modelRow.createEl("code", {
      text: this.plugin.settings.model || "Not set",
      cls: "nemotron-current-model-value",
    });

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

  private async createUsefulDiagramsAfterPlacement(
    fileSnapshots: FileSnapshot[],
    foldersCreatedList: string[],
    onStatus?: (status: string) => void,
    signal?: AbortSignal,
  ): Promise<{ created: number; updated: number; skipped: number; failed: number }> {
    const changes = this.collectSmartNoteChanges(fileSnapshots);
    const plan = await planUsefulDiagrams(
      this.plugin.settings,
      changes,
      this.plugin.settings.maxAutomaticDiagrams ?? 3,
      { onStatus },
      signal,
    );
    let created = 0;
    let updated = 0;
    let failed = 0;
    const rootFolder = this.plugin.settings.excalidrawFolder || "Excalidrawings";

    for (const decision of plan.selected) {
      const noteFile = this.app.vault.getAbstractFileByPath(normalizePath(decision.notePath));
      if (!(noteFile instanceof TFile)) {
        failed++;
        continue;
      }
      try {
        onStatus?.(`${decision.action === "update" ? "Updating" : "Creating"} a useful diagram for ${noteFile.basename}...`);
        const noteContent = await this.app.vault.read(noteFile);
        const expectedSnapshot = [...fileSnapshots].reverse().find((snapshot) => snapshot.path === noteFile.path);
        if (!expectedSnapshot || expectedSnapshot.newContent !== noteContent) {
          throw new Error(`Cannot create a diagram because "${noteFile.path}" changed after note placement.`);
        }
        const drawing = await createMirroredExcalidrawDrawing(
          this.app,
          this.plugin.settings,
          noteFile,
          noteContent,
          rootFolder,
          { onStatus },
          signal,
          {
            type: decision.type || "auto",
            detail: "balanced",
            maxNodes: 8,
            focusQuestion: decision.focusQuestion,
            allowFallback: false,
          },
        );
        try {
          await this.addDiagramLinkToChangedNote(noteFile, drawing.drawingPath, noteContent, fileSnapshots);
        } catch (linkError) {
          await revertFileSnapshots(this.app, [drawing.fileSnapshot], drawing.foldersCreated);
          throw linkError;
        }
        fileSnapshots.push(drawing.fileSnapshot);
        foldersCreatedList.push(...drawing.foldersCreated);
        if (decision.action === "update") updated++;
        else created++;
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        failed++;
        console.warn(`Useful diagram generation failed for "${decision.notePath}":`, error);
      }
    }

    return { created, updated, skipped: plan.skipped.length, failed };
  }

  private collectSmartNoteChanges(fileSnapshots: FileSnapshot[]): SmartNoteChange[] {
    const rootFolder = this.plugin.settings.excalidrawFolder || "Excalidrawings";
    const collected = new Map<string, { first: FileSnapshot; last: FileSnapshot }>();
    for (const snapshot of fileSnapshots) {
      if (!snapshot.path.endsWith(".md") || snapshot.path.endsWith(".excalidraw.md")) continue;
      const current = collected.get(snapshot.path);
      if (current) current.last = snapshot;
      else collected.set(snapshot.path, { first: snapshot, last: snapshot });
    }

    const changes: SmartNoteChange[] = [];
    for (const [path, snapshots] of collected) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) continue;
      const previousContent = snapshots.first.previousContent || "";
      const finalContent = snapshots.last.newContent;
      const addedContent = finalContent.startsWith(previousContent)
        ? finalContent.slice(previousContent.length).trim()
        : finalContent;
      const drawingPath = getMirroredDrawingPath(file, rootFolder);
      const existingDrawing = this.app.vault.getAbstractFileByPath(drawingPath);
      changes.push({
        path,
        title: file.basename,
        action: snapshots.first.isNewFile ? "created" : /Continued in \[\[/.test(addedContent) ? "split" : "appended",
        addedContent,
        finalContent,
        existingDrawingPath: existingDrawing instanceof TFile ? drawingPath : undefined,
      });
    }
    return changes;
  }

  private async addDiagramLinkToChangedNote(
    noteFile: TFile,
    drawingPath: string,
    expectedContent: string,
    fileSnapshots: FileSnapshot[],
  ): Promise<void> {
    const wikiTarget = drawingPath.replace(/\.md$/i, "");
    const currentContent = await this.app.vault.read(noteFile);
    if (currentContent !== expectedContent) {
      throw new Error(`Cannot add the diagram link because "${noteFile.path}" changed.`);
    }
    if (currentContent.includes(`[[${wikiTarget}`)) return;
    const callout = `> [!example] Useful diagram\n> **Excalidraw:** [[${wikiTarget}|${noteFile.basename} Diagram]]\n\n`;
    const yamlMatch = currentContent.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n*)/);
    const linkedContent = yamlMatch
      ? `${yamlMatch[1]}${callout}${currentContent.slice(yamlMatch[1].length).trimStart()}`
      : `${callout}${currentContent.trimStart()}`;

    await this.app.vault.process(noteFile, (current) => {
      if (current !== currentContent) {
        throw new Error(`Cannot add the diagram link because "${noteFile.path}" changed.`);
      }
      return linkedContent;
    });

    const lastSnapshot = [...fileSnapshots].reverse().find((snapshot) => snapshot.path === noteFile.path);
    if (lastSnapshot?.newContent === currentContent) {
      lastSnapshot.newContent = linkedContent;
    } else {
      fileSnapshots.push({
        path: noteFile.path,
        isNewFile: false,
        previousContent: currentContent,
        newContent: linkedContent,
      });
    }
  }

  private async createNewNoteFile(
    content: string,
    requestedTitle?: string,
    requestedFolder?: string,
    enableProperties: boolean = true,
    folderDepthLimit: number | null = 2,
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    let title = requestedTitle;
    let finalContent = sanitizeMermaidDiagrams(normalizeGeneratedNoteMarkdown(content));
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

    title = title.replace(/(?:\.md)+$/i, "");
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

    const newFile = (await this.app.vault.create(filePath, finalContent)) as TFile;

    const noteSnapshot: FileSnapshot = {
      path: filePath,
      isNewFile: true,
      newContent: finalContent,
    };
    snaps.push(noteSnapshot);

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
      const newPartRes = await this.createNewNoteFile(part2Content, nextPartTitle, targetFolder, enableProperties);
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

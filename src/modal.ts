import { App, Modal, Notice, MarkdownView, normalizePath, TFile, Menu } from "obsidian";
import type NemotronPlugin from "./main";
import { generateNemotronNote } from "./api";
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
import { FileSnapshot, PromptHistoryItem } from "./history-manager";
import { createMirroredExcalidrawDrawing } from "./excalidraw-generator";

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
  pasteListener: (e: ClipboardEvent) => void;
  selectedMode: "smart" | "multi_note" | "new_file" | "append" = "smart";
  selectedStyle: "concise" | "detailed" = "concise";
  enableExcalidraw: boolean = true;
  historyRowEl: HTMLElement;
  modeSelectComponent: CustomSelect;
  styleSelectComponent: CustomSelect;
  renderGalleryCallback?: () => void;
  inputTextAreaEl?: HTMLTextAreaElement;
  customInputEl?: HTMLInputElement;

  constructor(app: App, plugin: NemotronPlugin, initialText: string = "") {
    super(app);
    this.plugin = plugin;
    this.initialText = initialText;
    this.enableExcalidraw = plugin.settings.enableExcalidrawMindMap ?? true;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nemotron-modal-container");

    // Modal Header with Title & API Key Status
    const headerRow = contentEl.createDiv({ cls: "nemotron-modal-header-row" });
    headerRow.createEl("h2", { text: "Nemotron Note Crafter", cls: "nemotron-modal-title" });

    // History Toolbar Row (Undo / Redo up to 3 generations & Recent Prompts up to 5)
    this.historyRowEl = contentEl.createDiv({ cls: "nemotron-history-toolbar" });
    this.renderHistoryToolbar();

    // Inline API Key Management Bar
    const apiKeyBar = contentEl.createDiv({ cls: "nemotron-api-key-bar" });
    this.renderApiKeySection(apiKeyBar);

    // Detect active note
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasActiveNote = !!(activeView && activeView.file);

    // 1. Destination Mode Selector (4 Options)
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

    const modeContainer = contentEl.createDiv({ cls: "nemotron-form-row" });
    modeContainer.createEl("label", { text: "Destination Mode:", cls: "nemotron-label" });

    // Smart & Multi-Note Mode Info Banner container
    const smartModeInfo = contentEl.createDiv({ cls: "nemotron-smart-info-banner" });
    await this.renderSmartBanner(smartModeInfo);

    // New Note Options Container (Manual Folder & Title)
    const newNoteOptionsDiv = contentEl.createDiv({ cls: "nemotron-new-note-options" });

    const titleRow = newNoteOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    titleRow.createEl("label", { text: "Note Title (optional):", cls: "nemotron-label" });
    const titleInput = titleRow.createEl("input", {
      type: "text",
      placeholder: "Auto-detected from note content if left blank",
      cls: "nemotron-input",
    });

    // Detect initial folder
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

    const folderRow = newNoteOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    folderRow.createEl("label", { text: "Target Folder Location:", cls: "nemotron-label" });
    
    let currentSelectedFolder = initialFolder;
    new FolderNavigator(
      this.app,
      folderRow,
      initialFolder,
      (newPath) => {
        currentSelectedFolder = newPath;
      }
    );

    const updateModeUI = async (mode: "smart" | "multi_note" | "new_file" | "append") => {
      this.selectedMode = mode;
      if (mode === "smart" || mode === "multi_note") {
        smartModeInfo.style.display = "flex";
        await this.renderSmartBanner(smartModeInfo);
        newNoteOptionsDiv.style.display = "none";
      } else if (mode === "new_file") {
        smartModeInfo.style.display = "none";
        newNoteOptionsDiv.style.display = "block";
      } else {
        smartModeInfo.style.display = "none";
        newNoteOptionsDiv.style.display = "none";
      }
    };

    updateModeUI(defaultMode);

    // Custom Select Component for Mode
    this.modeSelectComponent = new CustomSelect(
      modeContainer,
      modeOptions,
      defaultMode,
      (val) => {
        updateModeUI(val as "smart" | "multi_note" | "new_file" | "append");
      }
    );

    // 2. Note Output Style Selector
    const styleContainer = contentEl.createDiv({ cls: "nemotron-form-row" });
    styleContainer.createEl("label", { text: "Note Depth & Style:", cls: "nemotron-label" });

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
      }
    );

    // 3. Excalidraw Visual Mind Map Toggle Row
    const excalRow = contentEl.createDiv({ cls: "nemotron-form-row nemotron-checkbox-row" });
    const excalCheckbox = excalRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    excalCheckbox.id = "nemotron-excalidraw-toggle";
    excalCheckbox.checked = this.enableExcalidraw;
    excalCheckbox.addEventListener("change", () => {
      this.enableExcalidraw = excalCheckbox.checked;
    });

    const excalLabel = excalRow.createEl("label", { cls: "nemotron-checkbox-label" });
    excalLabel.setAttribute("for", "nemotron-excalidraw-toggle");
    excalLabel.createSpan({ text: "Generate Excalidraw Visual Mind Map ", cls: "nemotron-checkbox-title" });
    excalLabel.createSpan({
      text: `(Mirrors folder hierarchy in /${this.plugin.settings.excalidrawFolder || "Excalidrawings"} with top link)`,
      cls: "nemotron-checkbox-desc",
    });

    // 4. Multi-Image Input Section
    const imageRow = contentEl.createDiv({ cls: "nemotron-form-row" });
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

    // Gallery of Attached Images
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

    // Window-level Capture Paste Listener
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
    const customRow = contentEl.createDiv({ cls: "nemotron-form-row" });
    customRow.createEl("label", { text: "Custom Instructions (optional):", cls: "nemotron-label" });
    const customInput = customRow.createEl("input", {
      type: "text",
      placeholder: "e.g., Decompose into atomic concepts, place each in relevant folder...",
      cls: "nemotron-input",
    });
    this.customInputEl = customInput;

    // 6. Input Text area
    const inputAreaRow = contentEl.createDiv({ cls: "nemotron-form-row" });
    inputAreaRow.createEl("label", { text: "Raw Input Text (optional if photos are attached):", cls: "nemotron-label" });
    const inputTextArea = inputAreaRow.createEl("textarea", {
      cls: "nemotron-textarea",
      placeholder: "Paste or write text, or attach photos / screenshots above...",
    });
    inputTextArea.value = this.initialText;
    inputTextArea.rows = 5;
    this.inputTextAreaEl = inputTextArea;

    // Status area
    const statusDiv = contentEl.createDiv({ cls: "nemotron-status" });
    statusDiv.style.display = "none";

    // Streaming Preview Area
    const previewContainer = contentEl.createDiv({ cls: "nemotron-preview-container" });
    previewContainer.style.display = "none";
    
    const reasoningDetails = previewContainer.createEl("details", { cls: "nemotron-reasoning-box" });
    reasoningDetails.createEl("summary", { text: "Thinking Process (Nemotron Reasoning)" });
    const reasoningPre = reasoningDetails.createEl("pre", { cls: "nemotron-reasoning-content" });

    const contentPreviewBox = previewContainer.createEl("div", { cls: "nemotron-content-box" });
    contentPreviewBox.createEl("h4", { text: "Formatted Note Preview:" });
    const contentPre = contentPreviewBox.createEl("pre", { cls: "nemotron-preview-content" });

    // Buttons
    const buttonRow = contentEl.createDiv({ cls: "nemotron-button-row" });
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
        .map((f) => f.basename)
        .filter((b) => b && !b.startsWith("."));

      let vaultKnowledgeTreeText: string | undefined = undefined;
      if (mode === "smart" || mode === "multi_note") {
        statusDiv.style.display = "block";
        statusDiv.setText("Analyzing vault knowledge tree...");
        let vaultIndex = await loadVaultIndex(this.app);
        if (!vaultIndex) {
          vaultIndex = await buildOrUpdateVaultIndex(this.app, this.plugin.settings);
        }
        vaultKnowledgeTreeText = formatVaultTreeForAI(vaultIndex);
      }

      const promptText = rawText || "Extract, analyze, and synthesize all key concepts, instructions, and code from the attached image(s).";
      const prompt = buildUserPrompt(
        promptText,
        mode,
        this.selectedStyle,
        customInstruction,
        existingVaultNotes,
        vaultKnowledgeTreeText,
        enableProperties
      );

      this.isGenerating = true;
      generateBtn.disabled = true;
      generateBtn.setText("Generating...");
      statusDiv.style.display = "block";
      statusDiv.setText(
        mode === "multi_note"
          ? "Decomposing into atomic notes & routing across vault..."
          : mode === "smart"
          ? "Analyzing vault tree & generating note..."
          : "Starting note generation..."
      );
      previewContainer.style.display = "block";
      reasoningPre.setText("");
      contentPre.setText("");

      this.abortController = new AbortController();

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

        statusDiv.setText("Placing notes and Excalidraw drawings in vault...");

        const fileSnapshots: FileSnapshot[] = [];
        const foldersCreatedList: string[] = [];

        if (mode === "multi_note") {
          const plan = extractAtomicDecompositionPlan(result.content);
          let createdCount = 0;
          let appendedCount = 0;

          for (const item of plan) {
            try {
              if (item.action === "append_to_note" && item.targetNotePath) {
                const targetFile = this.app.vault.getAbstractFileByPath(normalizePath(item.targetNotePath));
                if (targetFile instanceof TFile) {
                  const { snaps, foldersCreated } = await this.appendToFile(targetFile, item.content, enableProperties, item.reason);
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  appendedCount++;
                } else {
                  const folder = enforceMaxDepthFolder(item.targetFolder || "");
                  const { snaps, foldersCreated } = await this.createNewNoteFile(item.content, item.title, folder, enableProperties, this.enableExcalidraw);
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  createdCount++;
                }
              } else {
                const folder = enforceMaxDepthFolder(item.targetFolder || "");
                const { snaps, foldersCreated } = await this.createNewNoteFile(item.content, item.title, folder, enableProperties, this.enableExcalidraw);
                fileSnapshots.push(...snaps);
                foldersCreatedList.push(...foldersCreated);
                createdCount++;
              }
            } catch (itemErr: any) {
              console.warn(`Error processing item ${item.title}:`, itemErr);
            }
          }

          this.plugin.historyManager.recordGeneration({
            id: `${Date.now()}`,
            timestamp: Date.now(),
            mode: "multi_note",
            description: `Atomic Decomposition: ${createdCount} created, ${appendedCount} updated`,
            files: fileSnapshots,
            foldersCreated: Array.from(new Set(foldersCreatedList)),
          });

          new Notice(
            `Atomic Decomposition Complete: ${createdCount} note(s) created, ${appendedCount} note(s) processed.`,
            8000
          );

          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else if (mode === "smart") {
          const { decision, cleanedContent } = extractSmartDecision(result.content);
          
          if (decision && decision.action === "append_to_note" && decision.targetNotePath) {
            const targetFile = this.app.vault.getAbstractFileByPath(normalizePath(decision.targetNotePath));
            if (targetFile instanceof TFile) {
              const { snaps, foldersCreated } = await this.appendToFile(targetFile, cleanedContent, enableProperties, decision.reason);
              fileSnapshots.push(...snaps);
              foldersCreatedList.push(...foldersCreated);
              new Notice(`Smart Appended to: ${decision.targetNotePath}\nReason: ${decision.reason}`, 7000);
            } else {
              const folder = enforceMaxDepthFolder(decision.targetFolder || "");
              const { snaps, foldersCreated } = await this.createNewNoteFile(cleanedContent, decision.title, folder, enableProperties, this.enableExcalidraw);
              fileSnapshots.push(...snaps);
              foldersCreatedList.push(...foldersCreated);
              new Notice(`Smart Placed in folder: ${folder || "Vault Root"}\nReason: ${decision.reason}`, 7000);
            }
          } else {
            const rawFolder = decision?.targetFolder || "";
            const targetFolder = enforceMaxDepthFolder(rawFolder);
            const title = decision?.title || titleInput.value.trim();
            const { snaps, foldersCreated } = await this.createNewNoteFile(cleanedContent, title, targetFolder, enableProperties, this.enableExcalidraw);
            fileSnapshots.push(...snaps);
            foldersCreatedList.push(...foldersCreated);
            const reasonMsg = decision?.reason ? `\nReason: ${decision.reason}` : "";
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

          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        } else if (mode === "new_file") {
          const targetFolder = enforceMaxDepthFolder(currentSelectedFolder);
          const { snaps, foldersCreated } = await this.createNewNoteFile(result.content, titleInput.value.trim(), targetFolder, enableProperties, this.enableExcalidraw);
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

          new Notice("Obsidian note created with Excalidraw mind map!");
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

          new Notice("Appended note section successfully!");
          this.renderHistoryToolbar();
          this.plugin.scheduleIndexUpdate();
        }

        this.close();
      } catch (err: any) {
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

    // Left: Undo / Redo buttons
    const genGroup = this.historyRowEl.createDiv({ cls: "nemotron-history-group" });
    genGroup.createSpan({ text: "Generations:", cls: "nemotron-history-label" });

    const undoBtn = genGroup.createEl("button", {
      text: `Undo (${undoCount})`,
      cls: `nemotron-history-btn ${undoCount === 0 ? "is-disabled" : ""}`,
    });
    undoBtn.disabled = undoCount === 0;
    undoBtn.setAttribute("type", "button");
    undoBtn.addEventListener("click", async () => {
      const record = await this.plugin.historyManager.undo();
      if (record) {
        new Notice(`Undid: ${record.description}`);
        this.renderHistoryToolbar();
        this.plugin.scheduleIndexUpdate();
      }
    });

    const redoBtn = genGroup.createEl("button", {
      text: `Redo (${redoCount})`,
      cls: `nemotron-history-btn ${redoCount === 0 ? "is-disabled" : ""}`,
    });
    redoBtn.disabled = redoCount === 0;
    redoBtn.setAttribute("type", "button");
    redoBtn.addEventListener("click", async () => {
      const record = await this.plugin.historyManager.redo();
      if (record) {
        new Notice(`Redid: ${record.description}`);
        this.renderHistoryToolbar();
        this.plugin.scheduleIndexUpdate();
      }
    });

    // Right: Native Obsidian Context Menu Dropdown for Recent Prompts (Opens Leftward)
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
      this.selectedMode = item.mode;
      this.modeSelectComponent.setValue(item.mode);
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
    const { contentEl } = this;
    contentEl.empty();
  }

  private async createNewNoteFile(
    content: string,
    requestedTitle?: string,
    requestedFolder?: string,
    enableProperties: boolean = true,
    generateExcalidraw: boolean = true
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    let title = requestedTitle;
    let finalContent = content;
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

    const cappedFolder = enforceMaxDepthFolder(requestedFolder);
    let folder = cappedFolder ? normalizePath(cappedFolder) : "";
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

    // Embed Excalidraw Visual Link at the TOP of the note
    const excalFolder = this.plugin.settings.excalidrawFolder || "Excalidrawings";
    const excalRelPath = folder ? `${excalFolder}/${folder}/${safeTitle}.excalidraw` : `${excalFolder}/${safeTitle}.excalidraw`;

    if (generateExcalidraw) {
      const excalHeader = `> [!example] Visual Mind Map\n> **Excalidraw Overview:** [[${excalRelPath}|${safeTitle} Diagram]]\n\n`;

      const yamlMatch = finalContent.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n*)/);
      if (yamlMatch) {
        const yamlBlock = yamlMatch[1];
        const restContent = finalContent.slice(yamlBlock.length).trimStart();
        finalContent = `${yamlBlock}${excalHeader}${restContent}`;
      } else {
        finalContent = `${excalHeader}${finalContent.trimStart()}`;
      }
    }

    const newFile = (await this.app.vault.create(filePath, finalContent)) as TFile;

    snaps.push({
      path: filePath,
      isNewFile: true,
      newContent: finalContent,
    });

    // Generate Mirrored Excalidraw Drawing
    if (generateExcalidraw) {
      try {
        const excalRes = await createMirroredExcalidrawDrawing(this.app, newFile, finalContent, excalFolder);
        snaps.push({
          path: excalRes.drawingPath,
          isNewFile: true,
          newContent: "",
        });
        foldersCreated.push(...excalRes.foldersCreated);
      } catch (exErr) {
        console.warn("Excalidraw generation warning:", exErr);
      }
    }

    if (this.plugin.settings.autoOpenCreatedNote) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(newFile as TFile);
    }

    return {
      snaps,
      foldersCreated,
    };
  }

  /**
   * Appends content to an existing note, or automatically splits into a sequential
   * Part 2 (with two-way navigation links) if the note exceeds the optimal word count.
   */
  private async appendToFile(
    file: TFile,
    content: string,
    enableProperties: boolean = true,
    reason?: string
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    const existingContent = await this.app.vault.read(file);
    let finalExistingContent = existingContent;
    const snaps: FileSnapshot[] = [];
    const foldersCreated: string[] = [];

    const countWords = (text: string) => text.trim().split(/\s+/).filter((w) => w.length > 0).length;
    const currentWordCount = countWords(existingContent);
    const newWordCount = countWords(content);
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

      // Append Forward Link in Part 1
      const forwardContinuation = `\n\n---\n> [!info] Continued in [[${nextPartTitle}]]\n`;
      const updatedPart1Content = existingContent.trimEnd() + forwardContinuation;
      await this.app.vault.modify(file, updatedPart1Content);
      snaps.push({
        path: file.path,
        isNewFile: false,
        previousContent: existingContent,
        newContent: updatedPart1Content,
      });

      // Create Part 2 with Backlink & Formatted Content
      const currentDate = new Date().toISOString().split("T")[0];
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const timestampFormatted = `${currentDate} ${hours}:${minutes}`;

      const reasonLine = reason && reason.trim() ? `\n> **Reason:** ${reason.trim()}` : "";
      const bodyToAppend = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

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
      const newPartRes = await this.createNewNoteFile(part2Content, nextPartTitle, targetFolder, enableProperties, this.enableExcalidraw);
      snaps.push(...newPartRes.snaps);
      foldersCreated.push(...newPartRes.foldersCreated);

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

    const bodyToAppend = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

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

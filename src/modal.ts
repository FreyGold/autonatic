import { App, Modal, Notice, MarkdownView, normalizePath, TFile, TFolder, Menu, setIcon } from "obsidian";
import type NemotronPlugin from "./main";
import { generateNemotronNote, sanitizeMermaidDiagrams, streamChatCompletion, type StreamResult } from "./api";
import { buildUserPrompt, type NoteStyle } from "./prompts";
import { CustomSelect, SelectOption } from "./custom-select";
import { FolderNavigator } from "./folder-nav";
import { getGenerationApiKey, getGenerationConfig, PROVIDERS } from "./providers";
import {
  buildOrUpdateVaultIndex,
  formatVaultTreeForAI,
  extractSmartDecision,
  extractAtomicDecompositionPlan,
  loadVaultIndex,
  enforceMaxDepthFolder,
  vaultIndexPath,
} from "./vault-indexer";
import {
  isPathInFolder,
  resolveAtomicPlacementPlan,
  resolveAtomicPlacementTarget,
  resolveFolderWithinScope,
  selectStrongRelatedNote,
  selectVaultContextByTopic,
} from "./privacy-controls";
import {
  supportsPlacementFolderScope,
  type DestinationMode,
} from "./destination-modes";
import type { VaultKnowledgeIndex } from "./vault-indexer";
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
import { formatSharedConversation, importSharedConversation } from "./conversation-import";
import { WorkflowProgress } from "./workflow-progress";
import { reviewAppendDraft } from "./append-review";
import { workspaceHeader, openPluginSettings, setWorkspaceBusy, shortcutHint, type WorkspacePage } from "./workspace-ui";
import { NotePreview } from "./note-preview";
import { deriveSafeNoteTitle, GENERATED_NOTES_FALLBACK_FOLDER, resolveNewNoteFolder } from "./note-destination";
import { reviewNoteDestinations, type NoteDestinationDraft } from "./placement-review-modal";

interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
}

type CreationIntent = "single" | "multiple" | "append";
type PlacementPreference = "automatic" | "folder";

interface WorkspaceDraft {
  activeTab?: "notes" | "excalidraw";
  source?: string;
  instructions?: string;
  title?: string;
  mode?: DestinationMode;
  style?: NoteStyle;
  folder?: string;
  scopeFolder?: string;
  limitToFolder?: boolean;
  diagramSource?: "active_note" | "standalone";
  diagramTitle?: string;
  diagramFolder?: string;
  diagramPrompt?: string;
  diagramType?: DiagramType | "auto";
  diagramDetail?: DiagramOptions["detail"];
  diagramDirection?: DiagramOptions["direction"];
  diagramTheme?: DiagramTheme;
  linkDiagramBack?: boolean;
}

export class NemotronModal extends Modal {
  plugin: NemotronPlugin;
  initialText: string;
  abortController: AbortController | null = null;
  private importAbortController: AbortController | null = null;
  isGenerating: boolean = false;
  private continueGenerationAfterClose = false;
  attachedImages: AttachedImage[] = [];
  excalAttachedImages: AttachedImage[] = [];
  pasteListener!: (e: ClipboardEvent) => void;
  selectedMode: DestinationMode = "smart";
  selectedStyle: NoteStyle = "concise";
  enableExcalidrawInNoteTab: boolean = false;
  historyRowEl!: HTMLElement;
  styleSelectComponent!: CustomSelect;
  private selectComponents: CustomSelect[] = [];
  private folderNavigators: FolderNavigator[] = [];
  private notePreview?: NotePreview;
  private interfaceEvents?: AbortController;
  private outputResizeObservers: ResizeObserver[] = [];
  private updateModeUI?: (mode: DestinationMode) => Promise<void>;
  renderGalleryCallback?: () => void;
  renderExcalGalleryCallback?: () => void;
  inputTextAreaEl?: HTMLTextAreaElement;
  customInputEl?: HTMLInputElement;
  activeTab: "notes" | "excalidraw" = "notes";
  private savedDraft?: WorkspaceDraft;
  private saveDraftBeforeNavigation?: () => void;
  private initialWorkspacePage: WorkspacePage;

  constructor(
    app: App,
    plugin: NemotronPlugin,
    initialText: string = "",
    defaultTab: "notes" | "excalidraw" = "notes",
    initialWorkspacePage: WorkspacePage = "create",
  ) {
    super(app);
    this.plugin = plugin;
    this.initialText = initialText;
    this.activeTab = defaultTab;
    this.initialWorkspacePage = initialWorkspacePage;
    this.enableExcalidrawInNoteTab = plugin.settings.enableExcalidrawMindMap ?? false;
  }

  async onOpen() {
    const { contentEl } = this;
    this.activeTab = this.savedDraft?.activeTab ?? this.activeTab;
    this.modalEl.addClass("autonatic-crafter-shell");
    this.selectComponents.forEach((select) => select.destroy());
    this.selectComponents = [];
    this.folderNavigators.forEach((navigator) => navigator.destroy());
    this.folderNavigators = [];
    this.notePreview?.destroy();
    this.disconnectOutputObservers();
    this.interfaceEvents?.abort();
    this.interfaceEvents = new AbortController();
    contentEl.empty();
    contentEl.addClass("nemotron-modal-container");
    this.plugin.workspaceNavigation.activate("create", this);
    this.saveDraftBeforeNavigation = undefined;
    const initialPage = this.initialWorkspacePage;
    this.initialWorkspacePage = "create";
    if (initialPage !== "create") {
      this.plugin.workspaceNavigation.navigate(initialPage, this);
      return;
    }

    workspaceHeader(contentEl, "create", (page) => {
      this.saveDraftBeforeNavigation?.();
      this.plugin.workspaceNavigation.navigate(page, this);
    }, () => openPluginSettings(this.app, this.plugin.manifest.id));

    const heading = contentEl.createDiv({ cls: "autonatic-page-heading" });
    const headingCopy = heading.createDiv();
    const pageTitle = headingCopy.createEl("h3", { text: "Create a note" });
    const pageDescription = headingCopy.createEl("p", { text: "Turn text, conversations, and images into notes." });

    // History Toolbar Row (Undo / Redo up to 3 generations & Recent Prompts up to 5)
    const historyDetails = contentEl.createEl("details", { cls: "autonatic-history-details" });
    historyDetails.createEl("summary", { text: "History" });
    this.historyRowEl = historyDetails.createDiv({ cls: "nemotron-history-toolbar" });
    this.renderHistoryToolbar();

    // Inline API Key Management Bar
    const apiKeyBar = contentEl.createDiv({ cls: "nemotron-api-key-bar" });
    this.renderApiKeySection(apiKeyBar);

    // Modal Nav Tabs (Note Crafter vs Excalidraw Diagram)
    const tabNav = heading.createDiv({ cls: "nemotron-modal-nav-tabs" });
    const noteTabBtn = tabNav.createEl("button", {
      text: "Note",
      cls: `nemotron-tab-btn ${this.activeTab === "notes" ? "is-active" : ""}`,
    });
    const excalTabBtn = tabNav.createEl("button", {
      text: "Diagram",
      cls: `nemotron-tab-btn ${this.activeTab === "excalidraw" ? "is-active" : ""}`,
    });

    const notePane = contentEl.createDiv({ cls: `nemotron-tab-pane ${this.activeTab === "notes" ? "" : "is-hidden"}` });
    const excalPane = contentEl.createDiv({ cls: `nemotron-tab-pane ${this.activeTab === "excalidraw" ? "" : "is-hidden"}` });

    tabNav.setAttribute("role", "tablist");
    tabNav.setAttribute("aria-label", "Create");
    const tabs = [noteTabBtn, excalTabBtn];
    const panes = [notePane, excalPane];
    const activateTab = (index: number) => {
      if (this.isGenerating) return;
      this.activeTab = index === 0 ? "notes" : "excalidraw";
      pageTitle.setText(index === 0 ? "Create a note" : "Create a diagram");
      pageDescription.setText(index === 0 ? "Turn text, conversations, and images into notes." : "Map out a process, system, or idea.");
      tabs.forEach((tab, i) => {
        tab.toggleClass("is-active", i === index);
        tab.setAttribute("aria-selected", String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
        panes[i].toggleClass("is-hidden", i !== index);
      });
    };
    tabs.forEach((tab, index) => {
      tab.type = "button";
      tab.id = `autonatic-tab-${index}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `autonatic-pane-${index}`);
      panes[index].id = `autonatic-pane-${index}`;
      panes[index].setAttribute("role", "tabpanel");
      panes[index].setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("click", () => activateTab(index));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
        activateTab(next);
        tabs[next].focus();
      });
    });
    activateTab(this.activeTab === "notes" ? 0 : 1);

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasActiveNote = !!(activeView && activeView.file);

    // TAB 1: Note Crafter Pane
    this.renderNoteCrafterPane(notePane, activeView, hasActiveNote);

    // TAB 2: Excalidraw Diagram Pane
    this.renderExcalidrawPane(excalPane, activeView, hasActiveNote);
    const sourceTools = notePane.querySelector(".autonatic-source-toolbar");
    sourceTools?.appendChild(historyDetails);
    document.addEventListener("autonatic:settings-updated", () => {
      this.renderApiKeySection(apiKeyBar);
      const config = getGenerationConfig(this.plugin.settings);
      contentEl.querySelector(".autonatic-provider-button > span:last-child")?.setText(
        `${PROVIDERS[config.provider].label} / ${config.model.split("/").pop() || "Choose a model"}`,
      );
    }, { signal: this.interfaceEvents.signal });
  }

  // ==========================================
  // TAB 1: NOTE CRAFTER PANE
  // ==========================================
  private renderNoteCrafterPane(paneEl: HTMLElement, activeView: MarkdownView | null, hasActiveNote: boolean) {
    const defaultMode = this.savedDraft?.mode ?? this.plugin.settings.defaultDestinationMode ?? "smart";
    this.selectedMode = defaultMode;

    let initialFolder = this.savedDraft?.folder ?? this.plugin.settings.defaultFolder ?? "";
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
    if (!initialFolder) initialFolder = this.plugin.settings.defaultFolder || GENERATED_NOTES_FALLBACK_FOLDER;

    const workflow = paneEl.createDiv({ cls: "nemotron-generation-workflow" });

    const modeToChoices = (mode: DestinationMode): { intent: CreationIntent; placement: PlacementPreference } => {
      switch (mode) {
        case "multi_note": return { intent: "multiple", placement: "automatic" };
        case "multi_note_folder": return { intent: "multiple", placement: "folder" };
        case "new_file": return { intent: "single", placement: "folder" };
        case "append": return { intent: "append", placement: "automatic" };
        default: return { intent: "single", placement: "automatic" };
      }
    };
    const choicesToMode = (intent: CreationIntent, placement: PlacementPreference): DestinationMode => {
      if (intent === "append") return "append";
      if (intent === "multiple") return placement === "automatic" ? "multi_note" : "multi_note_folder";
      return placement === "automatic" ? "smart" : "new_file";
    };

    let { intent: creationIntent, placement: placementPreference } = modeToChoices(defaultMode);
    if (creationIntent === "append" && !hasActiveNote) {
      creationIntent = "single";
      placementPreference = "automatic";
      this.selectedMode = "smart";
    }

    const creationSection = workflow.createDiv({ cls: "nemotron-workflow-section" });
    const creationLabel = creationSection.createEl("label", {
      text: "Output", cls: "nemotron-label", attr: { id: "autonatic-output-label", for: "autonatic-output" },
    });
    const creationSelect = new CustomSelect(creationSection, [
      { value: "single", label: "One note", icon: "file-text", description: "Keep the source together in one note." },
      { value: "multiple", label: "Separate notes", icon: "files", description: "Split the source into focused notes by topic." },
      { value: "append", label: "Add to active note", icon: "file-input", description: hasActiveNote ? `Append a section to ${activeView?.file?.basename}.` : "Open a note in Obsidian first.", disabled: !hasActiveNote },
    ], creationIntent, (value) => {
      creationIntent = value as CreationIntent;
      void updateModeUI(choicesToMode(creationIntent, placementPreference));
    }, { controlId: "autonatic-output", labelId: creationLabel.id });
    this.selectComponents.push(creationSelect);

    const placementSection = workflow.createDiv({ cls: "nemotron-workflow-section nemotron-placement-section" });
    const placementLabel = placementSection.createEl("label", {
      text: "Save to", cls: "nemotron-label", attr: { id: "autonatic-placement-label", for: "autonatic-placement" },
    });
    const placementSelect = new CustomSelect(placementSection, [
      { value: "automatic", label: "Automatic placement", icon: "route", description: "Match an existing note or create one in a suitable folder." },
      { value: "folder", label: "Choose a folder", icon: "folder", description: "Create new notes in one folder. Existing notes stay unchanged." },
    ], placementPreference, (value) => {
      placementPreference = value as PlacementPreference;
      void updateModeUI(choicesToMode(creationIntent, placementPreference));
    }, { controlId: "autonatic-placement", labelId: placementLabel.id });
    this.selectComponents.push(placementSelect);

    const generationSummary = workflow.createDiv({ cls: "nemotron-generation-summary" });
    let updateActionButton: () => void = () => {};
    let updateOptionsSummary: () => void = () => {};

    const smartModeInfo = workflow.createDiv({ cls: "nemotron-smart-info-banner" });

    let limitPlacementToFolder = this.savedDraft?.limitToFolder ?? false;
    let currentPlacementScopeFolder = this.savedDraft?.scopeFolder ?? initialFolder;
    const smartScopeOptionsDiv = paneEl.createDiv({ cls: "nemotron-smart-scope-options" });
    const smartScopeToggleRow = smartScopeOptionsDiv.createDiv({ cls: "nemotron-checkbox-row nemotron-smart-scope-toggle" });
    const smartScopeCheckbox = smartScopeToggleRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    smartScopeCheckbox.checked = limitPlacementToFolder;
    smartScopeCheckbox.id = "nemotron-smart-folder-scope-toggle";
    smartScopeCheckbox.setAttribute("aria-controls", "nemotron-smart-folder-scope-options");

    const smartScopeToggleLabel = smartScopeToggleRow.createEl("label", { cls: "nemotron-checkbox-label" });
    smartScopeToggleLabel.htmlFor = smartScopeCheckbox.id;
    smartScopeToggleLabel.createSpan({ text: "Limit to a folder", cls: "nemotron-checkbox-title" });
    smartScopeToggleLabel.createSpan({
      text: " Includes the selected folder and its subfolders.",
      cls: "nemotron-checkbox-desc",
    });

    const smartScopeFolderOptions = smartScopeOptionsDiv.createDiv({ cls: "nemotron-smart-scope-folder" });
    smartScopeFolderOptions.id = "nemotron-smart-folder-scope-options";
    const smartScopeFolderRow = smartScopeFolderOptions.createDiv({ cls: "nemotron-form-row" });
    smartScopeFolderRow.createEl("label", { text: "Folder", cls: "nemotron-label" });
    smartScopeFolderRow.createEl("div", {
      text: "The limit includes all notes and folders below the selected folder.",
      cls: "nemotron-folder-scope-help",
    });
    const smartFolderNavigator = new FolderNavigator(
      this.app,
      smartScopeFolderRow,
      currentPlacementScopeFolder,
      (newPath) => {
        currentPlacementScopeFolder = newPath;
        void this.updateModeUI?.(this.selectedMode);
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
    const titleLabel = titleRow.createEl("label", { text: "Title (optional)", cls: "nemotron-label" });
    const titleInput = titleRow.createEl("input", {
      type: "text",
      placeholder: "Choose automatically…",
      cls: "nemotron-input",
    });
    titleInput.id = "nemotron-note-title";
    titleInput.value = this.savedDraft?.title ?? "";
    titleInput.name = "note-title";
    titleLabel.htmlFor = titleInput.id;

    const folderRow = newNoteOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    folderRow.createEl("label", { text: "Folder", cls: "nemotron-label" });
    
    let currentSelectedFolder = this.savedDraft?.folder ?? initialFolder;
    const folderNavigator = new FolderNavigator(
      this.app,
      folderRow,
      initialFolder,
      (newPath) => {
        currentSelectedFolder = newPath;
        void this.updateModeUI?.(this.selectedMode);
      }
    );
    this.folderNavigators.push(folderNavigator);

    const updateModeUI = async (mode: DestinationMode) => {
      if (mode === "append" && !hasActiveNote) mode = "smart";
      this.selectedMode = mode;
      const choices = modeToChoices(mode);
      creationIntent = choices.intent;
      placementPreference = choices.placement;
      creationSelect.setValue(creationIntent);
      placementSelect.setValue(placementPreference);
      placementSection.hidden = creationIntent === "append";
      if (supportsPlacementFolderScope(mode)) {
        smartModeInfo.style.display = "flex";
        smartScopeOptionsDiv.style.display = "block";
        void this.renderSmartBanner(smartModeInfo).catch(() => smartModeInfo.setText("Could not read the placement index. Try again when the vault is available."));
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
      const scopeSummary = limitPlacementToFolder
        ? ` within ${currentPlacementScopeFolder || GENERATED_NOTES_FALLBACK_FOLDER} and its subfolders`
        : " anywhere in the vault";
      generationSummary.setText(
        mode === "append"
          ? `A section will be added to ${activeView?.file?.basename || "the active note"}.`
          : mode === "new_file"
          ? `One new note will be created in ${currentSelectedFolder || GENERATED_NOTES_FALLBACK_FOLDER}. Existing notes will not be changed.`
          : mode === "multi_note_folder"
          ? `Several new notes will be created in ${currentSelectedFolder || GENERATED_NOTES_FALLBACK_FOLDER}. Existing notes will not be changed.`
          : mode === "multi_note"
          ? `Several focused notes may be created or updated${scopeSummary}.`
          : `One note may be created or updated${scopeSummary}.`,
      );
      updateActionButton();
      updateOptionsSummary();
    };
    this.updateModeUI = updateModeUI;
    smartScopeCheckbox.addEventListener("change", () => { void updateModeUI(this.selectedMode); });

    void updateModeUI(this.selectedMode);

    // 2. Note Output Style Selector
    const styleContainer = paneEl.createDiv({ cls: "nemotron-form-row" });
    const styleLabel = styleContainer.createEl("label", { text: "Style", cls: "nemotron-label" });
    styleLabel.id = "nemotron-note-style-label";
    styleLabel.htmlFor = "nemotron-note-style";

    const styleOptions: SelectOption[] = [
      {
        value: "concise",
        label: "Concise",
        icon: "align-left",
        description: "Key ideas, short sections, and clear takeaways.",
      },
      {
        value: "detailed",
        label: "Detailed",
        icon: "list-tree",
        description: "Complete explanations and examples from the source, organized into clear sections.",
      },
      {
        value: "bare",
        label: "Source only",
        icon: "text",
        description: "Cleans pasted chat history without expanding, inferring, summarizing, or adding content.",
      },
    ];

    const defaultStyle = this.savedDraft?.style ?? this.plugin.settings.defaultNoteStyle ?? "concise";
    this.selectedStyle = defaultStyle;

    this.styleSelectComponent = new CustomSelect(
      styleContainer,
      styleOptions,
      defaultStyle,
      (val) => {
        this.selectedStyle = val as NoteStyle;
        updateOptionsSummary();
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
    excalLabel.createSpan({ text: "Include useful diagrams", cls: "nemotron-checkbox-title" });
    excalLabel.createSpan({
      text: `Create or update diagrams when they help. Saved in ${this.plugin.settings.excalidrawFolder || "Excalidrawings"}.`,
      cls: "nemotron-checkbox-desc",
    });

    // 4. Multi-Image Input Section
    const imageRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const imageHeaderRow = imageRow.createDiv({ cls: "nemotron-image-header" });
    imageHeaderRow.createEl("label", { text: "Images", cls: "nemotron-label" });
    const imageCountBadge = imageHeaderRow.createSpan({ cls: "nemotron-image-badge", text: "0 attached" });
    imageCountBadge.style.display = "none";

    const dropzone = imageRow.createDiv({ cls: "nemotron-image-dropzone" });
    const dropzonePrompt = dropzone.createDiv({ cls: "nemotron-dropzone-prompt" });
    
    dropzonePrompt.createSpan({ text: "Drop images here or ", cls: "nemotron-dropzone-text" });
    const browseLink = dropzonePrompt.createEl("button", { text: "Choose images", cls: "nemotron-browse-link" });
    browseLink.type = "button";
    dropzonePrompt.createSpan({ text: " | ", cls: "nemotron-dropzone-sep" });
    const pasteBtn = dropzonePrompt.createEl("button", {
      text: "Paste image",
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
        thumb.alt = img.name;

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
    renderGallery();

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
      if (this.activeTab !== "notes" || !paneEl.contains(e.target as Node)) return;
      if (e.target instanceof HTMLInputElement) return;
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

      if (!handled && !e.clipboardData?.getData("text/plain")) {
        const systemSuccess = await tryReadSystemClipboard();
        if (systemSuccess) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener("paste", this.pasteListener, true);

    // 5. Custom Instruction row
    const customRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const customLabel = customRow.createEl("label", { text: "Instructions (optional)", cls: "nemotron-label" });
    const customInput = customRow.createEl("input", {
      type: "text",
      placeholder: "e.g. Keep code examples and use short sections",
      cls: "nemotron-input",
    });
    customInput.id = "autonatic-note-instructions";
    customInput.value = this.savedDraft?.instructions ?? "";
    customLabel.htmlFor = customInput.id;
    this.customInputEl = customInput;

    // 6. Public conversation import
    const importRow = paneEl.createDiv({ cls: "nemotron-form-row autonatic-conversation-import" });
    const importLabel = importRow.createEl("label", { text: "Shared conversation link", cls: "nemotron-label" });
    const importControls = importRow.createDiv({ cls: "autonatic-conversation-import-controls" });
    const importInput = importControls.createEl("input", {
      type: "url",
      placeholder: "Paste a Gemini, ChatGPT, or Claude share link",
      cls: "nemotron-input",
    });
    importInput.id = "autonatic-conversation-share-link";
    importLabel.htmlFor = importInput.id;
    const importButton = importControls.createEl("button", { text: "Import", cls: "autonatic-conversation-import-button" });
    importButton.type = "button";
    const importStatus = importRow.createDiv({ cls: "autonatic-conversation-import-status" });
    importStatus.setAttribute("role", "status");
    importStatus.setAttribute("aria-live", "polite");
    const importProgressHost = importRow.createDiv();
    let importProgress: WorkflowProgress | null = null;
    importRow.createDiv({
      text: "Use a shared conversation link from Gemini, ChatGPT, or Claude. Access follows the provider’s sharing settings. Import fills the source text for review before creating notes.",
      cls: "autonatic-conversation-import-help",
    });

    // 7. Input Text area
    const inputAreaRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const inputHeading = inputAreaRow.createDiv({ cls: "autonatic-source-heading" });
    const sourceLabel = inputHeading.createEl("label", { text: "Source", cls: "nemotron-label" });
    const wordCount = inputHeading.createSpan({ cls: "autonatic-source-count" });
    const inputTextArea = inputAreaRow.createEl("textarea", {
      cls: "nemotron-textarea",
      placeholder: "Paste a conversation, rough notes, or anything you want to keep…",
    });
    inputTextArea.value = this.savedDraft?.source ?? this.initialText;
    inputTextArea.id = "autonatic-source-text";
    inputTextArea.name = "source";
    sourceLabel.htmlFor = inputTextArea.id;
    inputTextArea.rows = 12;
    const updateWordCount = () => {
      const count = inputTextArea.value.trim().split(/\s+/).filter(Boolean).length;
      wordCount.setText(`${count.toLocaleString()} ${count === 1 ? "word" : "words"}`);
    };
    inputTextArea.addEventListener("input", updateWordCount);
    updateWordCount();
    this.inputTextAreaEl = inputTextArea;

    const runImport = async () => {
      if (this.importAbortController) return;
      if (inputTextArea.value.trim()) {
        importStatus.setText("Clear the raw input first so the import does not replace it.");
        return;
      }
      this.importAbortController = new AbortController();
      importButton.disabled = true;
      importButton.setText("Importing…");
      importStatus.setText("");
      importProgress?.remove();
      importProgress = new WorkflowProgress(importProgressHost, ["Open shared page", "Read conversation", "Add transcript"]);
      importProgress.setStage("Open shared page");
      try {
        const conversation = await importSharedConversation(importInput.value, this.importAbortController.signal, (progress) => {
          if (progress.stage === "reading") {
            importProgress?.setStage("Read conversation", progress.completed, progress.total);
          } else if (progress.stage === "finalizing") {
            importProgress?.setStage("Add transcript");
          }
        });
        inputTextArea.value = formatSharedConversation(conversation);
        inputTextArea.rows = 12;
        inputTextArea.dispatchEvent(new Event("input", { bubbles: true }));
        inputTextArea.scrollIntoView({ block: "nearest" });
        const attachmentCount = conversation.messages.reduce((sum, message) => sum + message.attachments, 0);
        const exchangeCount = conversation.messages.filter((message) => message.role === "user").length;
        importProgress.finish();
        importStatus.setText(`Imported ${exchangeCount} exchange${exchangeCount === 1 ? "" : "s"}. Review the source text before creating notes.${
          attachmentCount ? ` ${attachmentCount} image or attachment reference${attachmentCount === 1 ? "" : "s"} need the source link to view.` : ""}`);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          importProgress?.fail();
          importStatus.setText(error instanceof Error ? error.message : "Could not import the shared conversation.");
        }
      } finally {
        this.importAbortController = null;
        importButton.disabled = false;
        importButton.setText("Import");
      }
    };
    importButton.addEventListener("click", () => { void runImport(); });
    importInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void runImport(); }
    });

    // Status area
    const generationProgressHost = paneEl.createDiv();
    const statusDiv = paneEl.createDiv({ cls: "nemotron-status autonatic-generation-detail" });
    statusDiv.setAttribute("role", "status");
    statusDiv.setAttribute("aria-live", "polite");
    statusDiv.style.display = "none";
    let generationProgress: WorkflowProgress | null = null;

    // Streaming Preview Area
    const previewContainer = paneEl.createDiv({ cls: "nemotron-preview-container" });
    previewContainer.style.display = "none";
    
    const reasoningDetails = previewContainer.createEl("details", { cls: "nemotron-reasoning-box" });
    reasoningDetails.createEl("summary", { text: "Reasoning" });
    const reasoningPre = reasoningDetails.createEl("pre", { cls: "nemotron-reasoning-content" });

    const contentPreviewBox = previewContainer.createEl("div", { cls: "nemotron-content-box" });
    const notePreview = new NotePreview(this.app, contentPreviewBox);
    this.notePreview = notePreview;
    let previewMarkdown = "";

    // Buttons
    const buttonRow = paneEl.createDiv({ cls: "nemotron-button-row" });
    const generateBtn = buttonRow.createEl("button", {
      text: "Generate and place note",
      cls: "mod-cta",
    });
    let savedDraft: { key: string; result: StreamResult } | null = null;
    const draftKey = () => JSON.stringify({
      text: inputTextArea.value.trim(), images: this.attachedImages.map((image) => image.dataUrl),
      instructions: customInput.value.trim(), style: this.selectedStyle, mode: this.selectedMode,
      folder: currentSelectedFolder,
      scope: limitPlacementToFolder ? currentPlacementScopeFolder : null,
      settings: this.plugin.settings,
    });
    const retryPlacementBtn = buttonRow.createEl("button", { text: "Retry saving notes", cls: "mod-cta" });
    retryPlacementBtn.type = "button";
    retryPlacementBtn.hidden = true;
    updateActionButton = () => {
      if (this.isGenerating) return;
      retryPlacementBtn.hidden = savedDraft === null;
      retryPlacementBtn.disabled = false;
      generateBtn.toggleClass("mod-cta", savedDraft === null);
      if (savedDraft) {
        generateBtn.setText("Generate again");
        return;
      }
      const label = this.selectedMode === "append"
        ? `Append to ${activeView?.file?.basename || "active note"}`
        : this.selectedMode === "multi_note" || this.selectedMode === "multi_note_folder"
        ? "Create notes"
        : "Create note";
      generateBtn.setText(label);
    };
    const updateGenerationStage = (stage: string, completed?: number, total?: number) => {
      generationProgress?.setStage(stage, completed, total);
      const labels: Record<string, string> = {
        "Prepare source": "Preparing…", "Generate notes": "Generating…",
        "Check placement": "Checking destinations…", "Review placement": "Review destinations…", "Place notes": "Saving notes…",
        "Create diagrams": "Creating diagrams…",
      };
      generateBtn.setText(labels[stage] || stage);
    };
    updateActionButton();
    const cancelBtn = buttonRow.createEl("button", {
      text: "Cancel",
    });
    const backgroundBtn = buttonRow.createEl("button", {
      cls: "autonatic-background-button",
      attr: { type: "button" },
    });
    setIcon(backgroundBtn.createSpan({ attr: { "aria-hidden": "true" } }), "minimize-2");
    backgroundBtn.createSpan({ text: "Continue in background" });
    backgroundBtn.hidden = true;

    cancelBtn.addEventListener("click", () => {
      if (this.isGenerating && this.abortController) {
        this.abortController.abort();
      }
      this.close();
    });
    backgroundBtn.addEventListener("click", () => {
      if (!this.isGenerating) return;
      this.continueGenerationAfterClose = true;
      backgroundBtn.disabled = true;
      new Notice("Generation is continuing in the background. Autonatic will notify you when it finishes.", 7000);
      this.close();
    });

    const runGeneration = async (retryPlacement = false) => {
      if (retryPlacement && (!savedDraft || savedDraft.key !== draftKey())) {
        new Notice("The source or options changed. Restore them to retry this draft, or create notes again.");
        return;
      }
      if (this.isGenerating) return;
      if (!getGenerationApiKey(this.plugin.settings).trim()) {
        new Notice(`Please enter your ${PROVIDERS[this.plugin.settings.generationProvider].label} API key first.`);
        statusDiv.style.display = "block";
        statusDiv.setText(`Connect ${PROVIDERS[this.plugin.settings.generationProvider].label} in Settings to create notes.`);
        return;
      }

      const rawText = inputTextArea.value.trim();
      const hasImages = this.attachedImages.length > 0;

      if (!rawText && !hasImages) {
        new Notice("Please enter text or attach at least one image to transform.");
        return;
      }

      if (!retryPlacement) savedDraft = null;
      const requestedDraftKey = draftKey();
      retryPlacementBtn.hidden = true;
      generateBtn.hidden = false;
      generateBtn.addClass("mod-cta");
      const mode = this.selectedMode;
      const enableProperties = this.selectedStyle !== "bare" && (this.plugin.settings.enableProperties ?? false);
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

      let existingVaultNotes = this.app.vault
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
      const includeDiagramStage = this.enableExcalidrawInNoteTab && this.selectedStyle !== "bare";
      const progressStages = [
        "Prepare source", "Generate notes",
        ...(mode === "multi_note" ? ["Check placement"] : []),
        ...(this.plugin.settings.reviewNotePlacement && mode !== "append" ? ["Review placement"] : []),
        "Place notes",
        ...(includeDiagramStage ? ["Create diagrams"] : []),
      ];
      generationProgress?.remove();
      generationProgress = new WorkflowProgress(generationProgressHost, progressStages);
      updateGenerationStage("Prepare source");
      this.isGenerating = true;
      this.continueGenerationAfterClose = false;
      this.abortController = new AbortController();
      setWorkspaceBusy(this.contentEl, true);
      retryPlacementBtn.disabled = true;
      generateBtn.disabled = true;
      generateBtn.setText("Preparing...");
      backgroundBtn.hidden = false;
      let vaultKnowledgeTreeText: string | undefined = undefined;
      let vaultIndexForPlacement: VaultKnowledgeIndex | null = null;
      const allowedAutomaticAppendPaths = new Set<string>();
      if (mode === "smart" || mode === "multi_note") {
        statusDiv.style.display = "block";
        statusDiv.setText("Finding relevant notes across the source...");
        let vaultIndex: VaultKnowledgeIndex;
        try {
          vaultIndex = await buildOrUpdateVaultIndex(this.app, this.plugin.settings);
          this.abortController?.signal.throwIfAborted();
        } catch (error) {
          const cancelled = this.abortController?.signal.aborted
            || (error instanceof Error && error.name === "AbortError");
          generationProgress.fail();
          const message = error instanceof Error ? error.message : "Could not analyze the vault.";
          statusDiv.setText(cancelled ? "Generation cancelled." : `Error: ${message}`);
          new Notice(cancelled ? "Generation cancelled." : `Could not analyze the vault: ${message}`);
          this.isGenerating = false;
          this.continueGenerationAfterClose = false;
          this.abortController = null;
          setWorkspaceBusy(this.contentEl, false);
          generateBtn.disabled = false;
          backgroundBtn.hidden = true;
          updateActionButton();
          return;
        }
        vaultIndexForPlacement = vaultIndex;
        const notes = selectVaultContextByTopic(
          vaultIndex,
          promptText,
          this.plugin.settings.maxVaultContextNotes,
          placementScopeFolder,
        );
        vaultKnowledgeTreeText = notes.map((note) => `- ${note.path}: ${note.about}`).join("\n");
        notes.forEach((note) => allowedAutomaticAppendPaths.add(note.path));
        // Only authorize links to the candidate notes actually shown to the
        // model. A vault-wide list of the first 100 names was unrelated to the
        // source and could contain ambiguous duplicate basenames.
        existingVaultNotes = notes.map((note) => note.path.replace(/\.md$/i, ""));
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

      updateGenerationStage("Generate notes");
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
            : "Matching existing notes and generating..."
          : "Starting note generation..."
      );
      previewContainer.style.display = "block";
      if (!retryPlacement) {
        reasoningPre.setText("");
        previewMarkdown = "";
        notePreview.update("", mode);
      }

      const fileSnapshots: FileSnapshot[] = [];
      const foldersCreatedList: string[] = [];
      let generationRecorded = false;

      try {
        const imageUrls = this.attachedImages.map((img) => img.dataUrl);
        const result = retryPlacement && savedDraft ? savedDraft.result : await generateNemotronNote(
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
              previewMarkdown += chunk;
              notePreview.update(previewMarkdown, mode);
            },
          },
          this.abortController.signal
        );
        notePreview.update(result.content, mode, true);

        const finishUsefulDiagrams = async () => {
          if (!this.enableExcalidrawInNoteTab || this.selectedStyle === "bare") return;
          updateGenerationStage("Create diagrams");
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

        const destinationDraft = (
          id: string,
          content: string,
          requestedTitle: string | undefined,
          requestedFolder: string | undefined,
          allowGeneratedFolder: boolean,
        ): NoteDestinationDraft => ({
          id,
          title: deriveSafeNoteTitle(content, requestedTitle),
          folder: resolveNewNoteFolder(
            content,
            requestedFolder,
            this.plugin.settings.defaultFolder,
            allowGeneratedFolder,
          ),
        });
        const reviewDestinations = async (drafts: NoteDestinationDraft[]): Promise<Map<string, NoteDestinationDraft>> => {
          if (drafts.length === 0) return new Map();
          if (!this.plugin.settings.reviewNotePlacement) {
            return new Map(drafts.map((draft) => [draft.id, draft]));
          }
          updateGenerationStage("Review placement", 0, drafts.length);
          statusDiv.setText("Review every new note destination before anything is written...");
          const reviewed = await reviewNoteDestinations(this.app, drafts, this.abortController?.signal);
          if (!reviewed) throw new DOMException("Placement review cancelled.", "AbortError");
          updateGenerationStage("Review placement", reviewed.length, reviewed.length);
          return new Map(reviewed.map((draft) => [draft.id, draft]));
        };

        if (mode === "multi_note" || mode === "multi_note_folder") {
          const plan = extractAtomicDecompositionPlan(result.content);
          // Folder decisions are generated with the notes. Resolve and validate them
          // locally; do not send the completed draft through more model passes.
          savedDraft = { key: requestedDraftKey, result };
          if (mode === "multi_note") updateGenerationStage("Check placement");
          const placementPlan = mode === "multi_note"
            ? resolveAtomicPlacementPlan(plan, placementScopeFolder, existingVaultFolders)
            : [];
          let createdCount = 0;
          let appendedCount = 0;
          let skippedCount = 0;
          const fixedTargetFolder = mode === "multi_note_folder" ? currentSelectedFolder : undefined;
          const plannedDestinations = plan.flatMap((item, itemIndex): NoteDestinationDraft[] => {
            const target = fixedTargetFolder !== undefined
              ? { action: "create_new_note" as const, targetFolder: fixedTargetFolder }
              : placementPlan[itemIndex] || resolveAtomicPlacementTarget(item, placementScopeFolder);
            if (target.action !== "create_new_note") return [];
            return [destinationDraft(
              `note-${itemIndex}`,
              item.content,
              item.title,
              target.targetFolder,
              fixedTargetFolder === undefined,
            )];
          });
          const reviewedDestinations = await reviewDestinations(plannedDestinations);
          updateGenerationStage("Place notes", 0, plan.length);
          statusDiv.setText("Saving notes to their reviewed destinations...");

          for (const [itemIndex, item] of plan.entries()) {
            this.abortController?.signal.throwIfAborted();
            statusDiv.setText(`Saving ${itemIndex + 1} of ${plan.length}: ${item.title}`);
            try {
              if (fixedTargetFolder !== undefined) {
                const destination = reviewedDestinations.get(`note-${itemIndex}`);
                if (!destination) throw new Error("The reviewed destination is missing.");
                const { snaps, foldersCreated } = await this.createNewNoteFile(
                  item.content,
                  item.title,
                  destination.folder,
                  enableProperties,
                  null,
                  false,
                );
                fileSnapshots.push(...snaps);
                foldersCreatedList.push(...foldersCreated);
                createdCount++;
              } else {
                const target = placementPlan[itemIndex] || resolveAtomicPlacementTarget(item, placementScopeFolder);
                if (target.action === "append_to_note" && !allowedAutomaticAppendPaths.has(normalizePath(target.targetNotePath))) {
                  throw new Error(`The suggested append target was not in the retrieved note candidates: ${target.targetNotePath}`);
                }
                const targetFile = target.action === "append_to_note"
                  ? this.app.vault.getAbstractFileByPath(normalizePath(target.targetNotePath))
                  : null;
                if (targetFile instanceof TFile) {
                  const reviewed = await this.reviewExistingAppend(targetFile, item.content, (status) => statusDiv.setText(status));
                  if (reviewed.content === null) {
                    skippedCount++;
                  } else {
                    const { snaps, foldersCreated } = await this.appendToFile(
                      targetFile, reviewed.content, enableProperties, item.reason, reviewed.existingContent);
                    fileSnapshots.push(...snaps);
                    foldersCreatedList.push(...foldersCreated);
                    appendedCount++;
                  }
                } else {
                  const destination = reviewedDestinations.get(`note-${itemIndex}`);
                  if (!destination) throw new Error("The reviewed destination is missing.");
                  const { snaps, foldersCreated } = await this.createNewNoteFile(
                    item.content,
                    item.title,
                    destination.folder,
                    enableProperties,
                    null,
                    false,
                  );
                  fileSnapshots.push(...snaps);
                  foldersCreatedList.push(...foldersCreated);
                  createdCount++;
                }
              }
              updateGenerationStage("Place notes", itemIndex + 1, plan.length);
            } catch (itemErr: any) {
              throw new Error(`Failed to process "${item.title}": ${itemErr.message}`, { cause: itemErr });
            }
          }

          const createdDestinationFolders = Array.from(new Set(
            fileSnapshots
              .filter((snapshot) => snapshot.isNewFile)
              .map((snapshot) => snapshot.path.split("/").slice(0, -1).join("/")),
          ));
          const createdDestinationSummary = createdDestinationFolders.length === 1
            ? createdDestinationFolders[0]
            : `${createdDestinationFolders.length} folders`;
          if (fileSnapshots.length > 0) {
            await finishUsefulDiagrams();
            this.plugin.historyManager.recordGeneration({
              id: `${Date.now()}`,
              timestamp: Date.now(),
              mode,
              description: mode === "multi_note_folder"
                ? `Created ${createdCount} notes in ${createdDestinationSummary}`
                : `Atomic Decomposition: ${createdCount} created, ${appendedCount} updated, ${skippedCount} already covered`,
              files: fileSnapshots,
              foldersCreated: Array.from(new Set(foldersCreatedList)),
            });
            generationRecorded = true;
            this.renderHistoryToolbar();
            this.plugin.scheduleIndexUpdate();
          }

          new Notice(mode === "multi_note_folder"
            ? `Created ${createdCount} note(s) in ${createdDestinationSummary}.`
            : `Atomic Decomposition Complete: ${createdCount} created, ${appendedCount} updated, ${skippedCount} already covered.`, 8000);
        } else if (mode === "smart") {
          updateGenerationStage("Place notes", 0, 1);
          const { decision, cleanedContent } = extractSmartDecision(result.content);
          const requestedTargetIsInScope = decision?.action === "append_to_note" && decision.targetNotePath
            ? allowedAutomaticAppendPaths.has(normalizePath(decision.targetNotePath))
              && (placementScopeFolder === undefined || isPathInFolder(decision.targetNotePath, placementScopeFolder))
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
            const reviewed = await this.reviewExistingAppend(appendTarget, cleanedContent, (status) => statusDiv.setText(status));
            if (reviewed.content === null) {
              new Notice(`Already covered in: ${appendTarget.path}`, 7000);
            } else {
              const { snaps, foldersCreated } = await this.appendToFile(
                appendTarget, reviewed.content, enableProperties, reason, reviewed.existingContent);
              fileSnapshots.push(...snaps);
              foldersCreatedList.push(...foldersCreated);
              new Notice(`Smart appended to: ${appendTarget.path}\nReason: ${reason}`, 7000);
            }
          } else if (decision?.action === "append_to_note" && requestedTargetIsInScope) {
            throw new Error(`Smart placement selected a missing note: ${decision.targetNotePath}. No file was created.`);
          } else {
            const rawFolder = decision?.action === "create_new_note" ? decision.targetFolder : undefined;
            const targetFolder = resolveFolderWithinScope(rawFolder, placementScopeFolder);
            const title = decision?.title || titleInput.value.trim();
            const draft = destinationDraft("smart-note", cleanedContent, title, targetFolder, true);
            const reviewed = await reviewDestinations([draft]);
            const reviewedFolder = reviewed.get(draft.id)?.folder;
            if (!reviewedFolder) throw new Error("The reviewed destination is missing.");
            updateGenerationStage("Place notes", 0, 1);
            const { snaps, foldersCreated } = await this.createNewNoteFile(
              cleanedContent, title, reviewedFolder, enableProperties, null, false);
            fileSnapshots.push(...snaps);
            foldersCreatedList.push(...foldersCreated);
            const outsideScopeTarget = decision?.action === "append_to_note" && !requestedTargetIsInScope;
            const reason = outsideScopeTarget
              ? `The suggested note was outside the retrieved candidates or selected folder. A new note was created inside ${reviewedFolder}.`
              : decision?.reason;
            const reasonMsg = reason ? `\nReason: ${reason}` : "";
            new Notice(`Smart placed in folder: "${reviewedFolder}"${reasonMsg}`, 7000);
          }

          updateGenerationStage("Place notes", 1, 1);
          if (fileSnapshots.length > 0) {
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
          }
        } else if (mode === "new_file") {
          const targetFolder = currentSelectedFolder;
          const draft = destinationDraft("new-note", result.content, titleInput.value.trim(), targetFolder, false);
          const reviewed = await reviewDestinations([draft]);
          const reviewedFolder = reviewed.get(draft.id)?.folder;
          if (!reviewedFolder) throw new Error("The reviewed destination is missing.");
          updateGenerationStage("Place notes", 0, 1);
          const { snaps, foldersCreated } = await this.createNewNoteFile(
            result.content, titleInput.value.trim(), reviewedFolder, enableProperties, null, false);
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);

          updateGenerationStage("Place notes", 1, 1);
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
          updateGenerationStage("Place notes", 0, 1);
          const { snaps, foldersCreated } = await this.appendToActiveNote(result.content, enableProperties, customInstruction || "Appended section via AI");
          fileSnapshots.push(...snaps);
          foldersCreatedList.push(...foldersCreated);

          updateGenerationStage("Place notes", 1, 1);
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

        savedDraft = null;
        generationProgress?.finish();
        this.close();
      } catch (err: any) {
        if (!generationRecorded && fileSnapshots.length > 0) {
          try {
            await revertFileSnapshots(this.app, fileSnapshots, Array.from(new Set(foldersCreatedList)));
          } catch (rollbackError) {
            savedDraft = null;
            console.error("Failed to restore files after generation error:", rollbackError);
            new Notice("Generation failed. Some files could not be restored. Review the error log.", 10000);
          }
        }
        if (err.name === "AbortError") {
          new Notice("Generation cancelled.");
        } else {
          generationProgress?.fail();
          console.error("autonatic Error:", err);
          statusDiv.setText(savedDraft
            ? `Could not save notes: ${err.message} Your generated draft is kept in this window. Retry saving notes to continue.`
            : `Error: ${err.message}`);
          new Notice(`Error generating note: ${err.message}`);
        }
      } finally {
        this.isGenerating = false;
        this.continueGenerationAfterClose = false;
        this.abortController = null;
        setWorkspaceBusy(this.contentEl, false);
        generateBtn.disabled = false;
        backgroundBtn.hidden = true;
        updateActionButton();
      }
    };
    generateBtn.addEventListener("click", () => { void runGeneration(); });
    retryPlacementBtn.addEventListener("click", () => { void runGeneration(true); });

    const workspace = paneEl.createDiv({ cls: "autonatic-create-workspace" });
    const source = workspace.createDiv({ cls: "autonatic-source-column" });
    source.appendChild(inputAreaRow);
    inputAreaRow.addClass("autonatic-composer");
    const sourceToolbar = source.createDiv({ cls: "autonatic-source-toolbar" });
    const imports = sourceToolbar.createEl("details", { cls: "autonatic-source-tools" });
    imports.createEl("summary", { text: "Import conversation" });
    imports.appendChild(importRow);
    const attachments = sourceToolbar.createEl("details", { cls: "autonatic-source-tools autonatic-attachments" });
    attachments.createEl("summary", { text: "Attach images" });
    attachments.appendChild(imageRow);
    source.appendChild(imageGallery);
    const instructions = source.createEl("details", { cls: "autonatic-instructions" });
    instructions.createEl("summary", { text: "Additional instructions" });
    instructions.appendChild(customRow);
    const output = workspace.createEl("details", { cls: "autonatic-output-column" });
    const revealOutput = this.configureOutputDisclosure(output);
    const outputHeading = output.createEl("summary", { text: "Note options", cls: "nemotron-workflow-heading" });
    const optionSummary = outputHeading.createSpan({ cls: "autonatic-option-summary" });
    updateOptionsSummary = () => {
      const intentLabel = creationIntent === "multiple" ? "Separate notes" : creationIntent === "append" ? "Add to active note" : "One note";
      const writingStyle = styleOptions.find((option) => option.value === this.selectedStyle)?.label || "Concise";
      optionSummary.setText(`${intentLabel}, ${writingStyle}`);
    };
    updateOptionsSummary();
    workflow.insertBefore(styleContainer, placementSection);
    for (const element of [workflow, smartScopeOptionsDiv, newNoteOptionsDiv]) output.appendChild(element);
    const options = output.createEl("details", { cls: "autonatic-advanced-options" });
    options.createEl("summary", { text: "More options" });
    options.appendChild(excalRow);
    options.appendChild(smartModeInfo);
    const activity = paneEl.createDiv({ cls: "autonatic-activity" });
    for (const element of [generationProgressHost, previewContainer]) activity.appendChild(element);
    const footer = paneEl.createDiv({ cls: "autonatic-action-bar" });
    const destination = footer.createDiv({ cls: "autonatic-destination-summary" });
    const destinationHeading = destination.createDiv({ cls: "autonatic-destination-heading" });
    setIcon(destinationHeading.createSpan({ attr: { "aria-hidden": "true" } }), "folder");
    destinationHeading.createSpan({ text: "Destination" });
    destination.appendChild(statusDiv);
    destination.appendChild(generationSummary);
    const editOutput = destination.createEl("button", { text: "Change output", cls: "autonatic-edit-output" });
    editOutput.type = "button";
    editOutput.addEventListener("click", () => {
      revealOutput();
      outputHeading.scrollIntoView({ block: "nearest" });
      outputHeading.focus();
    });
    footer.appendChild(buttonRow);
    buttonRow.insertBefore(cancelBtn, generateBtn);
    buttonRow.insertBefore(backgroundBtn, cancelBtn);
    const contextBar = source.createDiv({ cls: "autonatic-editor-context" });
    const providerButton = contextBar.createEl("button", { cls: "autonatic-provider-button", attr: { type: "button", title: "Change AI provider or model" } });
    setIcon(providerButton.createSpan({ attr: { "aria-hidden": "true" } }), "sliders-horizontal");
    const config = getGenerationConfig(this.plugin.settings);
    providerButton.createSpan({ text: `${PROVIDERS[config.provider].label}${config.model ? ` / ${config.model.split("/").pop()}` : " / Choose a model"}` });
    providerButton.addEventListener("click", () => openPluginSettings(this.app, this.plugin.manifest.id));
    shortcutHint(contextBar, "create");
    const runFromKeyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !this.isGenerating) {
        event.preventDefault();
        generateBtn.click();
      }
    };
    paneEl.addEventListener("keydown", runFromKeyboard);
    generateBtn.title = "Create notes (Ctrl/Cmd+Enter)";
    const savePreviousDraft = this.saveDraftBeforeNavigation;
    this.saveDraftBeforeNavigation = () => {
      savePreviousDraft?.();
      this.savedDraft = {
        ...this.savedDraft,
        activeTab: this.activeTab,
        source: inputTextArea.value,
        instructions: customInput.value,
        title: titleInput.value,
        mode: this.selectedMode,
        style: this.selectedStyle,
        folder: currentSelectedFolder,
        scopeFolder: currentPlacementScopeFolder,
        limitToFolder: smartScopeCheckbox.checked,
      };
    };
    if (!this.initialText && this.activeTab === "notes") setTimeout(() => inputTextArea.focus(), 0);
  }

  // ==========================================
  // TAB 2: EXCALIDRAW DIAGRAM PANE (WITH LIVE THINKING & PREVIEW)
  // ==========================================
  private renderExcalidrawPane(paneEl: HTMLElement, activeView: MarkdownView | null, hasActiveNote: boolean) {
    const infoCard = paneEl.createDiv({ cls: "nemotron-info-card" });
    infoCard.setText(hasActiveNote ? `Using ${activeView?.file?.basename} as the source` : "Create a diagram from the description below.");

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
        label: "Description",
        description: "Creates an independent Excalidraw drawing from your custom prompt, architecture spec, or images.",
      },
    ];

    const defaultSource = hasActiveNote ? "active_note" : "standalone";
    let selectedSource: "active_note" | "standalone" = this.savedDraft?.diagramSource === "active_note" && hasActiveNote
      ? "active_note"
      : this.savedDraft?.diagramSource ?? defaultSource;

    const sourceContainer = paneEl.createDiv({ cls: "nemotron-form-row" });
    const sourceLabel = sourceContainer.createEl("label", { text: "Source", cls: "nemotron-label" });
    sourceLabel.id = "nemotron-diagram-source-label";
    sourceLabel.htmlFor = "nemotron-diagram-source";

    // Standalone Options (Title & Subfolder)
    const standaloneOptionsDiv = paneEl.createDiv({ cls: "nemotron-standalone-excal-options" });
    standaloneOptionsDiv.style.display = selectedSource === "standalone" ? "block" : "none";
    infoCard.setText(selectedSource === "active_note"
      ? `Using ${activeView?.file?.basename} as the source`
      : "Create a diagram from the description below.");

    const titleRow = standaloneOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    const drawingTitleLabel = titleRow.createEl("label", { text: "Drawing title", cls: "nemotron-label" });
    const drawingTitleInput = titleRow.createEl("input", {
      type: "text",
      placeholder: hasActiveNote ? `${activeView?.file?.basename} Architecture` : "System Architecture Diagram",
      cls: "nemotron-input",
    });
    drawingTitleInput.id = "nemotron-drawing-title";
    drawingTitleInput.value = this.savedDraft?.diagramTitle ?? "";
    drawingTitleInput.name = "drawing-title";
    drawingTitleLabel.htmlFor = drawingTitleInput.id;

    const folderRow = standaloneOptionsDiv.createDiv({ cls: "nemotron-form-row" });
    const excalFolderLabel = folderRow.createEl("label", { text: "Drawing subfolder", cls: "nemotron-label" });
    const excalFolderInput = folderRow.createEl("input", {
      type: "text",
      placeholder: "e.g. Backend/Architecture or leave blank for root Excalidrawings",
      cls: "nemotron-input",
    });
    excalFolderInput.id = "nemotron-drawing-folder";
    excalFolderInput.value = this.savedDraft?.diagramFolder ?? "";
    excalFolderInput.name = "drawing-folder";
    excalFolderLabel.htmlFor = excalFolderInput.id;

    // Toggle: Link back to active note
    const linkBackRow = paneEl.createDiv({ cls: "nemotron-form-row nemotron-checkbox-row" });
    const linkBackCheckbox = linkBackRow.createEl("input", { type: "checkbox", cls: "nemotron-checkbox" });
    linkBackCheckbox.id = "nemotron-excal-linkback";
    linkBackCheckbox.checked = selectedSource === "active_note" && (this.savedDraft?.linkDiagramBack ?? hasActiveNote);
    linkBackCheckbox.disabled = !hasActiveNote || selectedSource === "standalone";

    const linkBackLabel = linkBackRow.createEl("label", { cls: "nemotron-checkbox-label" });
    linkBackLabel.setAttribute("for", "nemotron-excal-linkback");
    linkBackLabel.createSpan({ text: "Link the drawing from the active note", cls: "nemotron-checkbox-title" });

    const sourceSelect = new CustomSelect(
      sourceContainer,
      sourceOptions,
      selectedSource,
      (val) => {
        selectedSource = val as "active_note" | "standalone";
        infoCard.setText(selectedSource === "active_note"
          ? `Using ${activeView?.file?.basename} as the source`
          : "Create a diagram from the description below.");
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
    let diagramType: DiagramType | "auto" = this.savedDraft?.diagramType ?? "auto";
    let diagramDetail: DiagramOptions["detail"] = this.savedDraft?.diagramDetail ?? "balanced";
    let diagramDirection: DiagramOptions["direction"] = this.savedDraft?.diagramDirection ?? "right";
    let diagramTheme: DiagramTheme = this.savedDraft?.diagramTheme ?? "dark";
    addSelect("nemotron-diagram-type", "Diagram type", [["auto", "Automatic"], ["mind-map", "Mind map"], ["flowchart", "Flowchart"], ["architecture", "Architecture"], ["timeline", "Timeline"], ["decision-tree", "Decision tree"], ["comparison", "Comparison"]], diagramType, (value) => { diagramType = value as DiagramType | "auto"; });
    addSelect("nemotron-diagram-detail", "Detail level", [["compact", "Compact"], ["balanced", "Balanced"], ["detailed", "Detailed"]], diagramDetail, (value) => { diagramDetail = value as DiagramOptions["detail"]; });
    addSelect("nemotron-diagram-direction", "Flow direction", [["right", "Left to right"], ["down", "Top to bottom"]], diagramDirection, (value) => { diagramDirection = value as DiagramOptions["direction"]; });
    addSelect("nemotron-diagram-theme", "Canvas theme", [["dark", "Dark"], ["light", "Light"]], diagramTheme, (value) => { diagramTheme = value as DiagramTheme; });

    // Custom instructions & text input
    const excalPromptRow = paneEl.createDiv({ cls: "nemotron-form-row" });
    const excalPromptLabel = excalPromptRow.createEl("label", { text: "Diagram description or instructions", cls: "nemotron-label" });
    const excalPromptArea = excalPromptRow.createEl("textarea", {
      cls: "nemotron-textarea",
      placeholder: hasActiveNote
        ? "Optional: Add specific architectural focus or subsystem requirements..."
        : "Describe the system components, data pipeline, state machine, or microservices...",
    });
    excalPromptArea.rows = 4;
    excalPromptArea.value = this.savedDraft?.diagramPrompt ?? "";
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
    excalReasoningDetails.createEl("summary", { text: "Reasoning" });
    const excalReasoningPre = excalReasoningDetails.createEl("pre", { cls: "nemotron-reasoning-content" });

    const excalContentPreviewBox = excalPreviewContainer.createEl("div", { cls: "nemotron-content-box" });
    excalContentPreviewBox.createEl("h4", { text: "Diagram plan" });
    const excalContentPre = excalContentPreviewBox.createEl("pre", { cls: "nemotron-preview-content" });

    // Buttons for Tab 2
    const excalButtonRow = paneEl.createDiv({ cls: "nemotron-button-row" });
    const generateExcalBtn = excalButtonRow.createEl("button", {
      text: "Create diagram",
      cls: "mod-cta",
    });
    const cancelExcalBtn = excalButtonRow.createEl("button", {
      text: "Cancel",
    });
    const backgroundExcalBtn = excalButtonRow.createEl("button", {
      cls: "autonatic-background-button",
      attr: { type: "button" },
    });
    setIcon(backgroundExcalBtn.createSpan({ attr: { "aria-hidden": "true" } }), "minimize-2");
    backgroundExcalBtn.createSpan({ text: "Continue in background" });
    backgroundExcalBtn.hidden = true;

    cancelExcalBtn.addEventListener("click", () => {
      if (this.isGenerating && this.abortController) {
        this.abortController.abort();
      }
      this.close();
    });
    backgroundExcalBtn.addEventListener("click", () => {
      if (!this.isGenerating) return;
      this.continueGenerationAfterClose = true;
      backgroundExcalBtn.disabled = true;
      new Notice("Diagram generation is continuing in the background. Autonatic will notify you when it finishes.", 7000);
      this.close();
    });

    generateExcalBtn.addEventListener("click", async () => {
      if (this.isGenerating) return;
      if (!getGenerationApiKey(this.plugin.settings).trim()) {
        const providerName = PROVIDERS[this.plugin.settings.generationProvider].label;
        new Notice(`Please enter your ${providerName} API key first.`);
        excalStatusDiv.style.display = "block";
        excalStatusDiv.setText(`Error: ${providerName} API key is required. Please set it in Settings.`);
        return;
      }

      this.isGenerating = true;
      this.continueGenerationAfterClose = false;
      setWorkspaceBusy(this.contentEl, true);
      generateExcalBtn.disabled = true;
      generateExcalBtn.setText("Designing diagram...");
      backgroundExcalBtn.hidden = false;
      excalStatusDiv.style.display = "block";
      excalStatusDiv.setText("Extracting concepts and relationships with AI...");

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
        this.continueGenerationAfterClose = false;
        this.abortController = null;
        setWorkspaceBusy(this.contentEl, false);
        generateExcalBtn.disabled = false;
        generateExcalBtn.setText("Create diagram");
        backgroundExcalBtn.hidden = true;
      }
    });

    const workspace = paneEl.createDiv({ cls: "autonatic-create-workspace" });
    const source = workspace.createDiv({ cls: "autonatic-source-column" });
    for (const element of [sourceContainer, infoCard, excalPromptRow]) source.appendChild(element);
    const output = workspace.createEl("details", { cls: "autonatic-output-column" });
    this.configureOutputDisclosure(output);
    output.createEl("summary", { text: "Diagram options", cls: "nemotron-workflow-heading" });
    for (const element of [standaloneOptionsDiv, diagramControls, linkBackRow]) output.appendChild(element);
    const activity = paneEl.createDiv({ cls: "autonatic-activity" });
    activity.appendChild(excalStatusDiv);
    activity.appendChild(excalPreviewContainer);
    const footer = paneEl.createDiv({ cls: "autonatic-action-bar" });
    footer.createSpan({ text: "Saves an Excalidraw drawing in your vault.", cls: "nemotron-generation-summary" });
    footer.appendChild(excalButtonRow);
    excalButtonRow.insertBefore(cancelExcalBtn, generateExcalBtn);
    excalButtonRow.insertBefore(backgroundExcalBtn, cancelExcalBtn);
    const savePreviousDraft = this.saveDraftBeforeNavigation;
    this.saveDraftBeforeNavigation = () => {
      savePreviousDraft?.();
      this.savedDraft = {
        ...this.savedDraft,
        activeTab: this.activeTab,
        diagramSource: selectedSource,
        diagramTitle: drawingTitleInput.value,
        diagramFolder: excalFolderInput.value,
        diagramPrompt: excalPromptArea.value,
        diagramType,
        diagramDetail,
        diagramDirection,
        diagramTheme,
        linkDiagramBack: linkBackCheckbox.checked,
      };
    };
  }

  private renderHistoryToolbar() {
    this.historyRowEl.empty();

    const undoCount = this.plugin.historyManager.getUndoCount();
    const redoCount = this.plugin.historyManager.getRedoCount();
    const promptHistory = this.plugin.historyManager.getPromptHistory();

    if (undoCount === 0 && redoCount === 0 && promptHistory.length === 0) {
      this.historyRowEl.style.display = "none";
      (this.historyRowEl.parentElement as HTMLElement).style.display = "none";
      return;
    }

    this.historyRowEl.style.display = "flex";
    (this.historyRowEl.parentElement as HTMLElement).style.display = "block";

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
      this.inputTextAreaEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (this.customInputEl) {
      this.customInputEl.value = item.customInstruction || "";
    }

    if (item.style && this.styleSelectComponent) {
      this.selectedStyle = item.style;
      this.styleSelectComponent.setValue(item.style);
    }
    void this.updateModeUI?.(item.mode || this.selectedMode);

    if (item.attachedImages && Array.isArray(item.attachedImages)) {
      this.attachedImages = [...item.attachedImages];
      if (this.renderGalleryCallback) {
        this.renderGalleryCallback();
      }
    }
  }

  private async renderSmartBanner(containerEl: HTMLElement) {
    const exists = await this.app.vault.adapter.exists(vaultIndexPath(this.app));
    containerEl.empty();

    if (!exists) {
      const topRow = containerEl.createDiv({ cls: "nemotron-smart-top-row" });
      const textDiv = topRow.createDiv({ cls: "nemotron-smart-info-text" });
      textDiv.createSpan({
        text: "Autonatic needs a vault index before it can choose note locations.",
      });

      const populateBtn = topRow.createEl("button", {
        text: "Build vault index",
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
      containerEl.style.display = "none";
    }
  }

  private renderApiKeySection(containerEl: HTMLElement) {
    const config = getGenerationConfig(this.plugin.settings);
    containerEl.empty();
    containerEl.hidden = !!config.apiKey.trim() && !!config.model.trim();
    if (containerEl.hidden) return;
    const banner = containerEl.createDiv({ cls: "autonatic-connection-notice" });
    setIcon(banner.createSpan({ attr: { "aria-hidden": "true" } }), "plug");
    banner.createSpan({ text: config.apiKey.trim() ? "Choose a model to start creating." : "Connect an AI provider to start creating." });
    const setup = banner.createEl("button", { text: "Set up provider", attr: { type: "button" } });
    setup.addEventListener("click", () => openPluginSettings(this.app, this.plugin.manifest.id));
  }

  private configureOutputDisclosure(output: HTMLDetailsElement): () => void {
    let manuallyToggled = false;
    let automaticOpen = this.modalEl.clientWidth > 800;
    output.open = automaticOpen;
    output.addEventListener("toggle", () => {
      if (output.open !== automaticOpen) manuallyToggled = true;
    }, { signal: this.interfaceEvents?.signal });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || manuallyToggled) return;
      automaticOpen = entry.contentRect.width > 800;
      output.open = automaticOpen;
    });
    observer.observe(this.modalEl);
    this.outputResizeObservers.push(observer);
    return () => {
      manuallyToggled = true;
      output.open = true;
    };
  }

  private disconnectOutputObservers(): void {
    this.outputResizeObservers.forEach((observer) => observer.disconnect());
    this.outputResizeObservers = [];
  }

  onClose() {
    this.plugin.workspaceNavigation.closeHost(this);
    this.plugin.workspaceNavigation.deactivate(this);
    this.notePreview?.destroy();
    this.disconnectOutputObservers();
    this.interfaceEvents?.abort();
    this.importAbortController?.abort();
    if (this.isGenerating && this.abortController && !this.continueGenerationAfterClose) {
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

  onWorkspacePageLeave(): void {
    this.notePreview?.destroy();
    this.notePreview = undefined;
    this.disconnectOutputObservers();
    this.interfaceEvents?.abort();
    this.interfaceEvents = undefined;
    this.importAbortController?.abort();
    this.importAbortController = null;
    if (this.pasteListener) window.removeEventListener("paste", this.pasteListener, true);
    this.selectComponents.forEach((select) => select.destroy());
    this.selectComponents = [];
    this.folderNavigators.forEach((navigator) => navigator.destroy());
    this.folderNavigators = [];
    this.updateModeUI = undefined;
    this.contentEl.empty();
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
    enableProperties: boolean = false,
    folderDepthLimit: number | null = null,
    allowGeneratedFolder: boolean = true,
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    let finalContent = sanitizeMermaidDiagrams(normalizeGeneratedNoteMarkdown(content));
    const snaps: FileSnapshot[] = [];
    const foldersCreated: string[] = [];

    if (!enableProperties) {
      finalContent = finalContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
    }

    const safeTitle = deriveSafeNoteTitle(finalContent, requestedTitle);

    if (requestedFolder?.split(/[\\/]+/).some((segment) => segment === "..")) {
      throw new Error("The target folder cannot contain a parent-directory segment.");
    }
    const selectedFolder = folderDepthLimit === null
      ? normalizePath(requestedFolder || "").replace(/^\/+|\/+$/g, "")
      : enforceMaxDepthFolder(requestedFolder, folderDepthLimit);
    let folder = resolveNewNoteFolder(
      finalContent,
      selectedFolder,
      this.plugin.settings.defaultFolder,
      allowGeneratedFolder,
    );

    if (!folder) throw new Error("Generated notes cannot be created at vault root.");
    const existingFoldersByCaseFold = new Map(
      this.app.vault
        .getAllLoadedFiles()
        .filter((entry): entry is TFolder => entry instanceof TFolder)
        .map((entry) => [entry.path.toLocaleLowerCase(), entry.path]),
    );
    const segments = folder.split("/");
    let currentPath = "";
    for (const segment of segments) {
      const requestedPath = currentPath ? `${currentPath}/${segment}` : segment;
      const exactEntry = this.app.vault.getAbstractFileByPath(requestedPath);
      const existingFolderPath = exactEntry instanceof TFolder
        ? exactEntry.path
        : existingFoldersByCaseFold.get(requestedPath.toLocaleLowerCase());
      if (existingFolderPath) {
        currentPath = existingFolderPath;
        continue;
      }
      if (exactEntry) throw new Error(`The target folder path is already used by a file: ${requestedPath}`);

      await this.app.vault.createFolder(requestedPath);
      foldersCreated.push(requestedPath);
      currentPath = requestedPath;
      existingFoldersByCaseFold.set(currentPath.toLocaleLowerCase(), currentPath);
    }
    folder = currentPath;

    let filePath = normalizePath(`${folder}/${safeTitle}.md`);

    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      const altTitle = `${safeTitle} (${counter})`;
      filePath = normalizePath(`${folder}/${altTitle}.md`);
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
    enableProperties: boolean = false,
    reason?: string,
    expectedContent?: string,
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    const existingContent = await this.app.vault.read(file);
    if (expectedContent !== undefined && existingContent !== expectedContent) {
      throw new Error(`"${file.path}" changed while its append was being reviewed. Try again.`);
    }
    let finalExistingContent = existingContent;
    const sanitizedIncomingContent = sanitizeMermaidDiagrams(content);
    const snaps: FileSnapshot[] = [];
    const foldersCreated: string[] = [];

    // Keep a note together when the planner chose to append. A word count
    // cannot determine whether the material belongs in a separate note.
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
    await this.app.vault.process(file, (current) => {
      if (current !== existingContent) {
        throw new Error(`"${file.path}" changed during generation. Try again.`);
      }
      return updatedContent;
    });

    snaps.push({
      path: file.path,
      isNewFile: false,
      previousContent: existingContent,
      newContent: updatedContent,
    });

    if (this.plugin.settings.autoOpenCreatedNote) {
      try {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      } catch (openError) {
        console.warn(`Updated "${file.path}" but could not open it:`, openError);
      }
    }

    return { snaps, foldersCreated };
  }

  private async reviewExistingAppend(
    file: TFile,
    draft: string,
    onStatus: (status: string) => void,
  ): Promise<{ content: string | null; existingContent: string }> {
    const existingContent = await this.app.vault.read(file);
    onStatus(`Checking ${file.basename} for existing information...`);
    const content = await reviewAppendDraft(file.path, existingContent, draft, async (systemPrompt, userPrompt) => {
      const result = await streamChatCompletion(
        { ...this.plugin.settings, temperature: 0, enableThinking: false },
        systemPrompt,
        userPrompt,
        { onStatus },
        this.abortController?.signal,
      );
      return result.content;
    });
    return { content, existingContent };
  }

  private async appendToActiveNote(
    content: string,
    enableProperties: boolean = false,
    reason?: string
  ): Promise<{ snaps: FileSnapshot[]; foldersCreated: string[] }> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      throw new Error("No active markdown note found to append to.");
    }

    return await this.appendToFile(activeView.file, content, enableProperties, reason);
  }
}

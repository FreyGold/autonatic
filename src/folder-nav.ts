import { App, TFolder, normalizePath, setIcon } from "obsidian";
import { CustomSelect, SelectOption } from "./custom-select";
import { FolderCreationModal } from "./folder-creation-modal";
import { normalizeVaultFolderPath } from "./note-destination";

let folderNavigatorId = 0;

export class FolderNavigator {
  private app: App;
  private containerEl: HTMLElement;
  private currentPath: string = "";
  private onSelect: (folderPath: string) => void;

  private breadcrumbContainer!: HTMLElement;
  private subfoldersRow!: HTMLElement;
  private subfoldersLabelId: string;
  private manualInputId: string;
  private subfoldersSelect?: CustomSelect;
  private manualInput!: HTMLInputElement;
  private upButton!: HTMLButtonElement;
  private createFolderButton!: HTMLButtonElement;
  private createFolderLabel!: HTMLElement;
  private folderStatus!: HTMLElement;
  private creationModal?: FolderCreationModal;
  private destroyed = false;

  constructor(
    app: App,
    parentEl: HTMLElement,
    initialPath: string = "",
    onSelect: (folderPath: string) => void
  ) {
    const instanceId = ++folderNavigatorId;
    this.subfoldersLabelId = `nemotron-subfolder-label-${instanceId}`;
    this.manualInputId = `nemotron-folder-path-${instanceId}`;
    this.app = app;
    this.currentPath = normalizePath(initialPath).replace(/^\/+|\/+$/g, "");
    if (this.currentPath === ".") this.currentPath = "";
    this.onSelect = onSelect;

    this.containerEl = parentEl.createDiv({ cls: "nemotron-folder-nav" });
    this.render();
  }

  private render() {
    this.containerEl.empty();

    // 1. Top row: Up Button + Breadcrumb path
    const topRow = this.containerEl.createDiv({ cls: "nemotron-folder-top-row" });

    this.upButton = topRow.createEl("button", {
      text: "Up",
      cls: "nemotron-folder-up-btn",
    });
    this.upButton.setAttribute("type", "button");
    this.upButton.setAttribute("title", "Navigate to parent folder");
    this.upButton.addEventListener("click", () => this.navigateUp());

    this.breadcrumbContainer = topRow.createDiv({ cls: "nemotron-folder-breadcrumbs" });
    this.renderBreadcrumbs();

    // 2. Middle row: Subfolders dropdown
    this.subfoldersRow = this.containerEl.createDiv({ cls: "nemotron-folder-mid-row" });
    const subfolderLabel = this.subfoldersRow.createEl("label", { text: "Subfolder:", cls: "nemotron-folder-sub-label" });
    subfolderLabel.id = this.subfoldersLabelId;
    subfolderLabel.htmlFor = `${this.subfoldersLabelId}-control`;
    this.renderSubfoldersDropdown();

    // 3. Bottom row: Manual Path Input
    const bottomRow = this.containerEl.createDiv({ cls: "nemotron-folder-bottom-row" });
    const pathLabel = bottomRow.createEl("label", { text: "Path:", cls: "nemotron-folder-input-label" });
    pathLabel.htmlFor = this.manualInputId;

    this.manualInput = bottomRow.createEl("input", {
      type: "text",
      cls: "nemotron-input nemotron-folder-input",
      placeholder: "Vault root (or enter custom folder path)",
    });
    this.manualInput.id = this.manualInputId;
    this.manualInput.name = "folder-path";
    this.manualInput.value = this.currentPath;

    this.manualInput.addEventListener("input", () => {
      try {
        this.currentPath = normalizeVaultFolderPath(this.manualInput.value);
      } catch {
        this.updateCreationState();
        return;
      }
      this.renderBreadcrumbs();
      this.renderSubfoldersDropdown();
      this.updateUpButton();
      this.onSelect(this.currentPath);
      this.updateCreationState();
    });
    this.manualInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.ctrlKey || event.metaKey || !this.isMissingFolder()) return;
      event.preventDefault();
      event.stopPropagation();
      this.openFolderCreation();
    });

    const actions = this.containerEl.createDiv({ cls: "nemotron-folder-actions" });
    this.folderStatus = actions.createSpan({ cls: "nemotron-folder-status", attr: { role: "status", "aria-live": "polite" } });
    this.createFolderButton = actions.createEl("button", { cls: "nemotron-folder-create-btn", attr: { type: "button" } });
    setIcon(this.createFolderButton.createSpan({ attr: { "aria-hidden": "true" } }), "folder-plus");
    this.createFolderLabel = this.createFolderButton.createSpan({ text: "New folder" });
    this.createFolderButton.addEventListener("click", () => this.openFolderCreation());

    this.updateUpButton();
    this.updateCreationState();
  }

  private renderBreadcrumbs() {
    this.breadcrumbContainer.empty();

    // Root chip
    const rootChip = this.breadcrumbContainer.createEl("button", {
      text: "Root",
      cls: `nemotron-breadcrumb-chip ${this.currentPath === "" ? "is-active" : ""}`,
    });
    rootChip.type = "button";
    rootChip.setAttribute("aria-label", "Go to vault root");
    rootChip.addEventListener("click", () => this.navigateTo(""));

    if (this.currentPath) {
      const parts = this.currentPath.split("/");
      let accum = "";

      parts.forEach((part, index) => {
        accum = accum ? `${accum}/${part}` : part;
        const targetPath = accum;

        this.breadcrumbContainer.createSpan({ text: "/", cls: "nemotron-breadcrumb-sep" });

        const isLast = index === parts.length - 1;
        const chip = this.breadcrumbContainer.createEl("button", {
          text: part,
          cls: `nemotron-breadcrumb-chip ${isLast ? "is-active" : ""}`,
        });

        chip.type = "button";
        if (isLast) chip.setAttribute("aria-current", "location");
        chip.addEventListener("click", () => this.navigateTo(targetPath));
      });
    }
  }

  private renderSubfoldersDropdown() {
    this.subfoldersSelect?.destroy();
    this.subfoldersRow.querySelector(".nemotron-custom-select-container")?.remove();
    const subfolders = this.getSubfolders(this.currentPath);
    const options: SelectOption[] = subfolders.length === 0
      ? [{ value: "__none__", label: "No subfolders found", disabled: true }]
      : [
          { value: "__none__", label: "Enter or choose a subfolder" },
          ...subfolders.map((folder) => ({ value: folder.path, label: folder.name })),
        ];
    this.subfoldersSelect = new CustomSelect(
      this.subfoldersRow,
      options,
      "__none__",
      (selected) => {
        if (selected !== "__none__") this.navigateTo(selected);
      },
      { controlId: `${this.subfoldersLabelId}-control`, labelId: this.subfoldersLabelId },
    );
  }

  private getSubfolders(folderPath: string): TFolder[] {
    const allFolders: TFolder[] = [];
    const collect = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder && !child.name.startsWith(".")) {
          allFolders.push(child);
        }
      }
    };

    let targetFolder: TFolder | null = null;
    if (folderPath === "") {
      targetFolder = this.app.vault.getRoot();
    } else {
      const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
      if (abstractFile instanceof TFolder) {
        targetFolder = abstractFile;
      }
    }

    if (targetFolder) {
      collect(targetFolder);
    }

    return allFolders.sort((a, b) => a.name.localeCompare(b.name));
  }

  private navigateTo(path: string) {
    this.currentPath = normalizePath(path).replace(/^\/+|\/+$/g, "");
    if (this.currentPath === ".") this.currentPath = "";

    this.manualInput.value = this.currentPath;
    this.renderBreadcrumbs();
    this.renderSubfoldersDropdown();
    this.updateUpButton();
    this.updateCreationState();
    this.onSelect(this.currentPath);
  }

  private navigateUp() {
    if (!this.currentPath) return;

    const parts = this.currentPath.split("/");
    parts.pop();
    const parentPath = parts.join("/");
    this.navigateTo(parentPath);
  }

  private updateUpButton() {
    if (this.currentPath === "") {
      this.upButton.disabled = true;
      this.upButton.addClass("is-disabled");
    } else {
      this.upButton.disabled = false;
      this.upButton.removeClass("is-disabled");
    }
  }

  private isMissingFolder(): boolean {
    return !!this.currentPath && !this.app.vault.getAbstractFileByPath(this.currentPath);
  }

  private updateCreationState(): void {
    let message = "";
    let valid = true;
    try {
      normalizeVaultFolderPath(this.manualInput.value);
      const existing = this.currentPath ? this.app.vault.getAbstractFileByPath(this.currentPath) : this.app.vault.getRoot();
      if (existing && !(existing instanceof TFolder)) {
        message = "A file already uses this path.";
        valid = false;
      } else if (!existing) message = "Folder doesn’t exist.";
    } catch {
      message = "Choose a valid folder path.";
      valid = false;
    }
    if (this.folderStatus.textContent !== message) this.folderStatus.setText(message);
    this.folderStatus.hidden = !message;
    this.createFolderLabel.setText(this.isMissingFolder() ? "Create folder" : "New folder");
    this.createFolderButton.disabled = !valid;
    this.manualInput.setAttribute("aria-invalid", String(!valid));
  }

  private openFolderCreation(): void {
    if (this.destroyed || this.creationModal || this.createFolderButton.disabled) return;
    const missingPath = this.isMissingFolder() ? normalizeVaultFolderPath(this.manualInput.value) : undefined;
    this.creationModal = new FolderCreationModal(this.app, missingPath ? "" : this.currentPath, (path) => {
      this.creationModal = undefined;
      if (this.destroyed) return;
      if (path) this.navigateTo(path);
      this.createFolderButton.focus();
    }, missingPath);
    this.creationModal.open();
  }

  public setPath(path: string) {
    this.navigateTo(path);
  }

  public getPath(): string {
    return this.currentPath;
  }

  public destroy(): void {
    this.destroyed = true;
    this.creationModal?.close();
    this.subfoldersSelect?.destroy();
  }
}

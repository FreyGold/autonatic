import { App, TFolder, normalizePath } from "obsidian";

export class FolderNavigator {
  private app: App;
  private containerEl: HTMLElement;
  private currentPath: string = "";
  private onSelect: (folderPath: string) => void;

  private breadcrumbContainer: HTMLElement;
  private subfoldersSelect: HTMLSelectElement;
  private manualInput: HTMLInputElement;
  private upButton: HTMLButtonElement;

  constructor(
    app: App,
    parentEl: HTMLElement,
    initialPath: string = "",
    onSelect: (folderPath: string) => void
  ) {
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
    const midRow = this.containerEl.createDiv({ cls: "nemotron-folder-mid-row" });
    midRow.createEl("span", { text: "Subfolder:", cls: "nemotron-folder-sub-label" });

    this.subfoldersSelect = midRow.createEl("select", { cls: "nemotron-folder-select" });
    this.renderSubfoldersDropdown();

    this.subfoldersSelect.addEventListener("change", () => {
      const selected = this.subfoldersSelect.value;
      if (selected !== "__none__") {
        this.navigateTo(selected);
      }
    });

    // 3. Bottom row: Manual Path Input
    const bottomRow = this.containerEl.createDiv({ cls: "nemotron-folder-bottom-row" });
    bottomRow.createEl("span", { text: "Path:", cls: "nemotron-folder-input-label" });

    this.manualInput = bottomRow.createEl("input", {
      type: "text",
      cls: "nemotron-input nemotron-folder-input",
      placeholder: "Vault root (or enter custom folder path)",
    });
    this.manualInput.value = this.currentPath;

    this.manualInput.addEventListener("input", () => {
      this.currentPath = normalizePath(this.manualInput.value.trim()).replace(/^\/+|\/+$/g, "");
      if (this.currentPath === ".") this.currentPath = "";
      this.renderBreadcrumbs();
      this.renderSubfoldersDropdown();
      this.updateUpButton();
      this.onSelect(this.currentPath);
    });

    this.updateUpButton();
  }

  private renderBreadcrumbs() {
    this.breadcrumbContainer.empty();

    // Root chip
    const rootChip = this.breadcrumbContainer.createSpan({
      text: "Root",
      cls: `nemotron-breadcrumb-chip ${this.currentPath === "" ? "is-active" : ""}`,
    });
    rootChip.addEventListener("click", () => this.navigateTo(""));

    if (this.currentPath) {
      const parts = this.currentPath.split("/");
      let accum = "";

      parts.forEach((part, index) => {
        accum = accum ? `${accum}/${part}` : part;
        const targetPath = accum;

        this.breadcrumbContainer.createSpan({ text: "/", cls: "nemotron-breadcrumb-sep" });

        const isLast = index === parts.length - 1;
        const chip = this.breadcrumbContainer.createSpan({
          text: part,
          cls: `nemotron-breadcrumb-chip ${isLast ? "is-active" : ""}`,
        });

        chip.addEventListener("click", () => this.navigateTo(targetPath));
      });
    }
  }

  private renderSubfoldersDropdown() {
    this.subfoldersSelect.empty();

    const noneOpt = this.subfoldersSelect.createEl("option", {
      text: "-- Enter or choose a subfolder --",
      value: "__none__",
    });
    noneOpt.selected = true;

    const subfolders = this.getSubfolders(this.currentPath);

    if (subfolders.length === 0) {
      this.subfoldersSelect.disabled = true;
      noneOpt.text = "-- No subfolders found --";
    } else {
      this.subfoldersSelect.disabled = false;
      subfolders.forEach((f) => {
        this.subfoldersSelect.createEl("option", {
          text: f.name,
          value: f.path,
        });
      });
    }
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

  public setPath(path: string) {
    this.navigateTo(path);
  }

  public getPath(): string {
    return this.currentPath;
  }
}

import { App, TFolder, normalizePath } from "obsidian";
import { CustomSelect, SelectOption } from "./custom-select";

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

  public destroy(): void {
    this.subfoldersSelect?.destroy();
  }
}

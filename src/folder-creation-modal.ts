import { App, Modal } from "obsidian";
import { applyDesignSystem } from "./design-system";
import { createVaultFolder } from "./folder-creation";
import { normalizeVaultFolderPath } from "./note-destination";

let folderCreationId = 0;

export class FolderCreationModal extends Modal {
  private settled = false;
  private creating = false;

  constructor(
    app: App,
    private parentPath: string,
    private resolveResult: (path: string | null) => void,
    private missingPath?: string,
  ) { super(app); }

  onOpen(): void {
    const id = `autonatic-folder-create-${++folderCreationId}`;
    this.modalEl.addClass("autonatic-folder-create-shell");
    applyDesignSystem(this.modalEl);
    this.contentEl.addClass("autonatic-folder-create-modal");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-labelledby", `${id}-title`);
    this.contentEl.createEl("h3", {
      text: this.missingPath ? "Create this folder?" : "New folder",
      attr: { id: `${id}-title` },
    });
    this.contentEl.createEl("p", {
      text: this.missingPath
        ? `The folder “${this.missingPath}” doesn’t exist. Confirm to create it.`
        : `Create a folder in ${this.parentPath || "the vault root"}.`,
      cls: "autonatic-folder-create-description",
    });
    const label = this.contentEl.createEl("label", { text: this.missingPath ? "Folder path" : "Folder name" });
    label.htmlFor = `${id}-input`;
    const input = this.contentEl.createEl("input", {
      type: "text",
      placeholder: this.missingPath ? "Projects/Research" : "Folder name or nested/path",
      attr: { id: `${id}-input`, "aria-describedby": `${id}-preview` },
    });
    input.value = this.missingPath || "";
    const preview = this.contentEl.createDiv({ cls: "autonatic-folder-create-preview", attr: { id: `${id}-preview` } });
    const error = this.contentEl.createDiv({ cls: "autonatic-folder-create-error", attr: { role: "alert" } });
    error.hidden = true;
    const actions = this.contentEl.createDiv({ cls: "autonatic-folder-create-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", cls: "an-button-cancel mod-warning", attr: { type: "button" } });
    const confirm = actions.createEl("button", { text: "Create folder", cls: "mod-cta", attr: { type: "button" } });
    const requestedPath = () => this.missingPath
      ? input.value
      : this.parentPath ? `${this.parentPath}/${input.value}` : input.value;
    const updatePreview = () => {
      confirm.disabled = !input.value.trim();
      error.hidden = true;
      input.removeAttribute("aria-invalid");
      try {
        const path = normalizeVaultFolderPath(requestedPath());
        preview.setText(path ? `Path: ${path}. Missing parent folders will also be created.` : "Choose a name for the new folder.");
      } catch {
        preview.setText("Choose a valid folder name or path.");
      }
    };
    const submit = async () => {
      if (this.creating || !input.value.trim()) return;
      try {
        const path = normalizeVaultFolderPath(requestedPath());
        if (!path) throw new Error("Enter a folder name.");
        this.creating = true;
        input.disabled = true;
        cancel.disabled = true;
        confirm.disabled = true;
        confirm.setText("Creating…");
        const created = await createVaultFolder(this.app, path);
        this.creating = false;
        this.finish(created);
      } catch (cause) {
        this.creating = false;
        input.disabled = false;
        cancel.disabled = false;
        confirm.disabled = false;
        confirm.setText("Create folder");
        error.setText(cause instanceof Error ? cause.message : "Could not create the folder.");
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    };
    input.addEventListener("input", updatePreview);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      void submit();
    });
    cancel.addEventListener("click", () => this.finish(null));
    confirm.addEventListener("click", () => { void submit(); });
    updatePreview();
    input.focus();
  }

  close(): void {
    if (!this.creating) super.close();
  }

  private finish(path: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.resolveResult(path);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(null);
    }
  }
}

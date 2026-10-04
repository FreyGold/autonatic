import { App, Modal, TFolder, normalizePath, setIcon } from "obsidian";
import { ensureNonRootNoteFolder } from "./note-destination";
import { applyDesignSystem } from "./design-system";

export interface NoteDestinationDraft {
  id: string;
  title: string;
  folder: string;
}

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
}

function folderTree(paths: readonly string[]): FolderNode {
  const root: FolderNode = { name: "Vault", path: "", children: new Map() };
  for (const path of paths) {
    let parent = root;
    let current = "";
    for (const name of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${name}` : name;
      let child = parent.children.get(name.toLocaleLowerCase());
      if (!child) {
        child = { name, path: current, children: new Map() };
        parent.children.set(name.toLocaleLowerCase(), child);
      }
      parent = child;
    }
  }
  return root;
}

export class PlacementReviewModal extends Modal {
  private destinations: NoteDestinationDraft[];
  private settled = false;
  private selectedNoteId: string | null = null;
  private draggedNoteId: string | null = null;
  private extraFolders = new Set<string>();
  private openFolders = new Set<string>();
  private existingFolders = new Set<string>();
  private resolveResult: (value: NoteDestinationDraft[] | null) => void;
  private signal?: AbortSignal;
  private abortListener?: () => void;

  constructor(
    app: App,
    drafts: readonly NoteDestinationDraft[],
    resolve: (value: NoteDestinationDraft[] | null) => void,
    signal?: AbortSignal,
  ) {
    super(app);
    this.destinations = drafts.map((draft) => ({
      ...draft,
      folder: ensureNonRootNoteFolder(draft.folder),
    }));
    this.resolveResult = resolve;
    this.signal = signal;
    for (const destination of this.destinations) {
      const parts = destination.folder.split("/");
      for (let index = 1; index <= parts.length; index++) {
        this.openFolders.add(parts.slice(0, index).join("/"));
      }
    }
  }

  onOpen(): void {
    this.modalEl.addClass("autonatic-placement-shell");
    applyDesignSystem(this.modalEl);
    this.contentEl.addClass("autonatic-placement-modal");
    this.existingFolders = new Set(
      this.app.vault.getAllLoadedFiles()
        .filter((entry): entry is TFolder => entry instanceof TFolder)
        .map((folder) => folder.path)
        .filter((path) => path && path !== "/" && !path.split("/").some((part) => part.startsWith("."))),
    );

    const heading = this.contentEl.createDiv({ cls: "autonatic-placement-heading" });
    const headingIcon = heading.createSpan({ cls: "autonatic-placement-heading-icon", attr: { "aria-hidden": "true" } });
    setIcon(headingIcon, "folder-tree");
    const headingCopy = heading.createDiv();
    headingCopy.createEl("h2", { text: "Choose where these notes belong" });
    headingCopy.createEl("p", {
      text: "Drag a note onto a folder. Nothing is written until you approve this plan.",
    });

    const toolbar = this.contentEl.createDiv({ cls: "autonatic-placement-toolbar" });
    const folderLabel = toolbar.createEl("label", { text: "Add a destination" });
    folderLabel.htmlFor = "autonatic-placement-new-folder";
    const folderControls = toolbar.createDiv({ cls: "autonatic-placement-folder-controls" });
    const folderInput = folderControls.createEl("input", {
      type: "text",
      placeholder: "Projects/Research",
      attr: { id: "autonatic-placement-new-folder" },
    });
    const addFolder = folderControls.createEl("button", { text: "Add folder", attr: { type: "button" } });
    const status = toolbar.createDiv({ cls: "autonatic-placement-status", attr: { role: "status", "aria-live": "polite" } });

    const tree = this.contentEl.createDiv({ cls: "autonatic-placement-tree", attr: { role: "tree", "aria-label": "Planned note destinations" } });
    const summary = this.contentEl.createDiv({ cls: "autonatic-placement-summary", attr: { "aria-live": "polite" } });

    const canonicalFolder = (value: string): string => {
      const requested = ensureNonRootNoteFolder(value);
      const byFold = new Map([...this.existingFolders].map((path) => [path.toLocaleLowerCase(), path]));
      const parts = requested.split("/");
      let current = "";
      for (const part of parts) {
        const next = current ? `${current}/${part}` : part;
        current = byFold.get(next.toLocaleLowerCase()) || next;
      }
      return current;
    };
    for (const destination of this.destinations) {
      destination.folder = canonicalFolder(destination.folder);
      this.openFolders.add(destination.folder);
    }

    const moveNote = (noteId: string, folder: string) => {
      const note = this.destinations.find((item) => item.id === noteId);
      if (!note) return;
      note.folder = canonicalFolder(folder);
      this.openFolders.add(note.folder);
      this.selectedNoteId = null;
      status.setText(`“${note.title}” will be created in ${note.folder}.`);
      renderTree();
    };

    const renderTree = () => {
      tree.empty();
      const allFolders = new Set([...this.existingFolders, ...this.extraFolders]);
      for (const note of this.destinations) allFolders.add(note.folder);
      const root = folderTree([...allFolders]);

      const occupied = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path.toLocaleLowerCase()));
      const paths = new Map<string, string>();
      for (const note of this.destinations) {
        let path = normalizePath(`${note.folder}/${note.title}.md`);
        let counter = 1;
        while (occupied.has(path.toLocaleLowerCase())) {
          path = normalizePath(`${note.folder}/${note.title} (${counter++}).md`);
        }
        occupied.add(path.toLocaleLowerCase());
        paths.set(note.id, path);
      }

      const renderFolder = (node: FolderNode, depth: number, host: HTMLElement) => {
        const details = host.createEl("details", { cls: "autonatic-placement-folder" });
        details.open = this.openFolders.has(node.path);
        const folderSummary = details.createEl("summary", {
          cls: "autonatic-placement-folder-row",
          attr: { role: "treeitem", "aria-label": `Folder ${node.path}` },
        });
        folderSummary.setCssProps({ paddingLeft: `${10 + depth * 18}px` });
        const chevron = folderSummary.createSpan({ cls: "autonatic-placement-chevron", attr: { "aria-hidden": "true" } });
        setIcon(chevron, "chevron-right");
        const icon = folderSummary.createSpan({ cls: "autonatic-placement-folder-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, "folder");
        folderSummary.createSpan({ text: node.name, cls: "autonatic-placement-folder-name" });
        const assigned = this.destinations.filter((note) => note.folder === node.path).length;
        if (assigned) folderSummary.createSpan({ text: String(assigned), cls: "autonatic-placement-count" });
        if (!this.existingFolders.has(node.path)) {
          folderSummary.createSpan({ text: "new", cls: "autonatic-placement-new" });
        }
        const moveHere = folderSummary.createEl("button", {
          text: "Move here",
          cls: "autonatic-placement-move-here",
          attr: { type: "button", "aria-label": `Move selected note to ${node.path}` },
        });
        moveHere.hidden = !this.selectedNoteId;
        moveHere.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (this.selectedNoteId) moveNote(this.selectedNoteId, node.path);
        });
        details.addEventListener("toggle", () => {
          if (details.open) this.openFolders.add(node.path);
          else this.openFolders.delete(node.path);
        });
        const clearDropState = () => folderSummary.removeClass("is-drop-target");
        folderSummary.addEventListener("dragenter", (event) => {
          if (!this.draggedNoteId) return;
          event.preventDefault();
          folderSummary.addClass("is-drop-target");
        });
        folderSummary.addEventListener("dragover", (event) => {
          if (!this.draggedNoteId) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        });
        folderSummary.addEventListener("dragleave", (event) => {
          if (!folderSummary.contains(event.relatedTarget as Node | null)) clearDropState();
        });
        folderSummary.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearDropState();
          const noteId = event.dataTransfer?.getData("text/autonatic-note") || this.draggedNoteId;
          if (noteId) moveNote(noteId, node.path);
        });

        for (const note of this.destinations.filter((item) => item.folder === node.path)) {
          const row = details.createDiv({
            cls: `autonatic-placement-note${this.selectedNoteId === note.id ? " is-selected" : ""}`,
            attr: { draggable: "true", role: "treeitem", tabindex: "0", "aria-selected": String(this.selectedNoteId === note.id) },
          });
          row.setCssProps({ marginLeft: `${28 + depth * 18}px` });
          const grip = row.createSpan({ cls: "autonatic-placement-grip", attr: { "aria-hidden": "true" } });
          setIcon(grip, "grip-vertical");
          const noteCopy = row.createDiv({ cls: "autonatic-placement-note-copy" });
          noteCopy.createSpan({ text: paths.get(note.id) || "", cls: "autonatic-placement-note-path" });
          noteCopy.createSpan({ text: note.title, cls: "autonatic-placement-note-title" });
          row.addEventListener("click", () => {
            this.selectedNoteId = this.selectedNoteId === note.id ? null : note.id;
            renderTree();
          });
          row.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            this.selectedNoteId = this.selectedNoteId === note.id ? null : note.id;
            renderTree();
          });
          row.addEventListener("dragstart", (event) => {
            this.draggedNoteId = note.id;
            row.addClass("is-dragging");
            event.dataTransfer?.setData("text/autonatic-note", note.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          });
          row.addEventListener("dragend", () => {
            this.draggedNoteId = null;
            row.removeClass("is-dragging");
            tree.querySelectorAll(".is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
          });
        }

        [...node.children.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .forEach((child) => renderFolder(child, depth + 1, details));
      };

      [...root.children.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((child) => renderFolder(child, 0, tree));
      summary.setText(`${this.destinations.length} note${this.destinations.length === 1 ? "" : "s"} ready. Nothing will be created at vault root.`);
    };

    const addDestinationFolder = () => {
      try {
        const raw = folderInput.value.trim();
        if (!raw) return;
        const folder = canonicalFolder(raw);
        const occupied = this.app.vault.getAbstractFileByPath(folder);
        if (occupied && !(occupied instanceof TFolder)) {
          status.setText(`A file already uses the path “${folder}”.`);
          return;
        }
        this.extraFolders.add(folder);
        const parts = folder.split("/");
        for (let index = 1; index <= parts.length; index++) this.openFolders.add(parts.slice(0, index).join("/"));
        folderInput.value = "";
        status.setText(`Added ${folder} as a destination.`);
        renderTree();
      } catch (error) {
        status.setText(error instanceof Error ? error.message : "Choose a valid folder path.");
      }
    };
    addFolder.addEventListener("click", addDestinationFolder);
    folderInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addDestinationFolder();
    });

    const actions = this.contentEl.createDiv({ cls: "autonatic-placement-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", cls: "an-button-cancel mod-warning", attr: { type: "button" } });
    const confirm = actions.createEl("button", {
      text: `Create ${this.destinations.length} note${this.destinations.length === 1 ? "" : "s"}`,
      cls: "mod-cta",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.finish(null));
    confirm.addEventListener("click", () => this.finish(this.destinations.map((item) => ({ ...item }))));

    renderTree();
    this.abortListener = () => this.finish(null);
    this.signal?.addEventListener("abort", this.abortListener, { once: true });
    if (this.signal?.aborted) this.finish(null);
  }

  private finish(result: NoteDestinationDraft[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(result);
    this.close();
  }

  onClose(): void {
    if (this.abortListener) this.signal?.removeEventListener("abort", this.abortListener);
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(null);
    }
    this.contentEl.empty();
  }
}

export function reviewNoteDestinations(
  app: App,
  drafts: readonly NoteDestinationDraft[],
  signal?: AbortSignal,
): Promise<NoteDestinationDraft[] | null> {
  if (drafts.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => new PlacementReviewModal(app, drafts, resolve, signal).open());
}

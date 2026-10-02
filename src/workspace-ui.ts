import { App, setIcon } from "obsidian";
import type { Modal } from "obsidian";

export type WorkspacePage = "create" | "search" | "organize";
export type SettingsSection = "providers" | "creation" | "search" | "privacy" | "advanced";

type WorkspaceModal = Modal & {
  onOpen?: () => void;
  onClose?: () => void;
  onWorkspacePageLeave?: () => void;
};

/** Render every workspace page inside one Obsidian modal shell. */
export class WorkspaceNavigation {
  private readonly factories = new Map<WorkspacePage, () => WorkspaceModal>();
  private host?: WorkspaceModal;
  private active?: WorkspaceModal;
  private editor?: WorkspaceModal;
  private switching = false;

  setFactory(page: WorkspacePage, create: () => WorkspaceModal): void {
    this.factories.set(page, create);
  }

  activate(page: WorkspacePage, modal: WorkspaceModal): void {
    this.host ??= modal;
    this.active = modal;
    if (page === "create") this.editor = modal;
  }

  navigate(page: WorkspacePage, source: WorkspaceModal): void {
    if (this.active && source !== this.active) return;
    const target = page === "create" && this.editor
      ? this.editor
      : this.factories.get(page)?.();
    if (!target || source === target) return;
    this.active = target;
    if (page === "create") this.editor = target;

    this.switching = true;
    if (source === this.host) source.onWorkspacePageLeave?.();
    else source.onClose?.();

    const host = this.host;
    if (!host) {
      this.switching = false;
      return;
    }
    host.modalEl.classList.remove("autonatic-crafter-shell", "autonatic-ask-shell", "autonatic-arrange-shell");
    host.contentEl.classList.remove("nemotron-modal-container", "autonatic-ask-modal", "autonatic-arrange-modal");
    host.contentEl.empty();

    if (target !== host) {
      target.modalEl = host.modalEl;
      target.contentEl = host.contentEl;
      target.close = () => host.close();
    }
    target.onOpen?.();
    this.switching = false;
  }

  closeHost(host: WorkspaceModal): void {
    if (this.host !== host) return;
    this.switching = true;
    if (this.active && this.active !== host) this.active.onClose?.();
    this.active = undefined;
    this.editor = undefined;
    this.host = undefined;
    this.switching = false;
  }

  deactivate(modal: WorkspaceModal): void {
    if (this.switching) return;
    if (this.active !== modal) return;
    this.active = undefined;
    if (this.editor === modal) this.editor = undefined;
  }
}

export function iconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "autonatic-quiet-button",
    attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), icon);
  button.addEventListener("click", onClick);
  return button;
}

/** Shared navigation keeps the same landmarks in every tool. */
export function workspaceHeader(
  root: HTMLElement,
  active: WorkspacePage,
  navigate: (page: WorkspacePage) => void,
  openSettings: () => void,
  version?: string,
): HTMLElement {
  const header = root.createEl("header", { cls: "autonatic-workspace-header" });
  const identity = header.createDiv({ cls: "autonatic-workspace-identity" });
  const mark = identity.createSpan({ cls: "autonatic-workspace-mark", attr: { "aria-hidden": "true" } });
  setIcon(mark, "notebook-pen");
  identity.createEl("h2", { text: "autonatic", cls: "nemotron-modal-title" });
  if (version) identity.createSpan({ text: `v${version}`, cls: "autonatic-version" });
  iconButton(header, "Settings", "settings-2", openSettings);
  const nav = header.createEl("nav", { cls: "autonatic-workspace-nav", attr: { "aria-label": "Note tools" } });
  const pages: Array<[WorkspacePage, string, string]> = [
    ["create", "Create", "file-plus-2"],
    ["search", "Search", "search"],
    ["organize", "Organize", "folder-tree"],
  ];
  for (const [page, label, icon] of pages) {
    const button = nav.createEl("button", {
      cls: `autonatic-workspace-nav-button${page === active ? " is-active" : ""}`,
      attr: { type: "button", "data-workspace-navigation": "true", ...(page === active ? { "aria-current": "page" } : {}) },
    });
    setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => { if (page !== active) navigate(page); });
  }
  return header;
}

export function openPluginSettings(app: App, pluginId: string, section: SettingsSection = "providers"): void {
  const settings = (app as App & {
    setting?: { open: () => void; openTabById: (id: string) => void };
  }).setting;
  settings?.open();
  settings?.openTabById(pluginId);
  // The settings tab may still be reading its local placement index.
  document.dispatchEvent(new CustomEvent("autonatic:settings-section", { detail: section }));
}

export function setWorkspaceBusy(root: HTMLElement, busy: boolean): void {
  // Keep live status messages outside busy regions so progress is announced.
  root.querySelectorAll<HTMLElement>(".autonatic-create-workspace").forEach((workspace) => {
    workspace.setAttribute("aria-busy", String(busy));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-workspace-navigation], .autonatic-workspace-header button, .nemotron-tab-btn, .autonatic-provider-button")
    .forEach((button) => { button.disabled = busy; });
}

export function shortcutHint(parent: HTMLElement, action: string): void {
  const hint = parent.createSpan({ cls: "autonatic-shortcut-hint" });
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  hint.createEl("kbd", { text: `${modifier} + Enter` });
  hint.createSpan({ text: ` to ${action}` });
}

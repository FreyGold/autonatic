import { App, Component, MarkdownRenderer } from "obsidian";
import type { DestinationMode } from "./destination-modes";
import { extractAtomicDecompositionPlan, extractSmartDecision } from "./vault-indexer";

/** Format drafts locally; provider placement instructions stay in the source disclosure. */
export class NotePreview {
  private readonly rendered: HTMLElement;
  private readonly source: HTMLElement;
  private timer?: number;
  private revision = 0;
  private component?: Component;
  private pending = new Set<Component>();
  private latest?: { content: string; mode: DestinationMode; revision: number };

  constructor(private app: App, private host: HTMLElement) {
    host.createEl("h4", { text: "Live draft" });
    this.rendered = host.createDiv({ cls: "autonatic-rendered-draft markdown-rendered" });
    const details = host.createEl("details", { cls: "autonatic-draft-source" });
    details.createEl("summary", { text: "Generated source" });
    this.source = details.createEl("pre", { cls: "nemotron-preview-content" });
  }

  update(content: string, mode: DestinationMode, complete = false): void {
    this.source.setText(content);
    const revision = ++this.revision;
    this.latest = { content, mode, revision };
    if (!content) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      this.component?.unload();
      this.rendered.setText("Writing your notes…");
      return;
    }
    if (!complete && (mode === "multi_note" || mode === "multi_note_folder")) {
      this.rendered.setText("Writing separate notes. Completed drafts will appear here.");
      return;
    }
    if (complete) { window.clearTimeout(this.timer); this.timer = undefined; }
    if (this.timer === undefined) this.timer = window.setTimeout(() => {
      this.timer = undefined;
      const latest = this.latest;
      if (latest) void this.render(latest.content, latest.mode, latest.revision);
    }, complete ? 0 : 180);
  }

  private async render(content: string, mode: DestinationMode, revision: number): Promise<void> {
    if (!this.host.isConnected || revision !== this.revision) return;
    let markdown: string;
    try {
      markdown = mode === "multi_note" || mode === "multi_note_folder"
        ? extractAtomicDecompositionPlan(content).map((note) => note.content).join("\n\n---\n\n")
        : extractSmartDecision(content).cleanedContent.replace(/```(?:smart-decision|json:smart-decision)[\s\S]*$/, "");
    } catch { return; }
    const component = new Component();
    component.load();
    this.pending.add(component);
    const next = createDiv();
    try {
      await MarkdownRenderer.render(this.app, markdown, next, "", component);
      if (!this.host.isConnected || revision !== this.revision) { component.unload(); return; }
      this.component?.unload();
      this.component = component;
      this.rendered.replaceChildren(next);
    } catch {
      component.unload();
    } finally { this.pending.delete(component); }
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.revision++;
    this.component?.unload();
    this.pending.forEach((component) => component.unload());
    this.pending.clear();
  }
}

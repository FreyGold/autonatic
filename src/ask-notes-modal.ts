import { App, Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import type NemotronPlugin from "./main";
import type { SearchChunk } from "./ask-notes-search";
import { workspaceHeader, openPluginSettings } from "./workspace-ui";

export class AskNotesModal extends Modal {
  private asking = false;
  private abortController?: AbortController;
  private unsubscribeStatus?: () => void;
  private answerRenderer?: Component;
  private closed = false;

  constructor(app: App, private plugin: NemotronPlugin) { super(app); }

  onOpen(): void {
    this.closed = false;
    const { contentEl } = this;
    this.modalEl.addClass("autonatic-ask-shell");
    contentEl.empty();
    contentEl.addClass("autonatic-ask-modal");
    this.plugin.workspaceNavigation.activate("search", this);
    workspaceHeader(contentEl, "search", (page) => this.plugin.workspaceNavigation.navigate(page, this), () => {
      this.close();
      openPluginSettings(this.app, this.plugin.manifest.id, "search");
    });
    const header = contentEl.createDiv({ cls: "autonatic-page-heading" });
    const headingCopy = header.createDiv();
    headingCopy.createEl("h3", { text: "Search your notes" });
    headingCopy.createEl("p", { text: "Search original passages and open the notes they came from." });
    const status = contentEl.createDiv({ cls: "autonatic-ask-status" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const form = contentEl.createEl("form", { cls: "autonatic-ask-form" });
    const label = form.createEl("label", { text: "Search", cls: "autonatic-ask-label" });
    const icon = form.createSpan({ cls: "autonatic-ask-search-icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "search");
    const input = form.createEl("input", {
      type: "search",
      placeholder: "Search a term, topic, or question",
      cls: "autonatic-ask-input",
    });
    input.id = "autonatic-ask-question";
    input.name = "query";
    input.autocomplete = "off";
    label.htmlFor = input.id;
    const askButton = form.createEl("button", { cls: "autonatic-ask-button" });
    askButton.type = "submit";
    askButton.setAttribute("aria-label", "Search notes");
    askButton.title = "Search notes";
    setIcon(askButton, "arrow-right");
    askButton.disabled = true;
    const stopButton = form.createEl("button", { text: "Stop", cls: "autonatic-ask-stop" });
    stopButton.type = "button";
    stopButton.hidden = true;
    stopButton.addEventListener("click", () => this.abortController?.abort());
    const empty = contentEl.createDiv({ cls: "autonatic-ask-empty" });
    setIcon(empty.createSpan({ cls: "autonatic-empty-icon", attr: { "aria-hidden": "true" } }), "files");
    empty.createEl("h4", { text: "Find a passage" });
    empty.createEl("p", { text: "Search a keyword or ask a question. You’ll see original passages from your included folders, with a link to each note." });
    const results = contentEl.createDiv({ cls: "autonatic-ask-results" });
    results.hidden = true;
    const answer = results.createDiv({ cls: "autonatic-ask-answer" });
    const sources = results.createDiv({ cls: "autonatic-ask-sources" });
    this.unsubscribeStatus = this.plugin.askNotesSearch.subscribe((message) => {
      if (!this.asking) {
        status.setText(message);
        if (message.startsWith("Ready:") || message === "Not indexed") {
          void this.plugin.askNotesSearch.status().then((index) => {
            askButton.disabled = this.asking || !this.plugin.settings.askNotesEnabled || !this.plugin.settings.askNotesFolders.length || index.chunks === 0;
          });
        }
      }
    });

    const openSettings = () => {
      this.close();
      openPluginSettings(this.app, this.plugin.manifest.id, "search");
    };
    const showSetup = (message: string) => {
      status.setText(message);
      empty.hidden = true;
      results.hidden = false;
      const setup = answer.createEl("button", { text: "Open Ask Notes settings" });
      setup.type = "button";
      setup.addEventListener("click", openSettings);
    };

    if (!this.plugin.settings.askNotesEnabled || !this.plugin.settings.askNotesFolders.length) {
      showSetup("Choose folders and enable Ask Notes before searching.");
      input.disabled = true;
      askButton.disabled = true;
    } else {
      void this.plugin.askNotesSearch.status().then((index) => {
        status.setText(index.chunks ? `${index.notes} notes ready to search` : "Indexing has not finished yet. Check Ask Notes settings.");
        askButton.disabled = index.chunks === 0;
      }).catch((error: Error) => status.setText(error.message));
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (!question || this.asking || askButton.disabled) return;
      this.asking = true;
      this.abortController = new AbortController();
      askButton.disabled = true;
      askButton.hidden = true;
      stopButton.hidden = false;
      input.disabled = true;
      empty.hidden = true;
      form.setAttribute("aria-busy", "true");
      this.answerRenderer?.unload();
      this.answerRenderer = undefined;
      answer.empty();
      sources.empty();
      results.hidden = true;
      try {
        let shownSources: SearchChunk[] | undefined;
        const renderMatches = (matches: SearchChunk[]) => {
          if (this.closed || this.abortController?.signal.aborted) return;
          if (shownSources === matches) return;
          shownSources = matches;
          this.answerRenderer?.unload();
          this.answerRenderer = new Component();
          this.answerRenderer.load();
          sources.empty();
          answer.empty();
          results.hidden = false;
          if (!matches.length) {
            answer.createEl("p", { text: "No strong matching passages found. Try a different term or check your included folders." });
          }
          for (const source of matches) {
            const passage = sources.createEl("article", { cls: "autonatic-ask-passage" });
            const link = passage.createEl("a", { cls: "autonatic-ask-source", href: "#" });
            link.setAttribute("aria-label", `Open ${source.path}${source.heading ? `, ${source.heading}` : ""}`);
            const copy = link.createDiv({ cls: "autonatic-ask-source-copy" });
            copy.createSpan({ text: source.path.split("/").pop()?.replace(/\.md$/i, "") || source.path, cls: "autonatic-ask-source-title" });
            copy.createSpan({ text: `${source.path}${source.heading ? ` › ${source.heading}` : ""}`, cls: "autonatic-ask-source-path" });
            link.addEventListener("click", (event) => {
              event.preventDefault();
              void this.app.workspace.openLinkText(`${source.path}${source.heading ? `#${source.heading}` : ""}`, "", false);
              this.close();
            });
            const excerpt = passage.createDiv({ cls: "autonatic-ask-excerpt" });
            // Show the unmodified source immediately; Markdown rendering only formats it.
            excerpt.createEl("pre", { text: source.text, cls: "autonatic-ask-plain-excerpt" });
            const rendered = passage.createDiv({ cls: "autonatic-ask-excerpt markdown-rendered" });
            rendered.hidden = true;
            void MarkdownRenderer.render(this.app, source.text, rendered, source.path, this.answerRenderer).then(() => {
              if (this.closed || !passage.isConnected) return;
              excerpt.remove();
              rendered.hidden = false;
            }).catch(() => rendered.remove());
          }
        };
        const result = await this.plugin.askNotesSearch.ask(question,
          (message) => { if (!this.closed) status.setText(message); }, this.abortController.signal, renderMatches);
        if (this.closed) return;
        renderMatches(result.sources);
        status.setText(`${result.sources.length} matching passage${result.sources.length === 1 ? "" : "s"}`);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          status.setText("Search stopped. Edit your question or try again.");
          return;
        }
        const message = error instanceof Error ? error.message : "Ask Notes could not finish the search.";
        status.setText(message);
        new Notice(message, 6000);
      } finally {
        if (this.closed) return;
        this.asking = false;
        askButton.hidden = false;
        stopButton.hidden = true;
        input.disabled = false;
        form.setAttribute("aria-busy", "false");
        input.focus();
        this.abortController = undefined;
        void this.plugin.askNotesSearch.status().then((index) => {
          askButton.disabled = !this.plugin.settings.askNotesEnabled || index.chunks === 0;
        }).catch(() => { askButton.disabled = true; });
      }
    });
    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.plugin.workspaceNavigation.deactivate(this);
    this.closed = true;
    this.abortController?.abort();
    this.unsubscribeStatus?.();
    this.answerRenderer?.unload();
    this.contentEl.empty();
  }
}

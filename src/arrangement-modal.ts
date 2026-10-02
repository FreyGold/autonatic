import { App, Modal, Notice, TFolder } from "obsidian";
import type NemotronPlugin from "./main";
import { planVaultArrangement, type ArrangementPlan } from "./arrangement-planner";
import { isExcludedPath, parseExcludedFolders } from "./privacy-controls";

export class VaultArrangementModal extends Modal {
  private plan: ArrangementPlan | null = null;
  private controller: AbortController | null = null;

  constructor(app: App, private plugin: NemotronPlugin) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("autonatic-arrange-shell");
    const root = this.contentEl;
    root.empty();
    root.addClass("autonatic-arrange-modal");
    root.createEl("h2", { text: "Organize notes" });
    root.createEl("p", {
      text: "Describe the structure you want. Review every move before applying it. A path snapshot is saved first.",
      cls: "autonatic-arrange-intro",
    });
    if (this.plugin.arrangementError) {
      root.createEl("p", { text: this.plugin.arrangementError, cls: "autonatic-arrange-conflicts" });
      return;
    }

    const instructionLabel = root.createEl("label", { text: "How should the notes be arranged?" });
    instructionLabel.htmlFor = "autonatic-arrange-instruction";
    const instruction = root.createEl("textarea", {
      cls: "autonatic-arrange-input",
      placeholder: "Group programming notes by language, then by subject such as OS, HTTP, and security.",
    });
    instruction.id = "autonatic-arrange-instruction";
    instruction.rows = 3;

    const scopeLabel = root.createEl("label", { text: "Notes to include" });
    scopeLabel.htmlFor = "autonatic-arrange-scope";
    const scope = root.createEl("select", { cls: "autonatic-arrange-scope" });
    scope.id = "autonatic-arrange-scope";
    scope.createEl("option", { text: "Entire vault", value: "" });
    const excluded = parseExcludedFolders(this.plugin.settings.excludedFolders);
    this.app.vault.getAllLoadedFiles()
      .filter((entry): entry is TFolder => entry instanceof TFolder)
      .filter((folder) => folder.path && folder.path !== "/"
        && !folder.path.split("/").some((part) => part.startsWith("."))
        && !isExcludedPath(folder.path, excluded))
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((folder) => scope.createEl("option", { text: folder.path, value: folder.path }));
    root.createEl("p", {
      text: "Excluded folders stay untouched. Planning sends note paths, titles, and summaries to your selected generation provider.",
      cls: "autonatic-arrange-hint",
    });

    const actions = root.createDiv({ cls: "autonatic-arrange-actions" });
    const planButton = actions.createEl("button", { text: "Plan arrangement", cls: "mod-cta" });
    planButton.type = "button";
    const cancelButton = actions.createEl("button", { text: "Cancel planning" });
    cancelButton.type = "button";
    cancelButton.hidden = true;
    const status = root.createDiv({ cls: "autonatic-arrange-status" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const progress = root.createEl("progress", { cls: "autonatic-arrange-progress" });
    progress.max = 1;
    progress.hidden = true;
    const preview = root.createDiv({ cls: "autonatic-arrange-preview" });
    const snapshots = root.createDiv({ cls: "autonatic-arrange-snapshots" });

    const clearPlan = () => {
      this.plan = null;
      preview.empty();
    };
    instruction.addEventListener("input", clearPlan);
    scope.addEventListener("change", clearPlan);
    cancelButton.addEventListener("click", () => this.controller?.abort());

    const setWorking = (working: boolean) => {
      planButton.disabled = working;
      instruction.disabled = working;
      scope.disabled = working;
      cancelButton.hidden = !working;
      progress.hidden = !working;
    };

    const renderSnapshots = () => {
      snapshots.empty();
      snapshots.createEl("h3", { text: "Saved arrangements" });
      const saved = this.plugin.arrangementManager.list();
      if (!saved.length) {
        snapshots.createEl("p", { text: "No snapshots yet. One is saved before each arrangement.", cls: "autonatic-arrange-hint" });
        return;
      }
      for (const snapshot of saved) {
        const row = snapshots.createDiv({ cls: "autonatic-arrange-snapshot" });
        const details = row.createDiv();
        details.createEl("strong", { text: new Date(snapshot.createdAt).toLocaleString() });
        details.createEl("span", { text: snapshot.instruction, cls: "autonatic-arrange-snapshot-label" });
        const restoreButton = row.createEl("button", { text: "Restore" });
        restoreButton.type = "button";
        restoreButton.addEventListener("click", () => {
          row.querySelector(".autonatic-arrange-restore-confirm")?.remove();
          const confirm = row.createDiv({ cls: "autonatic-arrange-restore-confirm" });
          const changed = snapshot.entries.filter((entry) => entry.currentPath !== entry.originalPath).length;
          confirm.createEl("p", {
            text: `Move ${changed} tracked note${changed === 1 ? "" : "s"} back to their paths from this snapshot. New notes and note contents are kept.`,
          });
          if (changed) {
            const paths = confirm.createEl("details", { cls: "autonatic-arrange-restore-paths" });
            paths.createEl("summary", { text: `Review ${changed} paths` });
            const list = paths.createEl("ul");
            for (const entry of snapshot.entries) {
              if (entry.currentPath === entry.originalPath) continue;
              list.createEl("li", { text: `${entry.currentPath} → ${entry.originalPath}` });
            }
          }
          const confirmButton = confirm.createEl("button", { text: "Restore these paths", cls: "mod-cta" });
          confirmButton.type = "button";
          confirmButton.disabled = changed === 0;
          confirmButton.addEventListener("click", async () => {
            setWorking(true);
            confirmButton.disabled = true;
            try {
              const count = await this.plugin.arrangementManager.restore(snapshot.id, (done, total, stage) => {
                status.setText(`${stage}: ${done}/${total}`);
                progress.max = Math.max(1, total);
                progress.value = done;
              });
              status.setText(`Restored ${count} note path${count === 1 ? "" : "s"}.`);
              this.plugin.scheduleIndexUpdate();
              this.plugin.scheduleAskNotesUpdate();
              renderSnapshots();
              new Notice(`Restored ${count} note path${count === 1 ? "" : "s"}.`);
            } catch (error) {
              status.setText(error instanceof Error ? error.message : "Could not restore this arrangement.");
            } finally { setWorking(false); }
          });
        });
      }
    };

    const renderPreview = (plan: ArrangementPlan) => {
      preview.empty();
      preview.createEl("h3", { text: `Proposed moves (${plan.moves.length} of ${plan.totalNotes} notes)` });
      if (plan.conflicts.length) {
        const warnings = preview.createDiv({ cls: "autonatic-arrange-conflicts" });
        warnings.createEl("strong", { text: "Resolve these path conflicts before applying:" });
        for (const conflict of plan.conflicts) warnings.createEl("p", { text: conflict });
      }
      if (!plan.moves.length) {
        preview.createEl("p", { text: "The planner found no notes to move." });
        return;
      }
      const list = preview.createDiv({ cls: "autonatic-arrange-moves" });
      for (const move of plan.moves) {
        const row = list.createDiv({ cls: "autonatic-arrange-move" });
        row.createEl("span", { text: move.from });
        row.createEl("span", { text: "→", cls: "autonatic-arrange-arrow" });
        row.createEl("span", { text: move.to });
        if (move.reason) row.createEl("small", { text: move.reason });
      }
      const applyButton = preview.createEl("button", { text: `Apply ${plan.moves.length} moves`, cls: "mod-cta autonatic-arrange-apply" });
      applyButton.type = "button";
      applyButton.disabled = plan.conflicts.length > 0;
      applyButton.addEventListener("click", async () => {
        setWorking(true);
        applyButton.disabled = true;
        status.setText("Saving the current arrangement...");
        try {
          const snapshot = await this.plugin.arrangementManager.apply(plan, (done, total, stage) => {
            status.setText(`${stage}: ${done}/${total}`);
            progress.max = Math.max(1, total);
            progress.value = done;
          });
          status.setText(`Moved ${plan.moves.length} notes. Snapshot saved at ${new Date(snapshot.createdAt).toLocaleString()}.`);
          this.plugin.scheduleIndexUpdate();
          this.plugin.scheduleAskNotesUpdate();
          clearPlan();
          renderSnapshots();
          new Notice(`Moved ${plan.moves.length} notes. Arrangement snapshot saved.`);
        } catch (error) {
          status.setText(error instanceof Error ? error.message : "Could not apply the arrangement.");
          applyButton.disabled = false;
        } finally { setWorking(false); }
      });
    };

    planButton.addEventListener("click", async () => {
      clearPlan();
      setWorking(true);
      this.controller = new AbortController();
      progress.value = 0;
      status.setText("Reading note summaries...");
      try {
        const plan = await planVaultArrangement(
          this.app, this.plugin.settings, instruction.value, scope.value,
          (stage, done, total) => {
            status.setText(`${stage}${total > 1 ? `: ${done}/${total}` : ""}`);
            progress.max = Math.max(1, total);
            progress.value = done;
          },
          this.controller.signal,
        );
        this.plan = plan;
        renderPreview(plan);
        status.setText(plan.conflicts.length
          ? "The plan has path conflicts. No notes were moved."
          : `Ready to review ${plan.moves.length} proposed moves.`);
      } catch (error) {
        status.setText(error instanceof Error ? error.message : "Could not plan this arrangement.");
      } finally {
        this.controller = null;
        setWorking(false);
      }
    });

    renderSnapshots();
    instruction.focus();
  }

  onClose(): void {
    this.controller?.abort();
  }
}

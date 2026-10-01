/** A compact progress display for work with both measurable and open-ended stages. */
export class WorkflowProgress {
  private readonly root: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly progress: HTMLProgressElement;
  private readonly steps: HTMLElement[];
  private readonly labels: string[];

  constructor(parent: HTMLElement, labels: string[]) {
    this.labels = labels;
    this.root = parent.createDiv({ cls: "autonatic-workflow-progress" });
    this.root.hidden = true;
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Progress");
    this.heading = this.root.createDiv({ cls: "autonatic-workflow-progress-heading" });
    this.heading.setAttribute("role", "status");
    this.heading.setAttribute("aria-live", "polite");
    this.progress = this.root.createEl("progress", { cls: "autonatic-workflow-progress-bar" });
    const list = this.root.createEl("ol", { cls: "autonatic-workflow-progress-steps" });
    this.steps = labels.map((label) => list.createEl("li", { text: label }));
  }

  setStage(label: string, completed?: number, total?: number): void {
    const index = this.labels.indexOf(label);
    if (index < 0) throw new Error(`Unknown progress stage: ${label}`);
    this.root.hidden = false;
    const count = total !== undefined && total > 0
      ? ` · ${Math.min(completed ?? 0, total)} of ${total}` : "";
    this.heading.setText(`${label}${count} · Step ${index + 1} of ${this.labels.length}`);
    if (total !== undefined && total > 0) {
      this.progress.max = total;
      this.progress.value = Math.min(completed ?? 0, total);
    } else {
      this.progress.removeAttribute("value");
    }
    this.steps.forEach((step, position) => {
      step.classList.toggle("is-complete", position < index);
      step.classList.toggle("is-current", position === index);
      if (position === index) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  }

  finish(): void {
    this.root.hidden = false;
    this.heading.setText("Complete");
    this.progress.max = 1;
    this.progress.value = 1;
    this.steps.forEach((step) => {
      step.classList.add("is-complete");
      step.classList.remove("is-current");
      step.removeAttribute("aria-current");
    });
  }

  fail(): void {
    this.progress.removeAttribute("value");
    this.root.classList.add("has-error");
    this.heading.setText(`Stopped during ${this.labels.find((_, index) => this.steps[index].classList.contains("is-current")) || "workflow"}`);
  }

  remove(): void {
    this.root.remove();
  }
}

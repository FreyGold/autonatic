import { setIcon } from "obsidian";

/** The same foundation is applied to every workspace and native settings tab. */
export function applyDesignSystem(root: HTMLElement): void {
  root.addClass("autonatic-ui");
}

/** An outlined action row with its icon at the trailing edge, like the reference. */
export function actionDisclosure(parent: HTMLElement, label: string, icon: string, cls = ""): HTMLDetailsElement {
  const details = parent.createEl("details", { cls: `an-disclosure ${cls}`.trim() });
  const summary = details.createEl("summary", { cls: "an-action-row" });
  summary.createSpan({ text: label, cls: "an-action-row-label" });
  setIcon(summary.createSpan({ cls: "an-action-row-icon", attr: { "aria-hidden": "true" } }), icon);
  return details;
}

/** Label left, selected value right. Used for note and diagram metadata. */
export function metadataField(parent: HTMLElement, label: string, id: string, cls = ""): HTMLElement {
  const row = parent.createDiv({ cls: `an-metadata-field ${cls}`.trim() });
  row.createEl("label", { text: label, cls: "nemotron-label", attr: { id: `${id}-label`, for: id } });
  return row;
}

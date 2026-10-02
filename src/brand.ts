import { addIcon, setIcon } from "obsidian";

/** A folded note crossed by one continuous N-shaped route. */
export const AUTONATIC_MARK_ICON = "autonatic-mark";

// Obsidian custom icons use a 100 × 100 view box; the mark itself is drawn on
// the same 24 × 24 grid as the interface icon set.
const AUTONATIC_MARK_SVG = `
  <g transform="scale(4.1666667)" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7.25 3.25h6.5l3.5 3.5v14H7.25a2 2 0 0 1-2-2v-13.5a2 2 0 0 1 2-2Z" />
    <path d="M13.75 3.25v3.5h3.5" />
    <path d="M9.25 16V9.5l5.5 6.5V9.5" />
  </g>
`;

export function registerAutonaticIcons(): void {
  addIcon(AUTONATIC_MARK_ICON, AUTONATIC_MARK_SVG);
}

/** Shared lockup used in the workspace and settings. */
export function renderAutonaticBrand(parent: HTMLElement, version?: string): HTMLElement {
  const identity = parent.createDiv({ cls: "autonatic-brand" });
  const mark = identity.createSpan({ cls: "autonatic-brand-mark", attr: { "aria-hidden": "true" } });
  setIcon(mark, AUTONATIC_MARK_ICON);
  identity.createEl("h2", { text: "autonatic", cls: "autonatic-wordmark" });
  if (version) identity.createSpan({ text: `v${version}`, cls: "autonatic-version" });
  return identity;
}

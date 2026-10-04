import { addIcon, setIcon } from "obsidian";

/** A compact route-shaped A for Autonatic. */
export const AUTONATIC_MARK_ICON = "autonatic-mark";

// Obsidian custom icons use a 100 × 100 view box; the mark itself is drawn on
// the same 24 × 24 grid as the interface icon set.
const AUTONATIC_MARK_SVG = `
  <g transform="scale(4.1666667)">
    <rect x="2" y="2" width="20" height="20" rx="5.25" fill="currentColor" />
    <path d="M6.8 16.8 11.05 7.2c.38-.87 1.52-.87 1.9 0l4.25 9.6M8.65 13.35h6.7" fill="none" stroke="white" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round" />
  </g>
`;

function renderAutonaticWordmark(parent: HTMLElement): void {
  parent.createEl("h2", { text: "Autonatic", cls: "autonatic-wordmark" });
}

export function registerAutonaticIcons(): void {
  addIcon(AUTONATIC_MARK_ICON, AUTONATIC_MARK_SVG);
}

/** Shared lockup used in the workspace and settings. */
export function renderAutonaticBrand(parent: HTMLElement, version?: string): HTMLElement {
  const identity = parent.createDiv({ cls: "autonatic-brand" });
  const mark = identity.createSpan({ cls: "autonatic-brand-mark", attr: { "aria-hidden": "true" } });
  setIcon(mark, AUTONATIC_MARK_ICON);
  renderAutonaticWordmark(identity);
  if (version) identity.createSpan({ text: `v${version}`, cls: "autonatic-version" });
  return identity;
}

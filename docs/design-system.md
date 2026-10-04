# Autonatic design system

Autonatic uses the compact typography, outlined actions, and label/value rows from the supplied reference. The editor is the main surface. Options sit in a metadata inspector, and supporting actions expand in place. The same rules apply to Create, Search, Organize, placement review, and plugin settings.

## Foundations

All plugin roots receive `autonatic-ui` through `applyDesignSystem()` in `src/design-system.ts`. Tokens and component rules are scoped to that class. The palette changes with Obsidian's `theme-dark` class; it does not change the rest of the vault UI.

| Foundation | Rule |
| --- | --- |
| Typeface | Bundled Inter variable font; system sans fallback |
| Body and controls | 14px, regular (400) |
| Supporting text | 13px, regular (400) |
| Captions and version | 12px, regular (400) |
| Section labels | 16px, medium (500) |
| Page titles | 22px, semibold (600) |
| Spacing | 4, 8, 12, 16, 24, 32px |
| Controls | 40px normally; 32px for compact secondary actions |
| Corners | 6px small, 12px panels, 16px modal shell; outlined actions are pills |
| Dividers | Fine dashed rules between metadata and settings rows |
| Focus | A visible 2px blue outline, with reduced-motion support |

| Color token | Light | Dark |
| --- | --- | --- |
| `--an-paper` | `#ffffff` | `#202023` |
| `--an-paper-raised` | `#f7f7f8` | `#29292e` |
| `--an-ink` | `#242429` | `#ededf0` |
| `--an-muted` | `#72727e` | `#aaaab5` |
| `--an-rule` | `#dedee4` | `#414148` |
| `--an-border` | `#c8c8d0` | `#5c5c67` |
| `--an-brand` | `#326cee` | `#326cee` |

The primary action uses white text over a subtle blue gradient ending in `--an-brand-bottom` (`#215edb`). Secondary actions use the paper surface, a thin border, and regular text. Status colors are reserved for errors and successful operations.

Cancel uses `an-button-cancel mod-warning`: the same shape, weight, height, and finish as Create, with a red gradient from `--an-cancel` (`#cf3342`) to `--an-cancel-bottom` (`#b52634`). Paired footer actions share a 144px minimum width and shrink evenly on narrow windows.

## Shared components

### Metadata fields

Use `metadataField(parent, label, id, classes)` for compact option rows. It creates a real label associated with the control. Labels stay on the left; selected values sit on the right in muted text. Rows have dashed bottom dividers. A `CustomSelect` supplies the popup, keyboard navigation, selected indicator, and accessible name including the current value.

```ts
const row = metadataField(parent, "Style", "note-style");
new CustomSelect(row, options, initialValue, onChange, {
  controlId: "note-style",
  labelId: "note-style-label",
});
```

Text-heavy fields, including note titles and instructions, keep labels above their inputs.

### Action disclosures

Use `actionDisclosure(parent, label, icon, classes)` for optional source tools. It creates native `details` and `summary` elements, an outlined full-width action row, and a trailing icon. Content expands below it. Import conversation, Attach images, History, and Additional instructions all use this component.

The Create workspace shows Import conversation, Attach images, and Additional instructions as three separate outlined buttons in one row. Controls wrap when space is limited and stack on small windows. Opening a tool gives its form the full editor width, with a bordered panel below the button. The controls keep native disclosure keyboard behavior and visible focus.

History lives in the workspace header beside Settings. Its circular icon opens a panel with generation undo/redo and recent prompts. Escape, clicking outside, or moving focus outside closes the panel; generation disables the trigger. Empty history hides the control.

```ts
const disclosure = actionDisclosure(parent, "Attach images", "image-plus");
disclosure.createDiv({ cls: "attachment-content" });
```

### Workspace shell

Create, Search, and Organize share a compact text wordmark, a visible loaded version, navigation, page heading, and footer. Main navigation uses rounded icon tabs; the active page has a subtle border and raised surface. Note and Diagram use a connected segmented switch within Create, keeping the page and mode controls visually distinct. Create uses one editor surface beside a 288px options inspector. At a modal width of 800px or less, the inspector moves below the editor and collapses by default. A user's disclosure choice survives resizing. At 560px or less, navigation and actions stack to fit the window.

The editor has a tinted header strip for the Source label and word count, rounded to match the outer border. A fine divider joins the header to the text area below. Use `mod-cta` for the action that completes the current workflow, and keep helper actions outlined. Search results and settings sections use flat ruled rows. Placement review uses the same fields, typography, colors, and action sizes.

Settings explicitly reset Obsidian's native row backgrounds, corner radii, outer margins, and heading padding. Toggle and button-only rows size their control column to its contents, so descriptions use the available width. Check settings with the host's real CSS and active theme; isolated component defaults do not reproduce native setting cards.

Native `select.dropdown` controls use one down chevron from `--an-select-arrow`, with explicit size, position, no-repeat, and reserved text padding. Field surfaces set `background-color` rather than resetting the background shorthand. Preview native dropdown classes as well as their host stylesheet to catch image tiling and fitted-width overrides.

Folder pickers include a compact New folder action. A missing typed path shows an inline status and Create folder action; Enter opens the same confirmation. The dialog uses the shared controls and palette, validates the complete path before writing, and selects the created folder. Cancelling the dialog creates no folders.

## Source and build

| File | Responsibility |
| --- | --- |
| `src/ui/tokens.css` | Font, palette, type scale, spacing, dimensions, shadows |
| `src/ui/foundation.css` | Scoped native controls, focus, reading text, reduced motion |
| `src/ui/components.css` | Metadata rows, action disclosures, selects, folders, attachments, status |
| `src/ui/workspaces.css` | Create, Search, Organize, navigation, responsive modal layout |
| `src/ui/settings.css` | Settings rows, provider sections, tabs, responsive controls |
| `src/ui/placement.css` | Placement review and destination tree |

`src/ui/styles.css` imports the modules. The existing esbuild configuration compiles them into the release's `styles.css`, embeds the Inter font as a data URL, and includes its OFL license. Never edit generated `styles.css` directly. Development watches both JavaScript and CSS; CI checks that both generated artifacts match their sources.

For a visual change, inspect light and dark Create, expanded source tools, narrow windows, settings, and the affected secondary workflow. Check dropdown clipping, keyboard focus, and horizontal overflow alongside the project's typecheck and tests. The installed manifest and the workspace header should show the same release version.

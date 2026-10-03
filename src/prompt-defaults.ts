import { createHash } from "crypto";
import { CONCISE_OBSIDIAN_SKILL_PROMPT, DETAILED_OBSIDIAN_SKILL_PROMPT } from "./prompts";

// Exact fingerprints of the defaults shipped before the source-fidelity update.
// Comparing the complete text preserves even small user customizations.
const LEGACY_DEFAULTS = [
  {
    key: "systemPrompt",
    hash: "adeef166712d603b8adfcf8e1b38f6f545d80ab555b6fb79fc495c8ee31a903c",
    replacement: CONCISE_OBSIDIAN_SKILL_PROMPT,
  },
  {
    key: "detailedPrompt",
    hash: "3741c4bdecf9aa2fef7df9bb36e890d46e99f4773efc61079654a8635b4ca806",
    replacement: DETAILED_OBSIDIAN_SKILL_PROMPT,
  },
] as const;

export function migrateDefaultNotePrompts(settings: { systemPrompt: string; detailedPrompt: string }): boolean {
  let changed = false;
  for (const { key, hash, replacement } of LEGACY_DEFAULTS) {
    if (typeof settings[key] !== "string") continue;
    if (createHash("sha256").update(settings[key]).digest("hex") !== hash) continue;
    settings[key] = replacement;
    changed = true;
  }
  return changed;
}

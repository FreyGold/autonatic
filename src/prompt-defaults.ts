import { createHash } from "crypto";
import { CONCISE_OBSIDIAN_SKILL_PROMPT, DETAILED_OBSIDIAN_SKILL_PROMPT } from "./prompts";

// Exact fingerprints of defaults shipped before the source-fidelity and STE updates.
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
  {
    key: "systemPrompt",
    hash: "8f70a91bb6589fa10d41f979e4eb950fb9da4189621893a992edde85ea2c3afc",
    replacement: CONCISE_OBSIDIAN_SKILL_PROMPT,
  },
  {
    key: "detailedPrompt",
    hash: "7b431dc865eea66f6f604d70199ccf88a3c21daa32fd608a315364c1bf39031f",
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

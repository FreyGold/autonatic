import type { SelectOption } from "./custom-select";

export type DestinationMode = "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append";

export const DESTINATION_MODE_OPTIONS: ReadonlyArray<SelectOption & { value: DestinationMode }> = [
  {
    value: "smart",
    label: "One note — autonatic chooses location",
    description: "Create one note and let autonatic find a matching note or suitable location.",
  },
  {
    value: "multi_note",
    label: "Several focused notes — autonatic chooses locations",
    description: "Split the source into focused notes and let autonatic organize or update them.",
  },
  {
    value: "multi_note_folder",
    label: "Several notes — selected folder",
    description: "Split the source into new notes in one exact folder.",
  },
  {
    value: "new_file",
    label: "One note — selected folder",
    description: "Create one new note in an exact folder.",
  },
  {
    value: "append",
    label: "Add to active note",
    description: "Add generated content to the note currently open in Obsidian.",
  },
];

export function supportsPlacementFolderScope(mode: DestinationMode): boolean {
  return mode === "smart" || mode === "multi_note";
}

export function destinationModeLabel(mode: DestinationMode): string {
  return DESTINATION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

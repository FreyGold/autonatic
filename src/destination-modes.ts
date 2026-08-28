import type { SelectOption } from "./custom-select";

export type DestinationMode = "smart" | "multi_note" | "multi_note_folder" | "new_file" | "append";

export const DESTINATION_MODE_OPTIONS: ReadonlyArray<SelectOption & { value: DestinationMode }> = [
  {
    value: "smart",
    label: "Smart Placement (Create or Append)",
    description: "AI analyzes your vault hierarchy and places the generated note in the best folder or existing note.",
  },
  {
    value: "multi_note",
    label: "Atomic Decomposition (Multi-Note)",
    description: "Splits input into distinct atomic notes, then creates or appends each note in a relevant location.",
  },
  {
    value: "multi_note_folder",
    label: "Create Multiple Notes in Folder",
    description: "Splits the input into separate new notes and saves every note in one selected folder.",
  },
  {
    value: "new_file",
    label: "Create New Note File",
    description: "Lets you select a destination folder and title for a new note file.",
  },
  {
    value: "append",
    label: "Append to Active Note",
    description: "Adds the generated content to the active note.",
  },
];

export function supportsPlacementFolderScope(mode: DestinationMode): boolean {
  return mode === "smart" || mode === "multi_note";
}

export function destinationModeLabel(mode: DestinationMode): string {
  return DESTINATION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

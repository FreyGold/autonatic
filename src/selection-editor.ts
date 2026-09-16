import type { Editor, EditorPosition } from "obsidian";

export interface CapturedSelection {
  text: string;
  from: EditorPosition;
  to: EditorPosition;
  document: string;
}

export function captureEditorSelection(editor: Editor): CapturedSelection | null {
  const text = editor.getSelection();
  if (!text.trim()) return null;
  return {
    text,
    from: { ...editor.getCursor("from") },
    to: { ...editor.getCursor("to") },
    document: editor.getValue(),
  };
}

export function replaceCapturedSelection(editor: Editor, captured: CapturedSelection, replacement: string): string {
  if (editor.getValue() !== captured.document || editor.getRange(captured.from, captured.to) !== captured.text) {
    throw new Error("The note changed during generation. No text was replaced.");
  }
  editor.replaceRange(replacement, captured.from, captured.to, "nemotron-selection-edit");
  return editor.getValue();
}

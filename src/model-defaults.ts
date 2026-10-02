export const DEFAULT_TEXT_MODEL = "";

export function resolveTextModel(savedModel?: string): string {
  return savedModel || DEFAULT_TEXT_MODEL;
}

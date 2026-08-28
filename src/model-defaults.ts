export const DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const PREVIOUS_DEFAULT_TEXT_MODELS = new Set([
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
]);

export function resolveTextModel(savedModel?: string): string {
  if (!savedModel || PREVIOUS_DEFAULT_TEXT_MODELS.has(savedModel)) {
    return DEFAULT_TEXT_MODEL;
  }

  return savedModel;
}

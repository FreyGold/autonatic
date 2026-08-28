export const DEFAULT_TEXT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const PREVIOUS_DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

export function resolveTextModel(savedModel?: string): string {
  if (!savedModel || savedModel === PREVIOUS_DEFAULT_TEXT_MODEL) {
    return DEFAULT_TEXT_MODEL;
  }

  return savedModel;
}

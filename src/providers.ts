import type { NemotronPluginSettings } from "./settings";
import { requestUrl } from "obsidian";

export type AIProvider = "nvidia" | "openai" | "gemini" | "anthropic" | "groq" | "openrouter";

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  embeddingModel: string;
  availableModels: string[];
  availableEmbeddingModels: string[];
}

export const PROVIDERS: Record<AIProvider, { label: string; baseUrl: string; keyUrl: string }> = {
  nvidia: { label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com" },
  openai: { label: "OpenAI (ChatGPT)", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyUrl: "https://aistudio.google.com/app/apikey" },
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
};

export const EMBEDDING_PROVIDERS: AIProvider[] = ["nvidia", "openai", "gemini", "openrouter"];

export function defaultProviderConfigs(): Record<AIProvider, ProviderConfig> {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([key, provider]) => [key, {
    apiKey: "", baseUrl: provider.baseUrl, model: "", embeddingModel: "",
    availableModels: [], availableEmbeddingModels: [],
  }])) as unknown as Record<AIProvider, ProviderConfig>;
}

export function getProviderConfig(settings: NemotronPluginSettings, provider: AIProvider): ProviderConfig {
  const defaults = PROVIDERS[provider];
  const saved = settings.providers?.[provider];
  const legacyNvidia = provider === "nvidia";
  return {
    apiKey: saved?.apiKey || (legacyNvidia ? settings.apiKey : ""),
    baseUrl: saved?.baseUrl || (legacyNvidia && settings.baseUrl) || defaults.baseUrl,
    model: saved?.model || (legacyNvidia && settings.model) || "",
    embeddingModel: saved?.embeddingModel || "",
    availableModels: saved?.availableModels || [],
    availableEmbeddingModels: saved?.availableEmbeddingModels || [],
  };
}

export function getGenerationConfig(settings: NemotronPluginSettings): ProviderConfig & { provider: AIProvider } {
  const provider = settings.generationProvider || "nvidia";
  return { ...getProviderConfig(settings, provider), provider };
}

export function getEmbeddingConfig(settings: NemotronPluginSettings): ProviderConfig & { provider: AIProvider } {
  const provider = settings.embeddingProvider || "nvidia";
  return { ...getProviderConfig(settings, provider), provider };
}

export function getGenerationApiKey(settings: NemotronPluginSettings): string {
  return getGenerationConfig(settings).apiKey;
}

export async function fetchProviderModels(
  provider: AIProvider,
  baseUrl: string,
  apiKey: string,
): Promise<{ chat: string[]; embeddings: string[] }> {
  const headers: Record<string, string> = {};
  if (provider === "gemini") headers["x-goog-api-key"] = apiKey;
  else if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.Authorization = `Bearer ${apiKey}`;

  const base = baseUrl.replace(/\/+$/, "");
  const allModels: any[] = [];
  let cursor = "";
  let firstResponse: any;
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${base}/models`);
    if (provider === "gemini" && cursor) url.searchParams.set("pageToken", cursor);
    if (provider === "anthropic") {
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
    }
    const response = await requestUrl({ url: url.toString(), method: "GET", headers, throw: false });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${PROVIDERS[provider].label} rejected the key or model-list request (${response.status}): ${response.text}`);
    }
    firstResponse ||= response.json;
    const batch: any[] = Array.isArray(response.json?.data) ? response.json.data
      : Array.isArray(response.json?.models) ? response.json.models : [];
    allModels.push(...batch);
    if (provider === "gemini" && response.json?.nextPageToken) cursor = response.json.nextPageToken;
    else if (provider === "anthropic" && response.json?.has_more && batch.length) cursor = batch[batch.length - 1].id;
    else break;
  }
  const getId = (model: any): string => String(model.id || model.name || "").replace(/^models\//, "");
  const records = allModels.filter((model) => getId(model));
  let chat = records.filter((model) => {
    const id = getId(model).toLowerCase();
    if (provider === "gemini" && Array.isArray(model.supportedGenerationMethods)) {
      return model.supportedGenerationMethods.includes("generateContent");
    }
    if (provider === "openrouter" && Array.isArray(model.architecture?.output_modalities)) {
      return model.architecture.output_modalities.includes("text");
    }
    if (provider === "openai" && model.owned_by === "openai" && /^(text-embedding|embedding)/i.test(id)) return false;
    if (provider === "groq" && model.active === false) return false;
    return !/(embedding|embed|rerank|whisper|transcri|speech|audio|tts|image|dall-e|moderation|realtime)/i.test(id);
  }).map(getId);

  let embeddings = records.filter((model) => {
    const id = getId(model).toLowerCase();
    if (provider === "gemini" && Array.isArray(model.supportedGenerationMethods)) {
      return model.supportedGenerationMethods.some((method: string) => /embedcontent/i.test(method));
    }
    if (provider === "openrouter" && Array.isArray(model.architecture?.output_modalities)) {
      return model.architecture.output_modalities.includes("embeddings");
    }
    return /embedding|embed/i.test(id) && !/rerank/i.test(id);
  }).map(getId);

  if (provider === "openrouter") {
    const embeddingResponse = await requestUrl({ url: `${base}/embeddings/models`, method: "GET", headers, throw: false });
    if (embeddingResponse.status >= 200 && embeddingResponse.status < 300) {
      const models: any[] = Array.isArray(embeddingResponse.json?.data) ? embeddingResponse.json.data : [];
      embeddings = models.map(getId).filter(Boolean);
    }
  }

  chat = [...new Set(chat)].sort((a, b) => a.localeCompare(b));
  embeddings = [...new Set(embeddings)].sort((a, b) => a.localeCompare(b));
  if (!chat.length && allModels.length === 0 && firstResponse) {
    throw new Error(`${PROVIDERS[provider].label} accepted the key but returned no model records.`);
  }
  if (!chat.length) throw new Error(`${PROVIDERS[provider].label} accepted the key but did not return any chat models.`);
  return { chat, embeddings };
}

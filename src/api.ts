import { requestUrl } from "obsidian";
import { NemotronPluginSettings } from "./settings";
import * as https from "https";
import * as http from "http";
import { StringDecoder } from "string_decoder";
import { BARE_OBSIDIAN_SKILL_PROMPT, type NoteStyle } from "./prompts";
import { getGenerationConfig } from "./providers";

export interface StreamCallbacks {
  onReasoning?: (reasoningChunk: string) => void;
  onContent?: (contentChunk: string) => void;
  onStatus?: (status: string) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
}

const MERMAID_DELIMITERS: Record<string, string> = { "[": "]", "{": "}", "(": ")" };

function encodeMermaidLabel(value: string): string {
  return value
    .trim()
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/\(/g, "#40;")
    .replace(/\)/g, "#41;");
}

function findMermaidNodeEnd(line: string, openerIndex: number): number {
  const opener = line[openerIndex];
  const closer = MERMAID_DELIMITERS[opener];
  let contentStart = openerIndex + 1;
  while (line[contentStart] === " ") contentStart++;

  if (line[contentStart] === '"') {
    for (let index = contentStart + 1; index < line.length - 1; index++) {
      if (line[index] === '"' && line[index + 1] === closer) return index + 1;
    }
    return -1;
  }

  let depth = 1;
  for (let index = openerIndex + 1; index < line.length; index++) {
    if (line[index] === opener) depth++;
    if (line[index] === closer) depth--;
    if (depth === 0) return index;
  }
  return -1;
}

function sanitizeMermaidNodes(line: string): string {
  const nodeStart = /(^|[\s;>|])([a-zA-Z0-9_-]+)\s*([\[\{\(])/g;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = nodeStart.exec(line)) !== null) {
    const prefix = match[1];
    const id = match[2];
    const opener = match[3];
    const openerIndex = nodeStart.lastIndex - 1;
    const endIndex = findMermaidNodeEnd(line, openerIndex);
    if (endIndex < 0) continue;

    let inner = line.slice(openerIndex + 1, endIndex).trim();
    if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
      inner = inner.slice(1, -1);
    }
    const closer = MERMAID_DELIMITERS[opener];
    result += line.slice(cursor, match.index) + prefix + id + opener + '"' + encodeMermaidLabel(inner) + '"' + closer;
    cursor = endIndex + 1;
    nodeStart.lastIndex = cursor;
  }

  return result + line.slice(cursor);
}

/**
 * Bulletproof Mermaid diagram sanitizer:
 * 1. Converts legacy arrow syntax (e.g. "A -- Yes --> B") into standard Mermaid ("A -->|\"Yes\"| B")
 * 2. Enforces quoted labels on pipe arrows (e.g. "A -->|Yes| B" -> "A -->|\"Yes\"| B")
 * 3. Sanitizes nested double quotes inside node labels to HTML entity `#quot;`
 * 4. Ensures every node label is properly wrapped in double quotes
 */
export function sanitizeMermaidDiagrams(markdown: string): string {
  return markdown.replace(/```mermaid([\s\S]*?)```/g, (match, mermaidBody: string) => {
    const lines = mermaidBody.split("\n");
    const sanitizedLines = lines.map((line) => {
      let trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith("%%") ||
        trimmed.startsWith("flowchart") ||
        trimmed.startsWith("graph") ||
        trimmed.startsWith("sequenceDiagram") ||
        trimmed.startsWith("classDiagram") ||
        trimmed.startsWith("stateDiagram") ||
        trimmed.startsWith("erDiagram") ||
        trimmed.startsWith("subgraph") ||
        trimmed === "end"
      ) {
        return line;
      }

      // 1. Convert old arrow syntax: -- "label" --> or -- label --> to -->|"label"|
      line = line.replace(/--\s*([^->]+?)\s*-->/g, (m, label) => {
        let clean = label.trim().replace(/^["'\\]+|["'\\]+$/g, "").replace(/"/g, "#quot;");
        return `-->|"${clean}"|`;
      });

      // 2. Ensure pipe arrows have quotes: -->|label| -> -->|"label"|
      line = line.replace(/(-->|-\.->|==>)\s*\|([^|]+)\|\s*/g, (m, arrow, label) => {
        let clean = label.trim().replace(/^["'\\]+|["'\\]+$/g, "").replace(/"/g, "#quot;");
        return `${arrow}|"${clean}"| `;
      });

      // 3. Parse complete node labels before encoding syntax characters.
      line = sanitizeMermaidNodes(line);

      return line;
    });

    return `\`\`\`mermaid\n${sanitizedLines.join("\n")}\n\`\`\``;
  });
}

/**
 * Multimodal OCR Extraction using Vision Model
 */
export async function extractContentFromImage(
  settings: NemotronPluginSettings,
  dataUrl: string,
  imageIndex: number = 0,
  totalImages: number = 1,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<string> {
  const visionPrompt =
    "Transcribe and describe in high detail all visible text, headers, diagrams, tables, handwritten notes, UI layouts, and code snippets from this image. Structure it cleanly so it can be transformed into an Obsidian note.";

  callbacks?.onStatus?.(
    totalImages > 1
      ? `Analyzing attached image ${imageIndex + 1} of ${totalImages}...`
      : "Analyzing attached image / screenshot..."
  );

  const config = getGenerationConfig(settings);
  const [meta, encoded] = dataUrl.split(",", 2);
  const mimeType = /data:([^;]+)/.exec(meta)?.[1] || "image/png";
  const model = config.model;
  const body: Record<string, any> = { model, max_tokens: 4096, temperature: 0.2 };
  let url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
  if (config.provider === "anthropic") {
    url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    delete headers.Authorization;
    body.messages = [{ role: "user", content: [{ type: "text", text: visionPrompt },
      { type: "image", source: { type: "base64", media_type: mimeType, data: encoded } }] }];
  } else if (config.provider === "gemini") {
    url = `${config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
    body.contents = [{ role: "user", parts: [{ text: visionPrompt }, { inlineData: { mimeType, data: encoded } }] }];
    body.generationConfig = { maxOutputTokens: 4096, temperature: 0.2 };
    delete body.model;
    delete body.max_tokens;
    delete body.temperature;
    delete headers.Authorization;
    headers["x-goog-api-key"] = config.apiKey;
  } else {
    body.messages = [{ role: "user", content: [{ type: "text", text: visionPrompt }, { type: "image_url", image_url: { url: dataUrl } }] }];
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const response = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (response.status < 200 || response.status >= 300) throw new Error(`Vision API error (${response.status}): ${response.text}`);
  const data = response.json;
  if (config.provider === "anthropic") return (data.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("");
  if (config.provider === "gemini") return (data.candidates?.[0]?.content?.parts || []).map((item: any) => item.text || "").join("");
  return typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
}

/**
 * Main note generation pipeline
 */
export async function generateNemotronNote(
  settings: NemotronPluginSettings,
  userPrompt: string,
  imageDataUrls?: string[],
  noteStyle: NoteStyle = "concise",
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  if (!getGenerationConfig(settings).apiKey.trim()) {
    throw new Error("The selected generation provider's API key is missing. Add it in Obsidian Settings > autonatic > AI providers.");
  }
  const generationConfig = getGenerationConfig(settings);
  if (!generationConfig.model.trim()) {
    throw new Error("Fetch models for the selected generation provider in settings and choose a chat model first.");
  }
  const storedProvider = settings.providers?.[generationConfig.provider];
  if (storedProvider && !storedProvider.availableModels.includes(generationConfig.model)) {
    throw new Error("Fetch the selected generation provider's models in settings, then choose an available chat model.");
  }

  let combinedPrompt = userPrompt;

  // Extract from images if attached
  if (imageDataUrls && imageDataUrls.length > 0) {
    const extractions: string[] = [];
    for (let i = 0; i < imageDataUrls.length; i++) {
      const text = await extractContentFromImage(
        settings,
        imageDataUrls[i],
        i,
        imageDataUrls.length,
        callbacks,
        signal
      );
      if (text.trim()) {
        extractions.push(`[Image ${i + 1} Content]:\n${text}`);
      }
    }

    if (extractions.length > 0) {
      combinedPrompt = `${userPrompt}\n\n=== EXTRACTED IMAGE / SCREENSHOT CONTENT ===\n${extractions.join("\n\n")}\n===========================================`;
    }
  }

  // Choose system prompt based on note style
  const systemPrompt =
    noteStyle === "bare"
      ? BARE_OBSIDIAN_SKILL_PROMPT
      : noteStyle === "detailed"
      ? (settings.detailedPrompt || settings.systemPrompt)
      : settings.systemPrompt;

  return streamChatCompletion(settings, systemPrompt, combinedPrompt, callbacks, signal);
}

/**
 * Streaming chat completion using Node's https/http module with real-time reasoning & content callbacks
 */
export async function streamChatCompletion(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  const config = getGenerationConfig(settings);
  if (!config.model.trim()) throw new Error("Fetch models for the selected generation provider in settings and choose a chat model first.");
  const storedProvider = settings.providers?.[config.provider];
  if (storedProvider && !storedProvider.availableModels.includes(config.model)) {
    throw new Error("Fetch the selected generation provider's models in settings, then choose an available chat model.");
  }
  if (config.provider === "anthropic" || config.provider === "gemini") {
    return generateWithProviderRequestUrl(settings, systemPrompt, userPrompt, callbacks, signal);
  }
  return streamWithTimeoutRetry({ ...settings, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model,
    provider: config.provider } as NemotronPluginSettings, systemPrompt, userPrompt, callbacks, signal);
}

async function generateWithProviderRequestUrl(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const config = getGenerationConfig(settings);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  callbacks?.onStatus?.(`Calling ${config.provider === "anthropic" ? "Claude" : "Gemini"}...`);
  let url: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, any>;
  if (config.provider === "anthropic") {
    url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = { model: config.model, max_tokens: settings.maxTokens, temperature: settings.temperature,
      system: systemPrompt, messages: [{ role: "user", content: userPrompt }] };
  } else {
    url = `${config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers["x-goog-api-key"] = config.apiKey;
    body = { systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: settings.temperature, topP: settings.topP, maxOutputTokens: settings.maxTokens } };
  }
  const response = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${config.provider === "anthropic" ? "Claude" : "Gemini"} API error (${response.status}): ${response.text}`);
  }
  const data = response.json;
  const content = config.provider === "anthropic"
    ? (data.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("")
    : (data.candidates?.[0]?.content?.parts || []).map((item: any) => item.text || "").join("");
  if (!content) throw new Error("The provider returned an empty response.");
  callbacks?.onContent?.(content);
  return { content: sanitizeMermaidDiagrams(content.trim()), reasoning: "" };
}

async function streamWithTimeoutRetry(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamChatCompletionAttempt(settings, systemPrompt, userPrompt, callbacks, signal);
    } catch (error) {
      const retryStatus = getRetryStatus(error);
      const overloaded = isRetryableOverload(error);
      const retries = overloaded ? 2 : 1;
      if (!retryStatus || signal?.aborted || attempt >= retries) throw error;
      const delay = overloaded ? 2_000 * (2 ** attempt) : 0;
      callbacks?.onStatus?.(overloaded
        ? `Provider is busy. Retrying in ${delay / 1000} seconds (${attempt + 1} of ${retries})…`
        : retryStatus);
      if (delay) await waitForRetry(delay, signal);
    }
  }
}

type NvidiaApiError = Error & {
  statusCode: number;
  responseBody: string;
};

function createProviderApiError(statusCode: number, responseBody: string): NvidiaApiError {
  let detail = responseBody.trim();
  try {
    const parsed = JSON.parse(responseBody);
    if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.detail) detail = String(parsed.detail);
  } catch {}

  if (!detail) detail = "The requested model endpoint is unavailable.";
  return Object.assign(new Error(`Provider API error (${statusCode}): ${detail}`), {
    statusCode,
    responseBody,
  });
}

function isRetryableTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const networkError = error as Error & { code?: string; receivedResponseData?: boolean };
  return networkError.code === "ETIMEDOUT" && !networkError.receivedResponseData;
}

function isRetryableDegradedFunction(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const apiError = error as Partial<NvidiaApiError>;
  if (apiError.statusCode !== 400) return false;

  const providerMessage = `${error.message}\n${apiError.responseBody || ""}`;
  return /\bDEGRADED\b[\s\S]*\bcannot be invoked\b/i.test(providerMessage);
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableOverload(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const providerError = error as Partial<NvidiaApiError> & { receivedModelOutput?: boolean };
  if (providerError.receivedModelOutput) return false;
  return [429, 502, 503, 504].includes(providerError.statusCode || 0)
    || (providerError.responseBody !== undefined
      && /temporarily overloaded|service unavailable|too many requests/i.test(providerError.responseBody));
}

function getRetryStatus(error: unknown): string | null {
  if ((error as { receivedModelOutput?: boolean } | null)?.receivedModelOutput) return null;
  if (isRetryableOverload(error)) return "The provider is temporarily overloaded.";
  if (isRetryableTimeout(error)) {
    return "Provider connection timed out. Retrying once...";
  }
  if (isRetryableDegradedFunction(error)) {
    return "Provider is temporarily degraded. Retrying the same model once...";
  }
  return null;
}

function streamChatCompletionAttempt(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  const isNodeAvailable = typeof https !== "undefined" && typeof https.request === "function";

  if (!isNodeAvailable) {
    return generateWithObsidianRequestUrl(settings, systemPrompt, userPrompt, callbacks);
  }

  return new Promise((resolve, reject) => {
    let req: http.ClientRequest | undefined;
    let settled = false;
    let receivedResponseData = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let fullContent = "";
    let fullReasoning = "";
    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      Object.assign(error, { receivedResponseData, receivedModelOutput: !!(fullContent || fullReasoning) });
      reject(error);
      req?.destroy();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ content: sanitizeMermaidDiagrams(fullContent.trim()), reasoning: fullReasoning.trim() });
      // SSE completion is authoritative even if the server keeps its HTTP body open.
      req?.destroy();
    };
    const onAbort = () => fail(new DOMException("Aborted", "AbortError"));
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(Object.assign(
        new Error("The provider stopped responding for 3 minutes. Try again; the request was stopped."),
        { code: "ETIMEDOUT" },
      )), 180_000);
    };

    if (signal?.aborted) { onAbort(); return; }
    try {
      const urlObj = new URL(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`);
      const requestBody: Record<string, any> = {
        model: settings.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: settings.temperature,
        top_p: settings.topP,
        max_tokens: settings.maxTokens,
        stream: true,
      };
      if ((settings as NemotronPluginSettings & { provider?: string }).provider === "nvidia") {
        requestBody.chat_template_kwargs = { enable_thinking: settings.enableThinking };
      }
      const postData = JSON.stringify(requestBody);
      callbacks?.onStatus?.("Waiting for provider...");
      const requestFn = urlObj.protocol === "https:" ? https.request : http.request;
      req = requestFn(urlObj, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Length": Buffer.byteLength(postData),
        },
      }, (res) => {
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("The provider closed the response before it finished. Try again.")));
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBody = "";
          res.on("data", (chunk) => { if (!settled) { resetIdleTimer(); errBody += chunk.toString(); } });
          res.on("end", () => fail(createProviderApiError(res.statusCode || 500, errBody)));
          return;
        }

        const decoder = new StringDecoder("utf8");
        let buffer = "";
        let isReasoningPhase = true;
        callbacks?.onStatus?.("Receiving provider response...");
        const consumeDelta = (delta: { reasoning_content?: string; content?: string }) => {
                // 1. Direct reasoning_content field (NVIDIA NIM standard)
                if (delta.reasoning_content) {
                  fullReasoning += delta.reasoning_content;
                  callbacks?.onReasoning?.(delta.reasoning_content);
                }

                // 2. Regular content chunks (with embedded <think> tag handling)
                if (delta.content) {
                  const chunkStr = delta.content;

                  if (isReasoningPhase) {
                    if (chunkStr.includes("<think>")) {
                      const afterThink = chunkStr.split("<think>")[1] || "";
                      if (afterThink.includes("</think>")) {
                        const [thought, realContent] = afterThink.split("</think>");
                        fullReasoning += thought;
                        callbacks?.onReasoning?.(thought);
                        isReasoningPhase = false;
                        if (realContent) {
                          fullContent += realContent;
                          callbacks?.onContent?.(realContent);
                        }
                      } else {
                        fullReasoning += afterThink;
                        callbacks?.onReasoning?.(afterThink);
                      }
                      return;
                    }

                    if (chunkStr.includes("</think>")) {
                      const [thought, realContent] = chunkStr.split("</think>");
                      fullReasoning += thought;
                      callbacks?.onReasoning?.(thought);
                      isReasoningPhase = false;
                      if (realContent) {
                        fullContent += realContent;
                        callbacks?.onContent?.(realContent);
                      }
                      return;
                    }

                    fullContent += chunkStr;
                    callbacks?.onContent?.(chunkStr);
                  } else {
                    fullContent += chunkStr;
                    callbacks?.onContent?.(chunkStr);
                  }
                }
        };
        const consumeLine = (line: string) => {
          if (settled) return;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") { finish(); return; }
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { return; }
          if (parsed.error) {
            fail(createProviderApiError(Number(parsed.error.status || parsed.error.code) || 500, JSON.stringify(parsed)));
            return;
          }
          const choice = parsed.choices?.[0];
          if (choice?.delta) consumeDelta(choice.delta);
          if (choice?.finish_reason === "length") {
            fail(new Error("The provider reached the token limit before finishing. Use a shorter source or increase the generation token limit."));
          } else if (choice?.finish_reason === "content_filter") {
            fail(new Error("The provider filtered the response before finishing."));
          } else if (choice?.finish_reason) {
            finish();
          }
        };
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          receivedResponseData = true;
          resetIdleTimer();
          buffer += decoder.write(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) consumeLine(line);
        });
        res.on("end", () => {
          if (settled) return;
          consumeLine(buffer + decoder.end());
          finish();
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", fail);
      resetIdleTimer();
      deadlineTimer = setTimeout(() => fail(new Error("The provider exceeded the 15-minute request limit. Try a shorter source.")), 900_000);
      req.write(postData);
      req.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Fallback generation using Obsidian's built-in requestUrl (no streaming)
 */
async function generateWithObsidianRequestUrl(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks
): Promise<StreamResult> {
  callbacks?.onStatus?.("Calling provider API...");

  const requestBody: Record<string, any> = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
  };

  const response = await requestUrl({
    url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (response.status < 200 || response.status >= 300) {
    throw createProviderApiError(response.status, response.text);
  }

  const data = response.json;
  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";

  callbacks?.onContent?.(content);
  if (reasoning) {
    callbacks?.onReasoning?.(reasoning);
  }

  const sanitizedContent = sanitizeMermaidDiagrams(content.trim());
  return {
    content: sanitizedContent,
    reasoning: reasoning.trim(),
  };
}

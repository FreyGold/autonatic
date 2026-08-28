import { requestUrl } from "obsidian";
import { NemotronPluginSettings } from "./settings";
import * as https from "https";
import * as http from "http";

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

  const requestBody = {
    model: settings.visionModel || "meta/llama-3.2-11b-vision-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: visionPrompt },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const urlStr = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const urlObj = new URL(urlStr);
  const postData = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    try {
      const isHttps = urlObj.protocol === "https:";
      const requestFn = isHttps ? https.request : http.request;

      const req = requestFn(
        urlObj,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });

          res.on("end", () => {
            try {
              if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                reject(new Error(`Vision API error (${res.statusCode}): ${body}`));
                return;
              }
              const parsed = JSON.parse(body);
              const text = parsed.choices?.[0]?.message?.content || "";
              resolve(text);
            } catch (err: any) {
              reject(new Error(`Failed to parse Vision response: ${err.message}`));
            }
          });
        }
      );

      if (signal) {
        signal.addEventListener("abort", () => {
          req.destroy(new DOMException("Aborted", "AbortError"));
          reject(new DOMException("Aborted", "AbortError"));
        });
      }

      req.on("error", (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Main note generation pipeline
 */
export async function generateNemotronNote(
  settings: NemotronPluginSettings,
  userPrompt: string,
  imageDataUrls?: string[],
  noteStyle: "concise" | "detailed" = "concise",
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  if (!settings.apiKey || !settings.apiKey.trim()) {
    throw new Error("NVIDIA API key is missing. Please enter your API key in Obsidian Settings > Nemotron Note Crafter.");
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
    noteStyle === "detailed"
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
  try {
    return await streamChatCompletionAttempt(settings, systemPrompt, userPrompt, callbacks, signal);
  } catch (error) {
    if (!isRetryableTimeout(error) || signal?.aborted) {
      throw error;
    }

    callbacks?.onStatus?.("NVIDIA connection timed out. Retrying once...");
    return streamChatCompletionAttempt(settings, systemPrompt, userPrompt, callbacks, signal);
  }
}

function isRetryableTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const networkError = error as Error & { code?: string; receivedResponseData?: boolean };
  return networkError.code === "ETIMEDOUT" && !networkError.receivedResponseData;
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
    try {
      const urlStr = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const urlObj = new URL(urlStr);

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

      if (settings.enableThinking) {
        requestBody.chat_template_kwargs = { enable_thinking: true };
      }

      const postData = JSON.stringify(requestBody);
      callbacks?.onStatus?.("Structuring notes with Nemotron reasoning...");

      const isHttps = urlObj.protocol === "https:";
      const requestFn = isHttps ? https.request : http.request;

      const req = requestFn(
        urlObj,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let errBody = "";
            res.on("data", (chunk) => {
              errBody += chunk.toString();
            });
            res.on("end", () => {
              let msg = `NVIDIA API error (${res.statusCode}): ${errBody}`;
              try {
                const parsed = JSON.parse(errBody);
                if (parsed.error?.message) {
                  msg = `NVIDIA API error (${res.statusCode}): ${parsed.error.message}`;
                }
              } catch {}
              reject(new Error(msg));
            });
            return;
          }

          let fullContent = "";
          let fullReasoning = "";
          let buffer = "";
          let isReasoningPhase = true;
          let receivedResponseData = false;

          callbacks?.onStatus?.("Nemotron thinking and formatting...");

          res.on("data", (chunk: Buffer) => {
            receivedResponseData = true;
            buffer += chunk.toString("utf-8");
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const dataStr = trimmed.slice(6);
              if (dataStr === "[DONE]") continue;

              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

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
                      continue;
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
                      continue;
                    }

                    fullContent += chunkStr;
                    callbacks?.onContent?.(chunkStr);
                  } else {
                    fullContent += chunkStr;
                    callbacks?.onContent?.(chunkStr);
                  }
                }
              } catch {}
            }
          });

          res.on("end", () => {
            // Sanitize Mermaid diagrams inside content before resolving
            const sanitizedContent = sanitizeMermaidDiagrams(fullContent.trim());
            resolve({
              content: sanitizedContent,
              reasoning: fullReasoning.trim(),
            });
          });

          res.on("error", (error: Error & { receivedResponseData?: boolean }) => {
            error.receivedResponseData = receivedResponseData;
            reject(error);
          });
        }
      );

      if (signal) {
        signal.addEventListener("abort", () => {
          req.destroy(new DOMException("Aborted", "AbortError"));
          reject(new DOMException("Aborted", "AbortError"));
        });
      }

      req.on("error", (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
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
  callbacks?.onStatus?.("Calling NVIDIA API...");

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
    throw new Error(`NVIDIA API error (${response.status}): ${response.text}`);
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

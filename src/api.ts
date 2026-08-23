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

/**
 * Bulletproof Mermaid diagram sanitizer:
 * 1. Converts non-standard arrows (e.g. "A -- Yes --> B") into standard Mermaid syntax ("A -->|\"Yes\"| B")
 * 2. Cleans unescaped quotes, mismatched quotes, and special characters inside node labels
 * 3. Enforces double quotes around every node label
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
        trimmed.startsWith("erDiagram")
      ) {
        return line;
      }

      // 1. Convert "A -- Label --> B" to "A -->|\"Label\"| B"
      line = line.replace(/([a-zA-Z0-9_-]+)\s+--\s+([^->]+?)\s+-->\s+([a-zA-Z0-9_-]+)/g, (m, src, label, dst) => {
        const cleanLabel = label.trim().replace(/["'\\]/g, "");
        return `${src} -->|"${cleanLabel}"| ${dst}`;
      });

      // 2. Fix square bracket nodes: id[...] -> id["..."]
      line = line.replace(/([a-zA-Z0-9_-]+)\s*\[\s*"?([\s\S]*?)"?\s*\]/g, (m, id, inner) => {
        let cleanInner = inner
          .replace(/"/g, "'")
          .replace(/'+/g, "'")
          .replace(/[\n\r]/g, " ")
          .trim();
        return `${id}["${cleanInner}"]`;
      });

      // 3. Fix decision diamond nodes: id{...} -> id{"..."}
      line = line.replace(/([a-zA-Z0-9_-]+)\s*\{\s*"?([\s\S]*?)"?\s*\}/g, (m, id, inner) => {
        let cleanInner = inner
          .replace(/"/g, "'")
          .replace(/'+/g, "'")
          .replace(/[\n\r]/g, " ")
          .trim();
        return `${id}{"${cleanInner}"}`;
      });

      // 4. Fix rounded nodes: id(...) -> id("...")
      line = line.replace(/([a-zA-Z0-9_-]+)\s*\(\s*"?([\s\S]*?)"?\s*\)/g, (m, id, inner) => {
        let cleanInner = inner
          .replace(/"/g, "'")
          .replace(/'+/g, "'")
          .replace(/[\n\r]/g, " ")
          .trim();
        return `${id}("${cleanInner}")`;
      });

      return line;
    });

    return `\`\`\`mermaid\n${sanitizedLines.join("\n").trim()}\n\`\`\``;
  });
}

/**
 * Sanitizes markdown structure:
 * 1. Converts pseudo-headings (e.g. "- Decision Matrix" immediately preceding a table) into real "## Decision Matrix" headings so tables render visually.
 * 2. Ensures blank lines around tables and code fences so Obsidian doesn't collapse them into list items.
 */
export function sanitizeMarkdownStructure(markdown: string): string {
  let sanitized = markdown.replace(/^[ \t]*[-*+][ \t]+([A-Z0-9][^\n:]+)\n+([ \t]*\|[^\n]+\|[ \t]*\n[ \t]*\|[\s:|-]+\|[ \t]*\n)/gm, (match, title, tableHeader) => {
    return `\n## ${title.trim()}\n\n${tableHeader}`;
  });

  sanitized = sanitized.replace(/^[ \t]*[-*+][ \t]+([A-Z0-9][^\n:]+)\n+([ \t]*```[a-zA-Z0-9_-]*\n)/gm, (match, title, codeFence) => {
    return `\n## ${title.trim()}\n\n${codeFence}`;
  });

  return sanitized;
}

function cleanMarkdownContent(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```markdown\n") && cleaned.endsWith("\n```")) {
    cleaned = cleaned.slice(12, -4).trim();
  } else if (cleaned.startsWith("```md\n") && cleaned.endsWith("\n```")) {
    cleaned = cleaned.slice(6, -4).trim();
  }

  cleaned = sanitizeMarkdownStructure(cleaned);
  cleaned = sanitizeMermaidDiagrams(cleaned);

  return cleaned;
}

/**
 * Extract content from a single image using the vision model
 */
async function extractContentFromImage(
  settings: NemotronPluginSettings,
  dataUrl: string,
  imageIndex: number,
  totalImages: number,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<string> {
  if (!settings.apiKey || !settings.apiKey.trim()) {
    throw new Error("NVIDIA API key is missing. Please enter your API key in Obsidian Settings > Nemotron Note Crafter.");
  }

  const urlStr = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const urlObj = new URL(urlStr);
  const model = settings.visionModel || "meta/llama-3.2-11b-vision-instruct";

  callbacks?.onStatus?.(
    totalImages > 1
      ? `Reading image ${imageIndex + 1} of ${totalImages}...`
      : "Reading and extracting text & code from image..."
  );

  const payload = JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Accurately extract and transcribe all visible text, instructions, code snippets, function names, parameters, checkboxes, tables, diagrams, and details from this image.",
          },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
    stream: false,
  });

  const isNodeAvailable = typeof https !== "undefined" && typeof https.request === "function";

  if (isNodeAvailable) {
    return new Promise((resolve, reject) => {
      const isHttps = urlObj.protocol === "https:";
      const requestFn = isHttps ? https.request : http.request;

      const req = requestFn(
        urlObj,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk.toString()));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`Vision model error (${res.statusCode}): ${raw}`));
              return;
            }
            try {
              const json = JSON.parse(raw);
              const extracted = json.choices?.[0]?.message?.content || "";
              resolve(extracted);
            } catch (e) {
              reject(new Error(`Failed to parse vision response: ${raw}`));
            }
          });
          res.on("error", reject);
        }
      );

      if (signal) {
        signal.addEventListener("abort", () => req.destroy(new Error("AbortError")));
      }

      req.on("error", (err: any) => {
        if (signal?.aborted || err.message === "AbortError") {
          const abortErr = new Error("Generation cancelled.");
          abortErr.name = "AbortError";
          reject(abortErr);
        } else {
          reject(err);
        }
      });

      req.write(payload);
      req.end();
    });
  } else {
    const response = await requestUrl({
      url: urlStr,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: payload,
    });
    return response.json?.choices?.[0]?.message?.content || "";
  }
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

  // Generate structured note with Nemotron-3 Ultra (550B)
  const isNodeAvailable = typeof https !== "undefined" && typeof https.request === "function";

  if (isNodeAvailable) {
    return generateWithNodeHttps(settings, systemPrompt, combinedPrompt, callbacks, signal);
  } else {
    return generateWithObsidianRequestUrl(settings, systemPrompt, combinedPrompt, callbacks);
  }
}

/**
 * Streaming generation using Node's https/http module
 */
function generateWithNodeHttps(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
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
      callbacks?.onStatus?.("Structuring notes with Nemotron-3 Ultra reasoning...");

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

          callbacks?.onStatus?.("Nemotron thinking and formatting notes...");

          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf-8");
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":")) continue;

              if (trimmed.startsWith("data:")) {
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === "[DONE]") {
                  break;
                }

                try {
                  const parsed = JSON.parse(dataStr);
                  if (parsed.error) {
                    reject(new Error(parsed.error.message || "API stream error"));
                    return;
                  }

                  const choice = parsed.choices?.[0];
                  if (!choice || !choice.delta) continue;

                  const delta = choice.delta;

                  // Reasoning tokens
                  const reasoningChunk = delta.reasoning_content || delta.reasoning || "";
                  if (reasoningChunk) {
                    fullReasoning += reasoningChunk;
                    callbacks?.onReasoning?.(reasoningChunk);
                  }

                  // Content tokens
                  const contentChunk = delta.content || "";
                  if (contentChunk) {
                    if (isReasoningPhase) {
                      isReasoningPhase = false;
                      callbacks?.onStatus?.("Writing formatted Obsidian note...");
                    }
                    fullContent += contentChunk;
                    callbacks?.onContent?.(contentChunk);
                  }
                } catch {
                  continue;
                }
              }
            }
          });

          res.on("end", () => {
            resolve({
              content: cleanMarkdownContent(fullContent),
              reasoning: fullReasoning,
            });
          });

          res.on("error", (err) => {
            reject(err);
          });
        }
      );

      if (signal) {
        signal.addEventListener("abort", () => {
          req.destroy(new Error("AbortError"));
        });
      }

      req.on("error", (err: any) => {
        if (signal?.aborted || err.message === "AbortError") {
          const abortErr = new Error("Generation cancelled.");
          abortErr.name = "AbortError";
          reject(abortErr);
        } else {
          reject(err);
        }
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Fallback generation using Obsidian's requestUrl
 */
async function generateWithObsidianRequestUrl(
  settings: NemotronPluginSettings,
  systemPrompt: string,
  userPrompt: string,
  callbacks?: StreamCallbacks
): Promise<StreamResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const requestBody: Record<string, any> = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
    stream: false,
  };

  if (settings.enableThinking) {
    requestBody.chat_template_kwargs = { enable_thinking: true };
  }

  callbacks?.onStatus?.("Connecting via Obsidian requestUrl...");

  const response = await requestUrl({
    url,
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

  const json = response.json;
  const choice = json.choices?.[0];
  const content = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";

  return {
    content: cleanMarkdownContent(content),
    reasoning,
  };
}

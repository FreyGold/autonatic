export type ConversationProvider = "gemini" | "chatgpt" | "claude";
export type ConversationRole = "user" | "assistant";

export interface SharedConversationMessage {
  role: ConversationRole;
  text: string;
  attachments: number;
}

export interface SharedConversation {
  provider: ConversationProvider;
  title: string;
  url: string;
  messages: SharedConversationMessage[];
}

export type ConversationImportProgress =
  | { stage: "opening" }
  | { stage: "reading"; completed: number; total: number }
  | { stage: "finalizing" };

export interface ParsedConversationUrl {
  provider: ConversationProvider;
  url: string;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Validate against exact provider hosts before launching a local browser. */
export function parseConversationShareUrl(input: string): ParsedConversationUrl {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error("Paste a Gemini, ChatGPT, or Claude conversation share link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Use a public HTTPS conversation share link from Gemini, ChatGPT, or Claude.");
  }

  const host = url.hostname.toLowerCase();
  if (["g.co", "gemini.google.com", "share.gemini.google"].includes(host)) {
    const match = (host === "g.co"
      ? /^\/gemini\/share\/([a-zA-Z0-9_-]{6,64})\/?$/
      : host === "share.gemini.google"
      ? /^\/([a-zA-Z0-9_-]{6,64})\/?$/
      : /^\/share\/([a-zA-Z0-9_-]{6,64})\/?$/).exec(url.pathname);
    if (!match) throw new Error("This is not a Gemini conversation share link. In Gemini, choose Share conversation.");
    return {
      provider: "gemini",
      url: host === "share.gemini.google"
        ? `https://share.gemini.google/${match[1]}`
        : `https://gemini.google.com/share/${match[1]}`,
    };
  }

  if (["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(host)) {
    const match = new RegExp(`^/share/(${UUID})/?$`).exec(url.pathname);
    if (!match) throw new Error("This is not a ChatGPT conversation share link. In ChatGPT, choose Share and copy the conversation link.");
    return { provider: "chatgpt", url: `https://chatgpt.com/share/${match[1].toLowerCase()}` };
  }

  if (["claude.ai", "www.claude.ai"].includes(host)) {
    const match = new RegExp(`^/share/(${UUID})/?$`).exec(url.pathname);
    if (!match) throw new Error("This is not a Claude chat share link. In Claude, choose Share and copy the link.");
    return { provider: "claude", url: `https://claude.ai/share/${match[1].toLowerCase()}` };
  }

  throw new Error("Use a public conversation share link from Gemini, ChatGPT, or Claude.");
}

function cleanText(value: string): string {
  return value.replace(/\r/g, "").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function providerLabel(provider: ConversationProvider): string {
  if (provider === "chatgpt") return "ChatGPT";
  if (provider === "claude") return "Claude";
  return "Gemini";
}

export function formatSharedConversation(conversation: SharedConversation): string {
  if (!conversation.messages.length) throw new Error("The shared page has no conversation messages.");
  const assistant = providerLabel(conversation.provider);
  const lines = [
    `# ${cleanText(conversation.title) || `${assistant} conversation`}`,
    "",
    `Source: ${conversation.url}`,
  ];
  let exchange = 0;
  for (const message of conversation.messages) {
    if (message.role === "user" || exchange === 0) exchange += 1;
    lines.push("", `## ${exchange}. ${message.role === "user" ? "You" : assistant}`, "", cleanText(message.text));
    if (message.attachments) {
      lines.push("", `[${message.attachments} attachment${message.attachments === 1 ? "" : "s"} in the shared conversation; open the source link to view.]`);
    }
  }
  return cleanText(lines.join("\n"));
}

function renderNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (!node.instanceOf(Element)) return "";
  const tag = node.tagName.toLowerCase();
  if (["button", "script", "style", "svg", "mat-icon", "noscript"].includes(tag)
    || node.getAttribute("aria-hidden") === "true"
    || node.classList.contains("cdk-visually-hidden")
    || node.classList.contains("sr-only")) return "";
  if (tag === "br") return "\n";
  if (tag === "pre") {
    const code = node.querySelector("code");
    const language = code?.className.match(/language-([\w+-]+)/)?.[1] || "";
    return `\n\n\`\`\`${language}\n${(code || node).textContent?.trim() || ""}\n\`\`\`\n\n`;
  }
  const inside = Array.from(node.childNodes).map(renderNode).join("");
  if (tag === "code") return `\`${inside}\``;
  if (tag === "a") {
    const href = node.getAttribute("href");
    return href && /^https?:\/\//.test(href) ? `[${inside.trim() || href}](${href})` : inside;
  }
  if (["td", "th"].includes(tag)) return `${inside.trim()} | `;
  if (tag === "tr") return `\n| ${inside.trim()}\n`;
  if (tag === "li") return `\n- ${inside.trim()}\n`;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inside.trim()}\n\n`;
  if (["p", "blockquote"].includes(tag)) return `\n${inside.trim()}\n`;
  if (["div", "section", "article", "ul", "ol", "table"].includes(tag)) return `${inside}\n`;
  return inside;
}

function countAttachments(element: Element): number {
  const files = element.querySelectorAll('[data-testid="file-card-open"], user-query-file-preview').length;
  const images = Array.from(element.querySelectorAll("img"))
    .filter((image) => !image.closest('[data-testid="file-card-open"]')).length;
  return files + images;
}

function pageTitle(document: Document, fallback: string): string {
  const title = cleanText(document.title || "");
  return !title || ["ChatGPT", "Claude", "Gemini"].includes(title) ? fallback : title;
}

async function readGeminiPage(
  document: Document,
  signal?: AbortSignal,
  onProgress?: (progress: ConversationImportProgress) => void,
): Promise<Omit<SharedConversation, "url">> {
  const turnElements = Array.from(document.querySelectorAll("share-turn-viewer"));
  const messages: SharedConversationMessage[] = [];
  onProgress?.({ stage: "reading", completed: 0, total: turnElements.length });
  for (const [index, turn] of turnElements.entries()) {
    if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
    const userLines = Array.from(turn.querySelectorAll("user-query .query-text-line"));
    const userAttachments = turn.querySelectorAll("user-query-file-preview").length;
    const userText = cleanText(userLines.map((line) => line.textContent || "").join("\n"));
    messages.push({
      role: "user",
      text: userText || (userAttachments ? "[Attachment-only message; no text was included.]" : ""),
      attachments: userAttachments,
    });
    const response = turn.querySelector("message-content .markdown");
    messages.push({
      role: "assistant",
      text: response ? cleanText(renderNode(response)) : "",
      attachments: response ? countAttachments(response) : 0,
    });
    if ((index + 1) % 10 === 0 || index + 1 === turnElements.length) {
      onProgress?.({ stage: "reading", completed: index + 1, total: turnElements.length });
      if (index + 1 < turnElements.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return {
    provider: "gemini",
    title: document.querySelector("share-viewer h1")?.textContent?.trim() || "Gemini conversation",
    messages,
  };
}

async function readMessageElements(
  document: Document,
  provider: "chatgpt" | "claude",
  signal?: AbortSignal,
  onProgress?: (progress: ConversationImportProgress) => void,
): Promise<Omit<SharedConversation, "url">> {
  const selector = provider === "chatgpt"
    ? '[data-message-author-role="user"], [data-message-author-role="assistant"]'
    : '[data-testid="user-message"], [data-testid="assistant-message"]';
  const elements = Array.from(document.querySelectorAll(selector));
  const messages: SharedConversationMessage[] = [];
  onProgress?.({ stage: "reading", completed: 0, total: elements.length });
  for (const [index, element] of elements.entries()) {
    if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
    const role: ConversationRole = provider === "chatgpt"
      ? element.getAttribute("data-message-author-role") === "assistant" ? "assistant" : "user"
      : element.getAttribute("data-testid") === "assistant-message" ? "assistant" : "user";
    let text: string;
    if (provider === "chatgpt" && role === "assistant") {
      text = cleanText(renderNode(element.querySelector(".markdown") || element));
    } else if (provider === "claude" && role === "assistant") {
      const prose = Array.from(element.querySelectorAll('[data-cds="Prose"]'));
      text = cleanText((prose.length ? prose : [element]).map(renderNode).join("\n\n"));
    } else {
      text = cleanText(renderNode(element));
    }
    const attachments = countAttachments(element);
    messages.push({
      role,
      text: text || (attachments
        ? "[Attachment-only message; no text was included.]"
        : "[This message had no visible text in the shared snapshot.]"),
      attachments,
    });
    if ((index + 1) % 10 === 0 || index + 1 === elements.length) {
      onProgress?.({ stage: "reading", completed: index + 1, total: elements.length });
      if (index + 1 < elements.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  const label = providerLabel(provider);
  return { provider, title: pageTitle(document, `${label} conversation`), messages };
}

interface ElectronWebContents {
  executeJavaScript<T>(code: string): Promise<T>;
  getURL(): string;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

interface ElectronBrowserWindow {
  readonly webContents: ElectronWebContents;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
}

interface ElectronRemoteModule {
  BrowserWindow: new (options: {
    show: boolean;
    webPreferences: {
      contextIsolation: boolean;
      nodeIntegration: boolean;
      sandbox: boolean;
    };
  }) => ElectronBrowserWindow;
}

function getElectronRemote(): ElectronRemoteModule {
  const hostWindow = window as Window & { require?: (moduleId: string) => ElectronRemoteModule };
  if (!hostWindow.require) throw new Error("Conversation link import is available in the desktop app.");
  return hostWindow.require("@electron/remote");
}

function allowedNavigation(provider: ConversationProvider, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const allowedHosts: Record<ConversationProvider, string[]> = {
      gemini: ["gemini.google.com", "share.gemini.google"],
      chatgpt: ["chatgpt.com", "www.chatgpt.com"],
      claude: ["claude.ai", "www.claude.ai"],
    };
    return allowedHosts[provider].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Import cancelled.", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException("Import cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function loadConversationHtml(parsed: ParsedConversationUrl, signal?: AbortSignal): Promise<string> {
  const electron = getElectronRemote();
  const { BrowserWindow } = electron;
  const browser = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const abortBrowser = (): void => {
    if (!browser.isDestroyed()) browser.destroy();
  };
  signal?.addEventListener("abort", abortBrowser, { once: true });
  try {
    const timeout = waitForDelay(60_000, signal).then(() => {
      throw new Error("The shared conversation took too long to load.");
    });
    await Promise.race([browser.loadURL(parsed.url), timeout]);
    if (!allowedNavigation(parsed.provider, browser.webContents.getURL())) {
      throw new Error("The shared conversation redirected to an unexpected site.");
    }
    const selector = parsed.provider === "gemini"
      ? "share-turn-viewer"
      : parsed.provider === "chatgpt"
      ? '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      : '[data-testid="user-message"], [data-testid="assistant-message"]';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
      if (!allowedNavigation(parsed.provider, browser.webContents.getURL())) {
        throw new Error("The shared conversation redirected to an unexpected site.");
      }
      const found = await browser.webContents.executeJavaScript<boolean>(
        `document.querySelector(${JSON.stringify(selector)}) !== null`,
      );
      if (found) break;
      await waitForDelay(500, signal);
    }
    const html = await browser.webContents.executeJavaScript<unknown>("document.documentElement.outerHTML");
    if (typeof html !== "string") throw new Error("The shared conversation returned an invalid page.");
    return html;
  } finally {
    signal?.removeEventListener("abort", abortBrowser);
    if (!browser.isDestroyed()) browser.destroy();
  }
}

export async function importSharedConversation(
  input: string,
  signal?: AbortSignal,
  onProgress?: (progress: ConversationImportProgress) => void,
): Promise<SharedConversation> {
  const parsed = parseConversationShareUrl(input);
  if (signal?.aborted) throw new DOMException("Import cancelled.", "AbortError");
  onProgress?.({ stage: "opening" });
  const label = providerLabel(parsed.provider);
  try {
    const html = await loadConversationHtml(parsed, signal);
    const document = new DOMParser().parseFromString(html, "text/html");
    const page = parsed.provider === "gemini"
      ? await readGeminiPage(document, signal, onProgress)
      : await readMessageElements(document, parsed.provider, signal, onProgress);
    const conversation: SharedConversation = { ...page, url: parsed.url };
    if (!conversation.messages.length) {
      throw new Error(`The shared ${label} conversation did not load completely. It may require sign-in. Open the link in your browser and copy the conversation text instead.`);
    }
    onProgress?.({ stage: "finalizing" });
    if (formatSharedConversation(conversation).length > 1_000_000) {
      throw new Error("This conversation exceeds the 1 million character import limit.");
    }
    return conversation;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new DOMException("Import cancelled.", "AbortError");
    }
    const detail = error instanceof Error ? error.message : "The shared page could not be opened.";
    throw new Error(`Could not import the shared ${label} conversation. ${detail} Open it in your browser and copy the conversation text instead.`);
  }
}

// Compatibility helpers for existing integrations and saved test fixtures.
export interface GeminiTurn { user: string; gemini: string; attachments: number; }
export interface GeminiConversation { title: string; url: string; turns: GeminiTurn[]; }

export function parseGeminiShareUrl(input: string): string {
  const parsed = parseConversationShareUrl(input);
  if (parsed.provider !== "gemini") throw new Error("Use a public Gemini conversation share link.");
  return parsed.url;
}

export function formatGeminiConversation(conversation: GeminiConversation): string {
  return formatSharedConversation({
    provider: "gemini",
    title: conversation.title,
    url: conversation.url,
    messages: conversation.turns.flatMap((turn) => [
      { role: "user" as const, text: turn.user, attachments: turn.attachments },
      { role: "assistant" as const, text: turn.gemini, attachments: 0 },
    ]),
  });
}

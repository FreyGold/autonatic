# autonatic - Obsidian Plugin

Transform raw, dense, or unorganized text into concise, beautifully structured notes strictly formatted **"The Obsidian Way"** using AI.

## AI providers

- **Supported now:** NVIDIA NIM
- **Coming soon as generation providers:** Groq and Gemini. Gemini conversation links can already be imported as source text.

## Features

- **AI Integration**: NVIDIA NIM support with streaming responses and reasoning/thinking support.
- **The Obsidian Way Skill Prompt**:
  - **Optional YAML Properties / Frontmatter**: Opt in to generated `title`, `aliases`, `tags`, `created`, `summary`, and `status` metadata.
  - **Callouts**: Strategic use of `> [!summary]`, `> [!info]`, `> [!tip]`, `> [!warning]`.
  - **Wikilinks**: Auto-links related concepts `[[Topic]]` for Obsidian Graph View connectivity.
  - **Structure**: Clear headings, bold lead-in bullet points, tables, and mermaid diagrams.
- **Dual Generation Modes**:
  - **Create New Note File**: Creates one `.md` file with an automatic title or selected folder.
  - **Create Multiple Notes in Folder**: Splits the input into new atomic notes and saves all notes in one selected directory.
  - **Append to Current Note**: Adds the formatted section directly to the end of your active note.
  - **In-Place Replace**: Transform selected text right inside the active editor.
- **Bare source-only style**: Cleans pasted browser chat history into Markdown without expanding, inferring, summarizing, or adding new material.
- **Gemini conversation import**: Paste a public **Share conversation** link into Note Crafter to load the text of every visible user and Gemini turn into the source field. Review it before generating one or several notes. Images and other attachments remain linked to the original shared page.
- **Automatic placement across long sources**: Match separate conversation topics against the local vault index so repeated early topics do not hide later ones. Before appending, compare the proposed addition with the current target note and skip material already covered.
- **Folder choices in the generation request**: Multi-note generation decides folders alongside the notes. Placement validates paths locally without additional folder-planning model calls. Failed saves can retry the completed draft.
- **Topic-based note boundaries**: A long existing note stays together when new material belongs there. Generation no longer creates numbered Part or Continued notes when a word count is crossed.
- **Organize notes**: Describe a folder structure in plain language, such as grouping by programming language and then OS, HTTP, or security. Review every proposed note move before applying it. Each arrangement saves a path snapshot that you can restore later.
- **Interactive UI**:
  - Ribbon icon for one-click access.
  - Source-first note and diagram workspaces with visible output controls, a persistent destination summary, and collapsible options in narrow windows.
  - Streaming live preview with collapsible reasoning thought process.
  - Optional folder scope for Smart Placement. Smart can create or append only in the selected folder and its subfolders.
  - Highlighted-text actions to improve, expand, or regenerate only the selected Markdown.
  - Full settings tab to customize API keys, models, temperatures, folders, and prompt instructions.
- **Ask Notes**: Find original passages with links to their notes. Exact term lookups can return from the local index. Natural-language questions combine whole-word and identifier matching with NVIDIA-hosted query embeddings. Results use rarity-weighted text ranking and reciprocal-rank fusion; weak semantic candidates are filtered. Search never generates an answer; the passage and vector index stays in device-local IndexedDB outside the vault. No model runs locally.
- **Adaptive Excalidraw Diagrams**:
  - Automatic mind map, flowchart, architecture, timeline, decision-tree, and comparison selection.
  - Automatic note workflows finish note placement first. A usefulness check then creates, updates, or skips focused diagrams.
  - Compact, balanced, and detailed modes with node limits.
  - Left-to-right or top-to-bottom flow layouts.
  - Dark and light canvas themes.
  - Validated connections, stable element IDs, source-heading links, and local content-based fallback diagrams.

## How to Use

1. Click the **wand ribbon icon** or use `Ctrl/Cmd + P` and search for **"autonatic"**.
2. Paste any text into the modal (or select text in an editor first to auto-populate).
3. Use **Output & destination** to choose the result and where to save it (expand it on a narrow window):
   - **Create New Note File** (Specify title and folder if desired).
   - **Create Multiple Notes in Folder** (Select one directory for all generated notes).
   - **Append to Current Active Note**.
4. Review the destination summary and click the create button, or press **Ctrl/Cmd+Enter**.

For a Gemini chat, use **Share conversation** in Gemini, expand **Import a Gemini conversation**, paste the resulting `g.co/gemini/share/…` link into **Gemini conversation link**, and click **Import**. The plugin uses an installed Chrome, Chromium, Edge, or Brave browser to load the public snapshot, then fills **Source text** so you can review or edit it before generating notes. The shared page is a snapshot; later changes to the chat require a new share link. If link import fails, open the shared page in your browser and copy its conversation text into **Source text**. Do not share a chat publicly if it contains material you want to keep private.

To edit part of an existing note, highlight the text and open the editor context menu. Use an **autonatic** command. The plugin replaces only the highlighted text.

To search your notes, open **Settings > autonatic > Ask Notes**, include the folders you want searchable, and enable Ask Notes. Indexing sends selected Markdown text to NVIDIA for embeddings. Then use **Ctrl+Shift+H** (or **Cmd+Shift+H** on macOS), the **Ask Notes** command, or the button in the Note Crafter. You can change the shortcut in Obsidian Hotkeys. Modified notes update in the background; settings also provide pause, rebuild, and clear controls.

To rearrange existing Markdown notes, choose **Organize notes** in Note Crafter or run the **Organize Notes and Manage Arrangement Snapshots** command. Describe the primary grouping and any priorities, optionally limit the scope to one folder, then click **Plan arrangement**. The preview lists each proposed destination and flags path conflicts. Click **Apply** only after reviewing the moves. **Saved arrangements** lets you review and restore the original paths later. A snapshot records paths, not note contents: edits and newly created notes remain, and a deleted note cannot be recovered from it. Restore stops if a destination is occupied or a tracked note is missing. The snapshot file lives in your vault's Obsidian plugin configuration directory.

## Settings

## Privacy and cost

This is a desktop-only plugin. Generation currently sends your prompt and selected vault context to NVIDIA NIM. Automatic appends make an additional NVIDIA request containing the proposed addition and the target note's contents, or selected excerpts when the target is long. Remote placement indexing is off by default. Ask Notes has separate consent and indexes only included Markdown folders, subject to excluded folders. Its embeddings, stored passages, and search metadata remain on this device and are not placed in the vault. Semantic searches send the query to NVIDIA for an embedding. Search results show original note passages without an answer-generation request. The API provider can charge for each request.

Organize notes sends eligible note paths, titles, tags, and short summaries to NVIDIA for planning. Excluded folders and hidden paths are omitted. The arrangement snapshots are saved locally in the plugin configuration directory.

Run `npm run check` before a release. A tag starts the release workflow. The release contains `main.js`, `manifest.json`, `styles.css`, and `versions.json`.

Go to **Obsidian Settings > autonatic** to configure:
- **API Key**: NVIDIA NIM API key.
- **Model**: `nvidia/nemotron-3-ultra-550b-a55b`.
- **Enable Thinking**: Toggle deep reasoning tokens.
- **Obsidian Skill System Prompt**: Customize the formatting instructions.
- **Default Folder**: Folder path where new notes are created.

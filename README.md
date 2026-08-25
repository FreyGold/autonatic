# Nemotron Note Crafter - Obsidian Plugin

Transform raw, dense, or unorganized text into concise, beautifully structured notes strictly formatted **"The Obsidian Way"**, powered by NVIDIA's `nvidia/nemotron-3-ultra-550b-a55b` model.

## ✨ Features

- 🧠 **NVIDIA Nemotron-3 Ultra Integration**: Pre-configured with NVIDIA integrate API, streaming responses, and reasoning/thinking support.
- 📝 **The Obsidian Way Skill Prompt**:
  - **YAML Properties / Frontmatter**: `title`, `aliases`, `tags`, `created`, `summary`, `status`.
  - **Callouts**: Strategic use of `> [!summary]`, `> [!info]`, `> [!tip]`, `> [!warning]`.
  - **Wikilinks**: Auto-links related concepts `[[Topic]]` for Obsidian Graph View connectivity.
  - **Structure**: Clear headings, bold lead-in bullet points, tables, and mermaid diagrams.
- 🎯 **Dual Generation Modes**:
  - **Create New Note File**: Creates one `.md` file with an automatic title or selected folder.
  - **Create Multiple Notes in Folder**: Splits the input into new atomic notes and saves all notes in one selected directory.
  - **Append to Current Note**: Adds the formatted section directly to the end of your active note.
  - **In-Place Replace**: Transform selected text right inside the active editor.
- ⚡ **Interactive UI**:
  - Ribbon icon for one-click access.
  - Streaming live preview with collapsible reasoning thought process.
  - Highlighted-text actions to improve, expand, or regenerate only the selected Markdown.
  - Full settings tab to customize API keys, models, temperatures, folders, and prompt instructions.
- 🧭 **Adaptive Excalidraw Diagrams**:
  - Automatic mind map, flowchart, architecture, timeline, decision-tree, and comparison selection.
  - Compact, balanced, and detailed modes with node limits.
  - Left-to-right or top-to-bottom flow layouts.
  - Dark and light canvas themes.
  - Validated connections, stable element IDs, source-heading links, and local content-based fallback diagrams.

## 🚀 How to Use

1. Click the **wand ribbon icon** or use `Ctrl/Cmd + P` and search for **"Nemotron Note Crafter"**.
2. Paste any text into the modal (or select text in an editor first to auto-populate).
3. Choose your destination:
   - **Create New Note File** (Specify title and folder if desired).
   - **Create Multiple Notes in Folder** (Select one directory for all generated notes).
   - **Append to Current Active Note**.
4. Click **⚡ Transform to Obsidian Note**.

To edit part of an existing note, highlight the text and open the editor context menu. Use a command under **Nemotron AI**. The plugin replaces only the highlighted text.

## ⚙️ Settings

## Privacy and cost

This is a desktop-only plugin. Generation sends your prompt and selected vault context to the configured NVIDIA service. Remote vault indexing is off by default. You must give consent before the indexer sends note excerpts. You can exclude folders, limit context notes, and limit automatic diagrams. The API provider can charge for each request.

Run `npm run check` before a release. A tag starts the release workflow. The release contains `main.js`, `manifest.json`, `styles.css`, and `versions.json`.

Go to **Obsidian Settings > Nemotron Note Crafter** to configure:
- **API Key**: Pre-configured default NVIDIA API key.
- **Model**: `nvidia/nemotron-3-ultra-550b-a55b`.
- **Enable Thinking**: Toggle deep reasoning tokens.
- **Obsidian Skill System Prompt**: Customize the formatting instructions.
- **Default Folder**: Folder path where new notes are created.

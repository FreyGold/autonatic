# Useful Excalidraw Diagrams for Long Conversations

## Executive summary

The plugin should not turn a long conversation into one large drawing. Smart must first divide, create, and update the correct notes. Diagram planning must start only after those note changes finish.

A **Smart change set** is the list of notes and note sections that one Smart operation created or updated.

A **diagram bundle** is an optional overview drawing with zero or more linked detail drawings. The plugin must create a bundle only when the relationships between several Smart notes need a visual explanation.

This approach uses **progressive summarization**. Progressive summarization means that each stage makes the content shorter but keeps a path to the full source. Zsolt Viczián, the Obsidian Excalidraw author, uses this pattern for books. His process keeps the full source, then creates notes, highlights, keywords, a mini-summary, and a final visual summary. He also creates separate drawing files during the process. See [Sketchnoting a Book in Obsidian](https://www.zsolt.blog/2021/07/sketchnoting-book-in-obsidian.html).

The final design should use **progressive disclosure**. Progressive disclosure means that the overview shows only the main topics. The user opens a linked drawing or source section when more detail is necessary.

The strongest product design is:

1. Run Smart note division and placement.
2. Create, append, or split the correct notes.
3. Record the Smart change set.
4. Check each changed subject for visual value.
5. Return `skip`, `create`, or `update` for each diagram candidate.
6. Create only diagrams that explain a process, decision, comparison, timeline, hierarchy, or dependency.
7. Link each diagram element to the related Smart note or heading.
8. Create an optional cross-note overview only when it makes the note relationships easier to understand.
9. Keep explanations and low-value details in the notes.

## The problem

A long Gemini conversation can contain several different structures. It can contain a process, a comparison, a set of decisions, and unrelated questions. One diagram type cannot show all of these structures well.

One large canvas also causes navigation and performance problems. Miro warns that a board with many objects becomes less smooth to load and navigate. Miro recommends frames and links for large boards. See [Structuring board content](https://help.miro.com/hc/en-us/articles/360017730973-Structuring-board-content).

The useful result is not a visual copy of the conversation. The useful result is an information map. The map must answer these questions:

- What are the main topics?
- What was decided?
- What remains unclear?
- What actions must happen next?
- Where can the user find the supporting source text?

## Findings from primary sources

### Summarize before drawing

The official Excalidraw presentation guide says to keep slides uncluttered and to use limited text. It says to spread excess information across multiple frames. It also says to keep a coherent flow and to adapt the level of detail to the audience. See [Create presentations in Excalidraw with ease. Complete guide](https://plus.excalidraw.com/use-cases/presentations).

The official Excalidraw UML guide gives the same direction. Start with a high-level view. Add details only when they are necessary. Show the core parts. Remove repeated information. Avoid information overload. See [What are UML Diagrams? Learn Everything You Need to Know](https://plus.excalidraw.com/use-cases/uml-diagram).

Miro recommends one focus question for each concept map. It recommends a few words for each concept, not full sentences. It also recommends a separate map for a tangent. See [How to Make a Concept Map | Concept Map Example](https://miro.com/blog/how-to-make-a-concept-map/).

These sources support one rule: summarize the content before the plugin creates Excalidraw elements.

### Use a hierarchy

A hierarchy has a parent topic and child topics. It makes the level of detail clear.

Miro mind maps use a parent node and child nodes. Miro also supports branch expansion and collapse. This lets a user see the overview or one detailed branch. See [Mind map](https://help.miro.com/hc/en-us/articles/360017730753-Mind-map).

Excalidraw does not need a collapse feature to use this model. The plugin can make the overview one file and each detailed branch another file. A link can act as the expand action.

### Use real frames for sections

A frame is a named region that contains one section of a canvas. Excalidraw uses frames as presentation slides. The official guide says that frames keep a presentation organized and easy to follow. It also supports link sharing and PDF or PPTX export. See [Create presentations in Excalidraw with ease. Complete guide](https://plus.excalidraw.com/use-cases/presentations).

A **viewport** is the canvas area that is visible on the screen.

Miro gives useful first-party frame rules that also apply to an Excalidraw canvas:

- Put frames in a left-to-right sequence.
- Make each frame fit the viewport at 100% zoom.
- Do not overlap frames.
- Keep all related objects inside a frame.

See [How to make your Miro boards more accessible](https://help.miro.com/hc/en-us/articles/4403828924306-How-to-make-your-Miro-boards-more-accessible).

Miro frames can be listed, reordered, linked, presented, and exported separately. See [Frames](https://help.miro.com/hc/en-us/articles/360018261813-Frames).

Should frames replace linked files? No. A frame keeps related elements in one scene. It does not reduce the number of elements that the scene must load. Use frames for small sections and presentations. Use separate linked files for large topics.

### Link the overview, details, and source

The Obsidian Excalidraw plugin supports links to notes and parts of drawings. It supports `area=`, `group=`, `frame=`, and `clippedframe=` references. It also supports backlinks and Obsidian graph view. See the [Obsidian Excalidraw README](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/README.md).

The current plugin source exposes commands that copy links for an element, group, area, frame, or clipped frame. It also supports opening a link in another pane. See the [Obsidian Excalidraw English locale source](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/lang/locale/en.ts).

The official **Deconstruct selected elements into new drawing** script gives a direct model for large content. It moves selected elements into a new Excalidraw file. It then replaces the selection with an embedded drawing. Its stated purpose is to split a large drawing into smaller reusable parts. See [Deconstruct selected elements into new drawing.md](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/ea-scripts/Deconstruct%20selected%20elements%20into%20new%20drawing.md).

The Excalidraw API can center selected elements and fit them to the viewport. It also warns that animation can be less smooth in a large scene. See [excalidrawAPI](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api).

### Process long input in bounded parts

A bounded part is a selected section of the source. Bounded processing reduces overload and makes source coverage easier to verify.

Miro AI can cluster or summarize a selected group of sticky notes. This is a useful first-party pattern for long input. The AI works on a selected group, not an unlimited board. See [Miro AI with Sticky notes](https://help.miro.com/hc/en-us/articles/28781881506834-Miro-AI-with-Sticky-notes).

FigJam uses pages as a higher level of organization. Figma also gives an example that moves growing content to separate pages to keep loading fast. See [Create and manage pages in FigJam](https://help.figma.com/hc/en-us/articles/24005082123159-Create-and-manage-pages-in-FigJam).

## Research evidence

### Use a multi-stage summary

Should the plugin send one shortened part of the conversation to the model? No.

The `SummN` research system handles long documents and conversations with a split-then-summarize process. It makes coarse summaries from bounded parts. It then uses these summaries to make the final summary. This method avoids a fixed input limit and performed better than prior systems on several long meeting and document data sets. See [SummN: A Multi-Stage Summarization Framework for Long Input Dialogues and Documents](https://aclanthology.org/2022.acl-long.112/).

Should the plugin make the same summary for every user goal? No.

The QMSum research paper says that one short summary cannot easily cover a long meeting with many topics and users. It uses a user question to find relevant parts before it makes a summary. See [QMSum: A New Benchmark for Query-based Multi-domain Meeting Summarization](https://aclanthology.org/2021.naacl-main.472/).

These results support two product rules:

- Process all parts of the source before drawing.
- Ask what the user wants to understand. Then select and summarize the relevant parts.

### Show an overview before detail

Should the first drawing contain all detail? No.

Shneiderman's information-search rule is: show an overview first, then support zoom and filtering, then show detail when the user asks for it. The paper applies this rule to trees and networks as well as other data types. See [The Eyes Have It](https://hci.stanford.edu/courses/cs448b/papers/shneiderman96eyes.pdf).

The review by Cockburn, Karlson, and Bederson compares several view methods. A **focus-and-context view** shows detail inside its surrounding context. The review finds that no method is best for every task. It also finds that overview-and-detail views can help document understanding, but view changes can require mental effort. The user must always know where they are and how to go back. See [A Review of Overview+Detail, Zooming, and Focus+Context Interfaces](https://csse.canterbury.ac.nz/andrew.cockburn/papers/fc.pdf).

### Use linked levels as semantic zoom

**Semantic zoom** means that the information changes when the user changes scale. It does not mean that the same text only becomes larger or smaller. Pad++ is an early research system for this type of multi-scale interface. It uses scale to expose different information and relationships. See [Pad++: A Zooming Graphical Interface for Exploring Alternate Interface Physics](https://www.cs.umd.edu/~bederson/images/pubs_pdfs/p17-bederson.pdf).

Does the current renderer provide semantic zoom? No. It creates one static Excalidraw scene. Normal zoom changes the size of the same elements.

The practical design is a discrete form of semantic zoom. An overview node opens a detail drawing. A detail node opens the exact source section. The C4 model uses the same map idea. It uses separate diagrams at different levels of detail. Its official guidance also says to split a complex diagram into several focused diagrams. See [C4 model diagrams](https://c4model.com/diagrams) and the [C4 model FAQ](https://c4model.com/faq).

### Use a focus question, hierarchy, and selective links

The IHMC concept-map report defines a concept map as concepts joined by meaningful link phrases. It puts general concepts above specific concepts. It says that each map should answer one focus question. For one limited domain, it gives 15 to 25 concepts as a normal working set. A **cross-link** joins topics in different branches. The report says to use only the most useful cross-links. For larger maps, it recommends linked submaps. See [The Theory Underlying Concept Maps and How to Construct and Use Them](https://cmap.ihmc.us/publications/researchpapers/theoryunderlyingconceptmaps.pdf).

Is 15 to 25 a universal node limit? No. It is guidance for concept-map construction in a limited domain. It is not a safe limit for every diagram type, screen, or user task.

Working memory is the small amount of information that a person can hold while reasoning. Cowan's review gives a central capacity estimate of about four chunks under restricted conditions. This result does not mean that every diagram must have four nodes. It supports small peer groups and clear hierarchy. See [The Magical Number 4 in Short-Term Memory](https://pubmed.ncbi.nlm.nih.gov/11515286/).

Should the plugin increase the edge count when it adds detail? No.

Purchase, Cohen, and James tested graph drawing rules. Their study supports reducing edge crossings as an important aid to graph reading. See [An Experimental Study of the Basis for Graph Drawing Algorithms](https://doi.org/10.1145/264216.264222). The IHMC report also says to select only prominent cross-links and to use precise link phrases. These results support sparse edges and separate detail maps.

## Current repository behavior

This section describes the current implementation in [src/excalidraw-generator.ts](../src/excalidraw-generator.ts) and [src/diagram-engine.ts](../src/diagram-engine.ts).

### Input handling

The generator sends this content to the model:

```ts
request.content.slice(0, 9000)
```

This limit is 9,000 characters. It is not 9,000 tokens. The plugin silently removes all later content before model synthesis.

Why is this a problem? A long conversation often puts conclusions and action items near the end. The current model never sees them.

The diagram type detector reads the full input. The model reads only the first 9,000 characters. This can create a mismatch. For example, the full input can look like a decision tree, but the visible model section can contain only an introduction.

There is no chunking step. A chunk is a bounded part of the input. There is also no second pass that merges summaries from several chunks.

### Model prompt and normalization

The prompt already contains good local rules:

- Explain the structure.
- Do not copy the complete note.
- Use short node titles.
- Use one short fact per node.
- Limit the number of links for each node.
- Keep a flowchart path concise.

The engine then applies hard visual limits:

| Detail setting | Maximum nodes | Normalized model details per node |
| --- | ---: | ---: |
| Compact | 7 | 0 |
| Balanced | 10 | 1 |
| Detailed | 14 | 2 |

The public option accepts up to 30 nodes. The detail limit reduces it to 14 or less. Node titles become at most 48 characters. Model detail items become at most 76 characters. The engine keeps at most five takeaways.

These limits help readability. They do not solve source coverage. The first 9,000 characters compete for the same small node set. Later content has no representation.

The engine also limits each node to two incoming edges and two outgoing edges. It limits the total edge count to the node count plus two. These rules reduce clutter.

The planner selects one global diagram type for the complete input. It cannot use a timeline for one topic, a comparison for another topic, and a decision tree for a third topic. A diagram bundle must let each detail drawing use its own type.

### Local fallback

The engine uses a local fallback when the model fails or returns invalid JSON. The fallback takes the first headings. If it cannot find enough headings, it takes the first sentences.

This fallback also has an early-content bias. It does not sample the full note by section. It does not find conclusions near the end. It does not report content coverage.

The engine creates warnings when it uses the fallback. The generator does not put these warnings in the drawing or return them to its caller. The user can receive a drawing without knowing that model synthesis failed.

### Layout

The current layout supports six diagram types:

- Mind map
- Flowchart
- Architecture
- Timeline
- Decision tree
- Comparison

The layout is deterministic. A deterministic layout gives the same positions for the same normalized specification.

The mind map puts one root in the center. It puts other nodes in two tall columns. A timeline grows horizontally by 330 canvas units for each node. Other directed diagrams use ranks and lanes. Architecture groups can form columns or rows.

The layout is static and wide. For example, a right-directed chain with 14 nodes can span about 5,500 canvas units. A node limit therefore does not guarantee a drawing that is easy to navigate.

The renderer wraps text and changes box height. It routes feedback edges outside the main content. It also moves edge labels when labels collide with other edge labels.

These choices improve one small drawing. They do not give a large conversation a navigation structure.

### Groups are not Excalidraw frames

The model can return groups. The renderer draws each group as a dashed rectangle and a text title.

These group rectangles are normal Excalidraw rectangle elements. They are not frame elements. All elements have `frameId: null`. The renderer also leaves `groupIds` empty.

Why does this matter? The result cannot use native frame navigation, frame links, frame presentation, or frame-only export.

### Links

The drawing title links to the full source note. A node can link to a source heading when the model returns an exact `sourceHeading` value.

There is no validation that the heading exists. There is no source block link for conversations that do not contain headings. There is also no coverage record that shows which source sections created each node.

The engine does not support a node link to another generated drawing. It does not add a **Back to overview** link. It creates one Excalidraw file for one request.

### File output

The mirrored path follows this pattern:

```text
Excalidrawings/<note-folder>/<note-name>.excalidraw.md
```

A mirrored run replaces the existing drawing. A standalone run creates a new numbered file when the name already exists.

The output is a parsed Excalidraw Markdown file. It contains the source note link and the Excalidraw JSON. This format is a good base for native Obsidian links.

### Automatic diagram limit

The settings file defines `maxAutomaticDiagrams`. Its default is three. The settings screen lets the user change it. See [src/settings.ts](../src/settings.ts).

The source generation paths do not read this setting. It does not limit the number of diagrams in an operation. A diagram-bundle implementation must connect this setting to planning and file creation.

## Main gaps

| Gap | User effect |
| --- | --- |
| The model sees only the first 9,000 characters. | The drawing can omit conclusions and later topics. |
| One request creates one drawing. | Several topics compete for one canvas. |
| There is no topic extraction and merge pass. | Repeated ideas remain hard to control. |
| Groups are dashed rectangles, not frames. | Native frame navigation and frame export are unavailable. |
| Nodes cannot link to generated detail drawings. | The user cannot move from overview to detail. |
| Source links depend on exact headings. | Raw conversations have weak source navigation. |
| The fallback uses the first headings or sentences. | A model failure increases early-content bias. |
| Warnings are not shown to the user. | A fallback can look like a complete AI result. |
| There is no coverage report. | The user cannot see what the plugin omitted. |
| One global diagram type applies to the complete source. | Different topic structures receive the same visual form. |
| The layout grows in fixed wide or tall steps. | A small node count can still make a large canvas. |
| `maxAutomaticDiagrams` is not used by generation. | The shown cost limit does not control generated diagram count. |

## Recommended architecture

### Stage 1: Complete Smart note placement

Run the existing Smart operation first. It can create a note, append to an existing note, or create a continuation note. Atomic decomposition can change several notes.

Do not generate a drawing inside `createNewNoteFile()`. That function does not know the complete result of the Smart operation.

Record the changed note path, the added section, and the final note content.

```ts
interface SmartNoteChange {
  path: string;
  action: "created" | "appended" | "split";
  addedContent: string;
  finalContent: string;
}
```

### Stage 2: Extract visual facts from the Smart change set

Process the changed notes with a small schema. Do not ask for shapes yet. Use the new section as the main focus. Use the final note only for necessary context.

```ts
interface TopicFact {
  id: string;
  topic: string;
  kind: "claim" | "decision" | "question" | "example" | "action";
  summary: string;
  noteLinks: string[];
}
```

This stage must preserve note links. It must not create a diagram.

### Stage 3: Apply a usefulness gate

A **usefulness gate** is a check that decides whether a drawing improves understanding.

Return `skip` when the candidate is mainly a summary, a fact list, a reference note, or text that has no useful relationships. Return `create` when a new drawing can answer one clear visual question. Return `update` when an existing drawing already covers the same question.

The gate can approve these structures:

- Ordered process
- Branching decision
- System or dependency map
- Comparison with clear axes
- Timeline
- Hierarchy

It must reject a drawing that only repeats the note in boxes.

### Stage 4: Merge and rank approved subjects

Merge facts that describe the same topic. Keep all note links. Rank topics by these signals:

- Explicit decisions
- Repeated discussion
- User questions
- Action items
- Dependencies between topics

Do not rank a topic only because it appears early.

### Stage 5: Plan useful drawings

```ts
interface DiagramDecision {
  action: "skip" | "create" | "update";
  focusQuestion?: string;
  sourceNotePaths: string[];
  existingDrawingPath?: string;
  reason: string;
  spec?: DiagramSpec;
}
```

Use these rules:

- Give each drawing one focus question.
- Use short labels.
- Keep a drawing to about four to ten nodes by default.
- Keep the current limit of two incoming and two outgoing edges per node.
- Select the best diagram type for each approved subject.
- Use one overview across several notes only when the relationships between those notes are important.
- Keep low-value examples and explanations in the Smart notes.
- Use `maxAutomaticDiagrams` as a hard limit for one Smart operation.

These number ranges are product defaults, not research laws. They start close to the current renderer limits. The team must validate them with real conversations and user tests.

### Stage 6: Render with Excalidraw Automate rules

Extend `DiagramNode` with explicit navigation data:

```ts
interface DiagramLinkTarget {
  notePath?: string;
  heading?: string;
  blockId?: string;
  drawingPath?: string;
  frameName?: string;
}
```

Render real Excalidraw frame elements for named sections. Set each child element's `frameId`. Use a stable frame name.

The Excalidraw Automate AI skill requires Excalidraw Automate methods when those methods can do the work. It also requires a workbench for safe scene changes. Measure text before layout. Group related elements. Store plugin data with `addAppendUpdateCustomData()`. Commit scene changes with `addElementsToView()`.

When an overview is useful, it must contain:

- One node for each main topic
- A link from each expandable topic to its detail drawing
- Links to the related Smart notes

Each detail drawing must contain:

- A short purpose statement
- One topic only
- Links to the exact Smart notes or headings
- A **Back to overview** link
- Optional links to related detail drawings

### Stage 7: Open the correct view

Open the overview with zoom-to-fit. Open a detail link at its target frame or target elements. Avoid animated travel across a very large canvas. The Excalidraw API warns that animation can be less smooth for large scenes. See [excalidrawAPI](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api).

### Stage 8: Export bounded content

Keep the native `.excalidraw.md` files as the interactive form. Use frame-level SVG, PNG, or PDF only for static sharing.

Do not export the complete infinite canvas as the main artifact. Export the overview or selected frames. The official Excalidraw presentation guide supports link sharing and PDF or PPTX export. Miro also treats one frame as one image, PDF page, or slide. See [Create presentations in Excalidraw with ease. Complete guide](https://plus.excalidraw.com/use-cases/presentations) and [Structuring board content](https://help.miro.com/hc/en-us/articles/360017730973-Structuring-board-content).

## Suggested product controls

Replace the current automatic-diagram label with a clear option:

- **Create useful diagrams after Smart placement**: Smart can create, update, or skip diagrams after all note changes finish.

Show a short result such as `2 diagrams created, 1 updated, 4 skipped`. Explain the skip reason only when the user opens details.

Add these controls:

- Detail level
- Maximum automatic diagrams
- Diagram folder
- Source-link mode: headings or block IDs
- Show source coverage

Use the existing `maxAutomaticDiagrams` setting as the maximum number of created or updated drawings. If more candidates qualify, keep the highest-value diagrams and skip the rest.

The current folder limit applies to the Smart notes. Mirror each approved drawing under the same limited note path. Use stable names so that a later Smart operation can update the correct drawing.

## Failure and quality rules

The system must not claim that every changed note needs a drawing.

If one candidate fails, continue with the other candidates. Report the failure. Do not replace a failed decision with an automatic drawing.

Before file creation, validate these rules:

- Every diagram node that states a fact has a Smart note link.
- Every optional detail drawing has an overview link and a back link.
- Every frame has a unique stable name.
- No frame overlaps another frame.
- Each frame fits the target viewport.
- No node label contains a full paragraph.
- No generated file points outside the selected folder when folder limits are active.

Show a small result report:

```text
Checked 7 changed notes.
Created 2 diagrams and updated 1 diagram.
Skipped 4 notes because a drawing would not improve understanding.
Linked 18 nodes to Smart notes or headings.
```

## Implementation order

### Phase 1: Move diagram work after Smart

1. Remove drawing creation from the note-write function.
2. Record every note that Smart creates or updates.
3. Run diagram planning after all note writes finish.
4. Add the `skip`, `create`, and `update` results.
5. Remove the silent 9,000-character cut for approved diagram candidates.

This phase gives the largest quality gain.

### Phase 2: Create and update useful drawings

1. Add the usefulness gate.
2. Rank approved candidates.
3. Apply `maxAutomaticDiagrams`.
4. Add note and heading links.
5. Add stable update behavior.
6. Add an optional cross-note overview when it has visual value.

### Phase 3: Add real frames and view navigation

1. Render native frame elements.
2. Assign elements to frames.
3. Add frame links.
4. Open the selected frame with zoom-to-fit.
5. Add frame-level export.

### Phase 4: Add quality checks

1. Measure frame bounds.
2. Reject overlapping frames.
3. Limit text density.
4. Test source coverage.
5. Test links after file rename or update.

## Test cases

Use at least these cases:

1. A short conversation with one topic.
2. A long conversation with conclusions at the end.
3. Smart routes practical and theoretical subjects into different notes.
4. A conversation with repeated topics across distant turns.
5. A conversation with no Markdown headings.
6. Every candidate fails the usefulness gate and no drawing is created.
7. Smart appends to a note that already has a related drawing.
8. Approved drawings stay inside a folder-limited Smart scope.
9. A renamed source note.
10. An export of one useful frame.

The key sequence test must prove that all Smart note writes finish before diagram planning starts. A second regression test must put a unique decision after character 9,000 in an approved candidate and preserve that decision.

## Online skill assessment

The official repository contains an [`excalidraw-automate` SKILL.md](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/docs/AITrainingData/excalidraw-automate/SKILL.md).

Does this skill decide whether a diagram is useful? No.

The skill teaches an AI agent how to write and modify ExcalidrawAutomate scripts. It is useful for implementation. It does not define the summarization stages, topic merge rules, source coverage, or overview-to-detail structure.

Use the skill for the drawing implementation. Follow its Excalidraw Automate preference, workbench, text measurement, grouping, custom-data, and commit rules. Use the post-Smart usefulness gate for information selection.

## Final recommendation

Finish Smart note division and placement first. Then run a usefulness gate on the Smart change set. Create no drawing when a drawing does not improve understanding.

Keep the existing small-diagram limits. Put a new planning layer after Smart. This layer must choose `skip`, `create`, or `update`, rank approved candidates, and apply the automatic-diagram limit.

Use the Excalidraw Automate skill for the drawing layer. Keep every visual claim linked to the related Smart note. Create a cross-note overview only when the note relationships need one.

This change will make generated drawings useful for study and navigation. It will also reduce canvas size and make omissions visible.

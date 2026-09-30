# Handwritten notes to Markdown

## Whole-note workflow in beta.9

Open a Markdown note and run **Transcribe all handwriting in this note** from
the command palette. The dialog renders the note's pen ink as one picture,
without splitting strokes into guessed words or lines. The whole picture is
selected initially. To use only part of it, drag a rectangle on desktop; on
iPad, tap **Select area** and draw the rectangle with a finger or Pencil.
You can scroll a long image when selection mode is off.

Choose **Mixed handwriting (Codex)** and press **Recognize selection**. The
iPad sends only the selected ink image through the existing token-protected
laptop service. The service invokes the laptop's signed-in Codex CLI in a
temporary folder, with a read-only sandbox and an ephemeral session. It uses
the model named in the laptop's Codex configuration (or its default model),
and returns editable Obsidian Markdown. Long areas are sent as an overview
and overlapping detail images in one request. Up to eight detail images are
allowed; select a smaller area if the note exceeds that limit.

If existing Markdown text or a pasted image lies between two handwriting areas,
the dialog recognizes those areas as separate sections. It places each reading
after the corresponding Markdown block. This split uses rendered note content,
not gaps between pen strokes, so words are not divided into separate requests.
Review each reading and its **After:** insertion point. You can select a
different block in its dropdown, reorder or remove readings, and edit their
Markdown.

**Insert transcription** offers **Beside matching note sections** (default),
**At cursor when command opened**, and **At end of note**. For the latter two,
you can also edit the combined Markdown box after recognition. The cursor is
captured before the dialog opens; if the note changes during recognition,
positional insertion refuses and lets you copy the result instead. End-of-note
insertion uses the current end of the same note.

Each reading has an optional **Replace this section's pen ink** switch. It is
off by default. After the Markdown is inserted, the plugin removes only the
complete pen strokes in that reviewed selection as one undoable ink action.
When replacement is on, the reading's insertion-point dropdown is disabled
and the suggested matching section is used automatically. The overall
insertion mode is locked to matching sections until all replacement switches
are off.
Partial strokes, highlighter marks, other sections, existing note text, and
pasted image embeds remain. Review drawings in a selection before enabling
replacement, since a selected pen drawing is also pen ink. **Copy Markdown**
leaves the note unchanged.

The dropdown also offers **Text only (local)** with optional TrOCR and
**Equation only (local)** with UniMERNet. They are useful for focused crops but
do not understand a mixed page. TrOCR's published intended input is a single
handwritten text line, so its multi-line support is a best-effort fallback.

## Setup and limits

Install and start the [laptop service](../services/unimernet/README.md), sign
in to Codex on that laptop, and restart desktop Obsidian. In Handwriting
settings, press **Test Codex connection** on the laptop and iPad. The iPad
uses the same service URL and access token as UniMERNet; it does not need
Codex installed. A Codex model request sends the selected ink image to OpenAI
under the laptop's existing Codex sign-in. No API key or Codex credential is
copied into the vault. The local TrOCR and UniMERNet modes remain available
without a Codex model request.

The plugin limits a note snapshot to 1,200 pen strokes and 120,000 points.
The service accepts at most nine images and 16 million decoded pixels per
request. Very large notes may need multiple selections. Handwriting and math
recognition can still make mistakes, especially on crowded diagrams or
ambiguous symbols; review the Markdown before appending.

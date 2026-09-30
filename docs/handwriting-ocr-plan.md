# Handwritten notes to Markdown

## Whole-note workflow in beta.8

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

Review the result and add more selections if useful. You can move or remove
readings and edit the assembled Markdown. **Append to this note** inserts only
at the current end of the same open editor. It never replaces existing note
text, pasted image embeds, or original ink. **Copy Markdown** leaves the note
unchanged.

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

# Transcribe handwriting

Turn on **Transcribe handwriting with Codex** in Handwriting settings first:
the feature is off by default, and its commands and settings only appear
while it is on.

Use **Transcribe all handwriting in this note** from Obsidian's command palette.
The dialog shows the note's pen ink as one image. Choose the whole image or
draw an area, then press **Recognize selection**. The laptop's signed-in Codex
CLI returns mixed prose and equations as editable Markdown with LaTeX math.

Handwriting divided by existing Markdown or pasted images is recognized in
sections so each result can be inserted beside its matching content. Review
every section before insertion. **Replace this section's pen ink** removes
only that section's selected pen strokes after its Markdown is inserted;
otherwise the original ink stays. Existing text and pasted images are kept.

## Drawn figures

Codex marks plots, graphs, diagrams, and sketches as **figures** instead of
transcribing them. Each detected figure gets its own card in the review
dialog with three choices:

- **Embed my drawing as an image** (default): the figure's exact pen ink is
  saved as an `.svg` beside the note and embedded where the figure sat, so a
  full replacement keeps the drawing.
- **Redraw with Codex**: Codex redraws the sketch as a clean vector figure.
  Each redraw automatically carries the figure's surroundings as context -
  the section's transcribed text, its ink overview, and up to two images
  already placed in that part of the note - so Codex knows what the drawing
  is supposed to be (context is reference material only; it is told never to
  add data the drawing does not show). The redraw appears in the card for
  review first - accept it, or describe a change and send it back as many
  times as needed. Only an accepted redraw is embedded; your original ink is
  always the fallback.
- **Keep it as pen ink only**: nothing is embedded and the figure's strokes
  are never removed, even when the section's ink is replaced.

The same cards appear in **Lasso: transcribe handwriting** when the lasso
contains a drawing. With **Replace selected pen ink** on, the lasso dialog
inserts the transcription beside the ink's own section rather than at the
saved cursor, so the text succeeds the ink in place.

Follow [the Codex CLI setup](../services/codex/README.md) on the laptop.
On iPad, set the laptop service URL to its Wi-Fi address and sync or copy the
access token. The laptop must remain reachable. The **Transcription model**
setting shows the laptop's configured Codex model. Keep **Follow laptop** selected
to use that model, or choose another image-capable model from the dropdown. If the laptop
has no configured model, the Codex CLI chooses its own default.
**Test connection** shows the laptop model.

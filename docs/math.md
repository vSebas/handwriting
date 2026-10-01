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

For a graph beside writing, keep the whole-note replacement toggle off so the
original graph stays in place. To replace just the writing, lasso only its pen
strokes and run **Lasso: transcribe handwriting**. That dialog can insert at the
saved cursor and remove only the selected pen strokes. Any graph outside the
lasso remains as editable original ink.

Follow [the Codex CLI setup](../services/codex/README.md) on the laptop.
On iPad, set the laptop service URL to its Wi-Fi address and sync or copy the
access token. The laptop must remain reachable. The **Transcription model**
setting shows the laptop's configured Codex model. Keep **Follow laptop** selected
to use that model, or choose another image-capable model from the dropdown. If the laptop
has no configured model, the Codex CLI chooses its own default.
**Test connection** shows the laptop model.

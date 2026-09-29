# Handwriting to LaTeX in this fork

This fork adds recognition to Handwriting's existing note and PDF annotation
surfaces. Select either [Hand-to-TeX](https://github.com/Projekt-Deep-Learning-2026/hand-to-tex)
on your device or **UniMERNet** on your laptop. Both preserve the same lasso,
preview/edit, and insert workflow. Printed PDF content and embedded images are
not recognized by the plugin command.

## UniMERNet setup

Follow the [local service instructions](../services/unimernet/README.md), then
choose **UniMERNet (local service)** under **Handwriting to LaTeX** in settings.
Desktop Handwriting starts the installed service automatically when Obsidian
opens, and saves the generated access token. On iPad, use the laptop's network
address and sync or enter the token. Press **Test connection**. No offline
Hand-to-TeX model download is needed when using UniMERNet.

Lasso an equation, run the conversion command, and press **Recognize with
UniMERNet**. Only the selected pen paths are rendered black on white and sent to
your configured service. Your laptop runs the base model and returns one LaTeX
result to the existing preview. Desktop Obsidian must remain open, and the laptop
must remain awake and reachable. Closing the
dialog ignores late results; work already running on the laptop may finish.
Recognition images and LaTeX are not saved by the service.

## Hand-to-TeX setup and use

For BRAT, add `vSebas/handwriting` and select the published release. UniMERNet
was added in `1.4.22-beta.3`; automatic laptop startup is `1.4.22-beta.4`.
Version `1.4.22-beta.5` adds setup instructions in Handwriting settings.
BRAT installs the three compiled files from the release; no source build is needed
on the iPad. Follow the model-download step below only if you choose Hand-to-TeX.
This fork uses the same plugin ID as upstream and replaces its installed build.

1. Build this fork with `npm ci` and `npm run build`. Copy `main.js`, `styles.css`,
   and `manifest.json` into your vault's `.obsidian/plugins/handwriting/` folder,
   replacing the installed Handwriting files, then reload the plugin. These
   changes are not part of the upstream community release. Keep the license and
   third-party notices with the build. This is a personal local build; the
   repository's `LICENSE` prohibits distributing modified versions without permission.
2. Open Handwriting settings, find **Offline math recognition**, and press
   **Download model**. This explicitly downloads 18.5 MB of pinned, checksum-verified
   model data from Hugging Face into the plugin's `math-models/` folder. The
   executable inference runtime is bundled in `main.js`, which is consequently
   larger than upstream. Setup requires internet; recognition does not.
3. In an editable Markdown note, place the text cursor where the equation should
   go. Write normally, then lasso one equation with Handwriting's existing tool.
4. Run **Handwriting: Lasso: convert handwriting to LaTeX** from the command
   palette (or assign it a hotkey).
5. Press **Recognize with Hand-to-TeX**. When several readings are available,
   tap the closest of up to three preview buttons. Review the native MathJax
   preview and correct the editable LaTeX if necessary. Selecting a candidate
   only updates the review field; it does not insert into your note.
6. Choose inline or display math and **Insert at saved cursor**, **Copy Markdown**,
   or **Copy LaTeX**. PDF annotations offer the copy actions.

Original ink is retained. Insertion adds text without replacing the editor's
text selection, and a normal editor undo removes it. If you switch editors or
the destination text changes during recognition, insertion is refused; the
result can still be copied. Closing the dialog cancels inference and releases
the worker and model memory.

## Obsidian and math plugin compatibility

Output is plain Markdown: `$x^2$` or a `$$` display block. There are no proprietary
math code blocks, custom renderers, new note properties, or sidecar schema changes.
LaTeX Suite, Quick LaTeX, and other plugins can edit the resulting text using their
usual workflows. Compatibility is based on standard Markdown math; individual
third-party plugins have not been tested together on a live iPad.

At a cursor inside a complete dollar-delimited math expression, insertion adds
only the LaTeX body. The plugin refuses detected code, properties, and positions
inside math delimiters or commands. Markdown context detection is conservative,
not a full Markdown parser; for complex lists, callouts, custom math syntax, or
unclosed blocks, use Copy LaTeX and paste at the intended position. Display output
is intended for a normal paragraph or existing display equation.

Native Obsidian MathJax renders the preview. Full LaTeX documents, package loading,
and arbitrary LaTeX engines are outside the scope of this feature.

## On-device Hand-to-TeX workflow and limits

The intended workflow is to write, lasso, recognize, review, and insert on the
iPad itself. The runtime uses single-threaded WebAssembly in a dedicated worker;
it does not require WebGPU, Node.js, or a second computer. Recognition does not
upload handwriting, and it never silently falls back to a cloud service.

Download the models on each device unless your sync setup also copies the plugin's
model folder. Once present, airplane-mode recognition should work on supported
webviews. Actual Obsidian/iPad speed, memory behavior, and Apple Pencil interaction
still require device validation; a desktop browser test cannot establish those.

Select one expression at a time. There is a 2,048-point / 200-stroke input limit
to bound memory consumption and a 149-token output limit matching the upstream
decoder. Highlighter strokes are ignored. Handwriting accuracy is model-dependent;
review fractions, superscripts, signs, and symbol ambiguities before inserting.
The model supplies no calibrated confidence estimate.

Recognition uses a three-hypothesis beam search with a modest length penalty,
keeping alternatives instead of committing immediately to each highest-scoring
symbol. Candidates are ranked model suggestions, not guaranteed correct readings.
Some selections produce fewer than three usable complete expressions. The same
offline model is used; no retraining or improvement in accuracy on a handwriting
benchmark is claimed. Comparing alternatives may take longer than the first beta.

## Developer checks

`npm test` covers selection snapshots, feature extraction, offline model handling,
formatting, insertion, and undo. `npm run build` type-checks and bundles the worker,
its runtime glue, and WASM into the plugin.

For an actual offline model smoke test, obtain `encoder.onnx` and
`decoder_step.onnx` from the [pinned model revision](https://huggingface.co/m4jkiuwr/htt-mini/tree/58170cc16748a5652e5e58caf93019fb8b0603c4), install the Playwright
Chromium headless browser, then run:

```sh
node scripts/test-math-model.mjs /path/to/model-directory
```

The smoke test verifies checksums, recognizes a synthetic `1+1` pen trace using
the real worker and models, and blocks external browser network requests.
Before release, test on an iPad with airplane mode, cancelled recognition,
repeated conversions, switching notes, undo, and LaTeX Suite/Quick LaTeX enabled.

# Handwritten notes to Markdown: implementation plan

The first working increment is a separate **Lasso: convert handwriting to text**
command. It uses the same selected pen paths, authenticated laptop service,
editable review, safe insertion, and copy workflow as math recognition. An
optional, pinned TrOCR model reads English text lines on the laptop; UniMERNet
remains the math recognizer. The iPad sends only the selected ink image through
the existing service URL. The plugin retains the original ink.

TrOCR was chosen for this narrow task because its published intended use is OCR
on single handwritten text lines. It is not an all-purpose notes parser. The
separate model loads only on the first text request and is installed only after
the user explicitly runs `services/unimernet/setup-text.ps1`. Math-only users
need not download it.

## Next increment: review a whole note

1. Collect pen strokes from the active Handwriting note without altering them.
   Keep their note coordinates, bounds, stroke order and layer identity. Bound
   the request size, and divide large pages into overlapping tiles.
2. Group nearby strokes into candidate lines and regions. Give each region its
   original image crop and position. Do not turn spatial order into a sentence
   before the user reviews it.
3. Offer **Text**, **Math**, and **Drawing / relationship** for each region.
   Apply TrOCR to text lines and UniMERNet to equations. Try automatic type
   suggestions only after measuring them against real handwritten notes; allow
   the user to override every suggestion.
4. Treat arrows and connectors as geometry, with a small detector for clear
   straight arrows. Preserve ambiguous drawings as an image or untouched ink.
   Do not infer causal or logical relationships from an arrow alone.
5. Assemble a Markdown preview in reading order: prose as ordinary text,
   equations as `$...$` or `$$...$$`, and reviewed arrows as Unicode `→`, `←`,
   or `↔` where appropriate. Keep a visible source-region link for each block
   during review. Never silently overwrite the original note.
6. Let the user edit, reorder, split, merge, or leave regions as ink before
   copying or inserting the result. On iPad, keep recognition on the laptop
   with the same authenticated local service; the review UI stays in Obsidian.

## Model decision and acceptance

Before enabling automatic whole-note parsing, compare the specialized
TrOCR + UniMERNet pipeline with a unified document model such as
[PaddleOCR-VL](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
on representative notes from the user's actual handwriting. Published document
benchmarks do not establish performance on pen-drawn notes. Measure text errors,
equation correctness, reading order, arrow false positives, CPU time and memory.
Prefer the smaller pipeline unless a unified model materially improves those
tests on this CPU-only laptop. The review UI must still allow corrections.

The first release should be considered text-line OCR, not complete diagram
understanding. A mixed page is done when the review output preserves the
arrangement and lets a person correct every uncertain block.

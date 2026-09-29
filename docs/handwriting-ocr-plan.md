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

## Whole-note review in beta.7

The command palette action **Transcribe all handwriting in this note** reads
the active Markdown note's saved pen ink, groups it into horizontal regions,
and shows the original crop for each region. Every region can be marked Text,
Math / LaTeX, or Drawing / keep as ink. Text uses the optional TrOCR service;
math uses the configured math provider. The user corrects each result and
edits the assembled Markdown before appending it to the same note. It appends
at the current end of the active editor, so existing text, image embeds, and
ink remain untouched. No region is silently omitted: a region must have a
reading or be explicitly marked keep as ink.

The grouping is geometric, not a trained page-layout model. Dense equations,
columns, arrows, and diagrams can be grouped imperfectly; the region type and
output must be reviewed. The command limits the note to 1,200 pen strokes,
120,000 ink points, 100 regions, and 25,000 points per region. Larger passages
can still be handled with lasso commands. On iPad, the configured laptop
service must be reachable over the network.

## Further work

1. Add region split/merge and reorder controls for columns, dense math, and
   unusual layouts. The current reading order is top-to-bottom.
2. Recognize clear arrows and connectors, but keep ambiguous relationships as
   ink until the user labels them. Do not infer logical meaning from a shape.
3. Compare model output on representative handwritten notes before suggesting
   text versus math automatically. Keep per-region manual override.

## Model decision and acceptance

Before adding automatic region-type suggestions, compare the specialized
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

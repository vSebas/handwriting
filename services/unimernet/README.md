# UniMERNet on your laptop

This optional Python service runs the official UniMERNet base model. The Obsidian
plugin renders selected pen paths as a cropped black-on-white PNG and sends only
that image to this service. The service returns LaTeX to the existing editable
preview. No cloud recognition account or per-conversion charge is needed.

## Windows setup

From the repository root, with [uv](https://docs.astral.sh/uv/getting-started/installation/)
installed (or the portable executable at `.tools/uv/uv.exe`):

```powershell
powershell -ExecutionPolicy Bypass -File services\unimernet\setup.ps1
```

Setup downloads Python 3.11, CPU PyTorch, UniMERNet 0.2.3 and the base model from
`wanderkid/unimernet_base` at revision `af898d48ebb1765cd3511d88f5d5f7c92279c731`.
Allow several GB of disk space. Downloads and the virtual environment are kept
under `.tools/`, outside your vault and ignored by Git. Keep that folder to run
the service; BRAT installs only the Obsidian client, not Python or model weights.

Once setup finishes, the **desktop Handwriting plugin starts the service when
Obsidian opens**. It looks for this repository under `Documents/handwriting`.
If you moved it, set **Handwriting → Handwriting to LaTeX → UniMERNet service
folder on laptop** to the repository folder. The plugin runs Python quietly,
waits for the model to load, and saves the service token to its settings. It
stops the child it started when the plugin unloads. Recognition can also start
the service again if it stopped.

For a manual run restricted to this laptop:

```powershell
powershell -ExecutionPolicy Bypass -File services\unimernet\start.ps1
```

For a manual run reachable by an iPad on your trusted local network:

```powershell
powershell -ExecutionPolicy Bypass -File services\unimernet\start.ps1 -Lan
```

The first start creates `.tools/unimernet-access-token.txt`. Desktop Handwriting
copies that token into its own settings automatically. Let your usual plugin
settings sync carry the token to the iPad, or copy it into the iPad settings
once yourself. Select **UniMERNet (local service)** on the iPad. For the laptop,
use `http://127.0.0.1:8765`. For iPad, use the laptop's Wi-Fi IPv4
address from `ipconfig`, such as `http://192.168.1.20:8765` (not `127.0.0.1` or
`0.0.0.0`). Press **Test connection**, then use the existing lasso conversion command.

Keep the laptop and desktop Obsidian open. If Windows Firewall asks,
allow Python on the private network you use with the iPad. No port forwarding is
needed. HTTP is intended for a trusted local network; use HTTPS or a trusted VPN
for remote access. The access token is stored in the plugin's `data.json`, so
syncing plugin settings copies it too. The plugin never sends ink until you press
**Recognize with UniMERNet**.

The model is loaded once per service run and processes one request at a time.
Closing the Obsidian dialog ignores the result, but an inference already running
on the laptop continues. The service rejects concurrent work instead of building
a queue. It does not save request images or recognized LaTeX. After setup, model
loading and recognition run offline.

## Optional handwritten text

After the Windows setup above, install the separate English text-line model:

```powershell
powershell -ExecutionPolicy Bypass -File services\unimernet\setup-text.ps1
```

This downloads a pinned [TrOCR handwritten-text model](https://huggingface.co/microsoft/trocr-base-handwritten)
to `.tools/trocr-base-handwritten`. It uses the existing Python environment and
authenticated service, but loads the text model only for a text request. Restart
desktop Obsidian after installing it. In Handwriting settings, press **Test text
connection** on the laptop and iPad. Lasso a short text line or paragraph and
run **Lasso: convert handwriting to text**. Review the editable result before
inserting or copying it. Equations still use the LaTeX command. Text recognition
does not interpret arrows or diagrams; the original ink is kept.

The model card describes single text-line images as its intended input. The
service divides clearly separated horizontal lines before recognition, but
crowded layouts may need separate lasso selections. Use the whole-note Codex
mode below for mixed content.

## Whole-note images with Codex

The **Transcribe all handwriting in this note** command sends the note's pen
ink as a picture to this same token-protected service. The default **Mixed
handwriting (Codex)** mode passes the picture to the Codex CLI already signed
in on the laptop. It reads prose, equations, and their visual arrangement in
one request and returns editable Obsidian Markdown. The service uses the
model in the laptop's `~/.codex/config.toml`; set
`HANDWRITING_CODEX_MODEL` in the service environment to override it. It does
not read or copy Codex credentials into the vault. On iPad, use the laptop URL
and token as above, and press **Test Codex connection** in Handwriting settings.

The plugin looks for `codex` on the laptop's PATH or in the current user's
standalone Codex installation. Sign in with `codex login` on the laptop if
necessary, then restart desktop Obsidian to restart the service. Each request
uses a temporary PNG, a read-only sandbox, and an ephemeral Codex session;
the temporary files are removed afterward. The selected image is sent to
OpenAI through the signed-in Codex CLI. Review all generated Markdown before
appending it. Existing Markdown text, pasted image embeds, and original ink
are untouched. See [the image-selection workflow](../../docs/handwriting-ocr-plan.md).

## Developer checks

```powershell
.\.tools\unimer-venv\Scripts\python.exe -m unittest discover -s services\unimernet -p test_server.py
.\.tools\unimer-venv\Scripts\python.exe services\unimernet\server.py --model-dir .tools\unimernet-base --token-file .tools\unimernet-access-token.txt --image C:\path\equation.png
```

Add `--invert` for a screenshot with white ink on a black background. Plugin
requests already render black on white. CPU latency and handwriting accuracy
depend on the expression; test representative samples before choosing a provider.

The upstream [UniMERNet code](https://github.com/opendatalab/UniMERNet) and
[model card](https://huggingface.co/wanderkid/unimernet_base) describe the model.
This service uses its model class and evaluation processor directly.

## Local trial result

On the supplied handwritten Gaussian-expression screenshot, the CPU base model
returned `p_{a} \frac{1}{\sqrt{2\pi\sigma^{2}}} e^{-(y-a)^{2}/2\sigma^{2}}`
in about 4 seconds after loading. It recovered the fraction, radical and exponent
grouping that Hand-to-TeX missed, but read uppercase `P` as lowercase `p`.
This is one sample, not a benchmark. The real HTTP smoke test reproduced this
result with external socket connections blocked.

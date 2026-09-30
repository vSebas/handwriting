"""Whole-note image transcription through the user's signed-in Codex CLI.

The iPad sends an ink-only PNG to the existing token-protected laptop service.
Codex receives that temporary image and returns Markdown; no vault path or
Markdown body is made available to the model.
"""

from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib


PROMPT = """Transcribe the attached image(s) of handwritten notes into Obsidian Markdown.
If multiple images are attached, the first is an overview and the rest are
overlapping detail tiles in top-to-bottom, then left-to-right order. Use the
detail tiles to read small writing and the overview to understand layout.
Transcribe overlapping writing only once. Preserve all legible prose.
Write equations as valid LaTeX in $...$ or $$...$$. Preserve arrows and clear
relationships as symbols or concise labels, but do not invent relationships.
If a word or formula is uncertain, mark the uncertain part as [unclear] rather
than guessing. Do not describe the task, add a preface, or wrap the result in a
code fence. Do not use tools or access any files beyond the attached image.
Return only the Markdown transcription."""


def _version(path):
    numbers = re.findall(r"\d+", path.parent.parent.name)
    return tuple(int(part) for part in numbers[:3])


def find_codex():
    """Find a normal PATH install or the current user's standalone Codex app."""
    found = shutil.which("codex") or shutil.which("codex.exe")
    if found:
        return Path(found)
    releases = Path.home() / ".codex" / "packages" / "standalone" / "releases"
    candidates = list(releases.glob("*/bin/codex.exe"))
    return max(candidates, key=_version) if candidates else None


def configured_model():
    """Use the same Codex model configured for this user's CLI, never credentials."""
    config = Path.home() / ".codex" / "config.toml"
    try:
        value = tomllib.loads(config.read_text(encoding="utf-8")).get("model")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]+", value) else None


def load_codex_recognizer():
    """Return a lazy image recognizer and model name when Codex is signed in."""
    binary = find_codex()
    if binary is None:
        return None, None
    try:
        status = subprocess.run([str(binary), "login", "status"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    if status.returncode != 0:
        return None, None
    model = configured_model()

    def recognize(images):
        with tempfile.TemporaryDirectory(prefix="handwriting-codex-") as directory:
            folder = Path(directory)
            output_path = folder / "transcription.md"
            args = [str(binary), "exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
                    "--ignore-user-config", "-C", str(folder),
                    "--output-last-message", str(output_path)]
            for index, image in enumerate(images):
                image_path = folder / f"handwriting-{index + 1}.png"
                image.save(image_path, format="PNG")
                args.extend(["--image", str(image_path)])
            if model:
                args.extend(["--model", model])
            args.append(PROMPT)
            try:
                result = subprocess.run(args, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        timeout=240, check=False)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("Codex took too long. Try a smaller image selection.") from error
            if result.returncode != 0 or not output_path.is_file():
                raise RuntimeError("Codex could not transcribe the image. Check its laptop sign-in and model access.")
            markdown = output_path.read_text(encoding="utf-8").strip()
            if not markdown or len(markdown) > 100_000:
                raise RuntimeError("Codex returned an empty or oversized transcription.")
            return markdown

    return recognize, model or "Codex default"

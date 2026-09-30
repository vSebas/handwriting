import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from note_ocr import load_codex_recognizer


class CodexNoteTests(unittest.TestCase):
    @patch("note_ocr.find_codex", return_value=None)
    def test_unavailable_cli_does_not_disable_other_recognizers(self, _find):
        self.assertEqual(load_codex_recognizer(), (None, None))

    @patch("note_ocr.configured_model", return_value="gpt-test")
    @patch("note_ocr.find_codex", return_value=Path("codex.exe"))
    def test_sends_only_temp_image_to_read_only_ephemeral_codex(self, _find, _model):
        runs = []
        def run(args, **options):
            runs.append((args, options))
            if args[1] == "exec":
                self.assertTrue(Path(args[args.index("--image") + 1]).is_file())
                Path(args[args.index("--output-last-message") + 1]).write_text("Text with $x^2$", encoding="utf-8")
            return SimpleNamespace(returncode=0)
        with patch("note_ocr.subprocess.run", side_effect=run):
            recognize, model = load_codex_recognizer()
            self.assertEqual(model, "gpt-test")
            self.assertEqual(recognize([Image.new("RGB", (20, 20), "white")]), "Text with $x^2$")
        args = runs[1][0]
        self.assertEqual(args[1], "exec")
        for option in ("--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check"):
            self.assertIn(option, args)
        self.assertEqual(args[args.index("--model") + 1], "gpt-test")
        self.assertFalse(Path(args[args.index("--image") + 1]).exists())
        self.assertIs(runs[1][1]["stdin"], subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()

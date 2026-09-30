"""Local recognition bridge. Codex note requests send selected ink to OpenAI."""
import argparse
import base64
import binascii
import hmac
import io
import json
import os
from pathlib import Path
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 4 * 1024 * 1024
MAX_NOTE_BODY = 12 * 1024 * 1024


def decode_image(body):
    from PIL import Image
    value = json.loads(body)
    data = value.get("image") if isinstance(value, dict) else None
    if not isinstance(data, str) or not data.startswith("data:image/png;base64,"):
        raise ValueError("Expected a PNG data URL.")
    try:
        raw = base64.b64decode(data.split(",", 1)[1], validate=True)
        image = Image.open(io.BytesIO(raw))
        if image.format != "PNG" or image.width * image.height > 8_000_000:
            raise ValueError("Image exceeds the supported size or format.")
        image.load()
        # Flatten transparent PNGs onto white rather than black.
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        return Image.alpha_composite(background, rgba).convert("RGB")
    except (binascii.Error, OSError) as error:
        raise ValueError("Invalid PNG image.") from error


def decode_note_images(body):
    value = json.loads(body)
    images = value.get("images") if isinstance(value, dict) else None
    if not isinstance(images, list) or not 1 <= len(images) <= 9:
        raise ValueError("Expected one to nine handwriting images.")
    decoded = [decode_image(json.dumps({"image": data})) for data in images]
    if sum(image.width * image.height for image in decoded) > 16_000_000:
        raise ValueError("Handwriting images exceed the supported size.")
    return decoded


def load_recognizer(model_dir, device="cpu"):
    # Never fetch weights as a side effect of recognizing someone's ink.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"
    # A bundled Windows wcwidth C extension can hang while importing through
    # ftfy; its pure-Python implementation is sufficient for token cleanup.
    os.environ["WCWIDTH_PYTHON"] = "1"
    os.environ.setdefault("HF_HOME", str(Path(model_dir).resolve().parent / "hf-cache"))
    os.environ.setdefault("MPLCONFIGDIR", str(Path(model_dir).resolve().parent / "matplotlib-cache"))
    print("UniMERNet: importing PyTorch", flush=True)
    import torch
    from omegaconf import OmegaConf
    print("UniMERNet: importing model code", flush=True)
    from unimernet.models.unimernet.unimernet import UniMERModel
    from unimernet.processors import load_processor

    folder = Path(model_dir).resolve()
    checkpoint = folder / "pytorch_model.pth"
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Run setup first: missing {checkpoint}")
    # Use the official model and evaluation processor, including its own
    # aspect-ratio handling and normalization. No independently reimplemented OCR.
    cfg = OmegaConf.create({
        "model_config": {"model_name": str(folder), "max_seq_len": 1536},
        "tokenizer_config": {"path": str(folder)},
        "load_pretrained": True,
        "pretrained": str(checkpoint),
    })
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    print("UniMERNet: loading model weights", flush=True)
    model = UniMERModel.from_config(cfg).to(device).eval()
    print("UniMERNet: preparing image processor", flush=True)
    processor = load_processor("formula_image_eval", OmegaConf.create({"image_size": [192, 672]}))

    def recognize(image):
        with torch.inference_mode():
            tensor = processor(image).unsqueeze(0).to(device)
            output = model.generate({"image": tensor})
            latex = output["pred_str"][0].strip()
            if not latex:
                raise ValueError("No expression recognized.")
            return latex
    return recognize


def make_server(host, port, token, recognize, recognize_text=None, recognize_note=None, note_model=None):
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, fmt, *args):
            pass  # Do not log handwriting, paths or access tokens.

        def reply(self, status, value):
            data = json.dumps(value).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def authorized(self):
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied.encode(), f"Bearer {token}".encode()):
                self.reply(401, {"error": "Invalid access token."})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != "/health":
                self.reply(404, {"error": "Unknown endpoint."})
                return
            self.reply(200, {"provider": "unimernet", "ready": True,
                             "text_ready": recognize_text is not None,
                             "note_ready": recognize_note is not None,
                             "note_model": note_model if recognize_note is not None else None})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path not in ("/recognize", "/recognize-text", "/recognize-note"):
                self.reply(404, {"error": "Unknown endpoint."})
                return
            if self.path == "/recognize-text" and recognize_text is None:
                self.reply(503, {"error": "Install the optional handwritten-text model first."})
                return
            if self.path == "/recognize-note" and recognize_note is None:
                self.reply(503, {"error": "Sign in to Codex on the laptop and restart the service."})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = 0
            limit = MAX_NOTE_BODY if self.path == "/recognize-note" else MAX_BODY
            if not 0 < size <= limit:
                self.reply(413, {"error": "Invalid request size."})
                return
            if not busy.acquire(blocking=False):
                self.reply(429, {"error": "Recognition already running."})
                return
            try:
                try:
                    body = self.rfile.read(size)
                    image = decode_note_images(body) if self.path == "/recognize-note" else decode_image(body)
                except (ValueError, TypeError):
                    self.reply(400, {"error": "Invalid image request."})
                    return
                if self.path == "/recognize-text":
                    self.reply(200, {"text": recognize_text(image)})
                elif self.path == "/recognize-note":
                    self.reply(200, {"markdown": recognize_note(image)})
                else:
                    self.reply(200, {"latex": recognize(image)})
            except Exception as error:
                # Only the exception type is logged; payloads stay in memory.
                print(f"Recognition failed: {type(error).__name__}", flush=True)
                self.reply(500, {"error": "Recognition failed. Check the service window."})
            finally:
                busy.release()

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--text-model-dir", help="Optional local TrOCR model folder")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--image", help="Recognize a local image once instead of starting the server")
    parser.add_argument("--invert", action="store_true", help="Invert a white-on-black --image before recognition")
    args = parser.parse_args()
    print("Loading UniMERNet base...", flush=True)
    recognize = load_recognizer(args.model_dir, args.device)
    recognize_text = None
    if args.text_model_dir and (Path(args.text_model_dir) / "model.safetensors").is_file():
        from text_ocr import load_text_recognizer
        recognize_text = load_text_recognizer(args.text_model_dir)
    from note_ocr import load_codex_recognizer
    recognize_note, note_model = load_codex_recognizer()
    if args.image:
        from PIL import Image, ImageOps
        import time
        image = Image.open(args.image).convert("RGB")
        if args.invert:
            image = ImageOps.invert(image)
        started = time.monotonic()
        print(json.dumps({"latex": recognize(image), "seconds": round(time.monotonic() - started, 2)}), flush=True)
        return
    token_path = Path(args.token_file)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
    token = token_path.read_text(encoding="utf-8").strip()
    if len(token) < 24:
        raise ValueError("Token must contain at least 24 characters.")
    server = make_server(args.host, args.port, token, recognize, recognize_text, recognize_note, note_model)
    print(f"Ready on {args.host}:{args.port}. Access token file: {token_path.resolve()}", flush=True)
    print("Keep this window open. Ctrl+C stops the service.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

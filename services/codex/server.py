"""Token-protected local bridge from Obsidian to the signed-in Codex CLI."""
import argparse
import base64
import binascii
import hmac
import io
import json
from pathlib import Path
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from note_ocr import load_codex_recognizer

MAX_BODY = 12 * 1024 * 1024


def decode_request(body):
    from PIL import Image
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("Expected a request object.")
    images = value.get("images")
    if not isinstance(images, list) or not 1 <= len(images) <= 9:
        raise ValueError("Expected one to nine images.")
    decoded = []
    for data in images:
        if not isinstance(data, str) or not data.startswith("data:image/png;base64,"):
            raise ValueError("Expected PNG data URLs.")
        try:
            raw = base64.b64decode(data.split(",", 1)[1], validate=True)
            image = Image.open(io.BytesIO(raw))
            if image.format != "PNG" or image.width * image.height > 8_000_000:
                raise ValueError("Image exceeds supported size or format.")
            image.load()
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            decoded.append(Image.alpha_composite(background, rgba).convert("RGB"))
        except (binascii.Error, OSError) as error:
            raise ValueError("Invalid PNG image.") from error
    if sum(image.width * image.height for image in decoded) > 16_000_000:
        raise ValueError("Handwriting images exceed supported size.")
    return decoded


def make_server(host, port, token, recognize, model):
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, fmt, *args):
            pass  # Never log handwriting or tokens.

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
            self.reply(200, {"provider": "codex", "ready": recognize is not None, "model": model})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/recognize-note":
                self.reply(404, {"error": "Unknown endpoint."})
                return
            if recognize is None:
                self.reply(503, {"error": "Sign in to Codex on the laptop and restart the service."})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = 0
            if not 0 < size <= MAX_BODY:
                self.reply(413, {"error": "Invalid request size."})
                return
            if not busy.acquire(blocking=False):
                self.reply(429, {"error": "Recognition already running."})
                return
            try:
                try:
                    images = decode_request(self.rfile.read(size))
                except (ValueError, TypeError):
                    self.reply(400, {"error": "Invalid image or model request."})
                    return
                self.reply(200, {"markdown": recognize(images)})
            except Exception as error:
                print(f"Recognition failed: {type(error).__name__}", flush=True)
                self.reply(500, {"error": "Recognition failed. Check the service window."})
            finally:
                busy.release()

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", required=True)
    args = parser.parse_args()
    recognize, model = load_codex_recognizer()
    token_path = Path(args.token_file)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
    token = token_path.read_text(encoding="utf-8").strip()
    if len(token) < 24:
        raise ValueError("Token must contain at least 24 characters.")
    server = make_server(args.host, args.port, token, recognize, model)
    print(f"Codex service ready on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

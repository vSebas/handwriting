"""Test the real model through the HTTP bridge using a local image, offline."""
import argparse
import base64
import io
import json
import socket
import threading
import time
from urllib.request import Request, urlopen
from PIL import Image, ImageOps
from server import load_recognizer, make_server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--invert", action="store_true")
    args = parser.parse_args()
    # Fail if imports, model loading or inference attempt any external connection.
    original_connect = socket.socket.connect
    def local_connect(sock, address):
        if address[0] not in ("127.0.0.1", "::1"):
            raise RuntimeError("External network request blocked by smoke test")
        return original_connect(sock, address)
    socket.socket.connect = local_connect
    model = load_recognizer(args.model_dir)
    service = make_server("127.0.0.1", 0, "smoke-test-only", model)
    worker = threading.Thread(target=service.serve_forever, daemon=True)
    worker.start()
    try:
        url = f"http://127.0.0.1:{service.server_port}"
        headers = {"Authorization": "Bearer smoke-test-only", "Content-Type": "application/json"}
        with urlopen(Request(url + "/health", headers=headers), timeout=10) as response:
            assert json.load(response) == {"provider": "unimernet", "ready": True}
        image = Image.open(args.image).convert("RGB")
        if args.invert:
            image = ImageOps.invert(image)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        body = json.dumps({"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}).encode()
        started = time.monotonic()
        with urlopen(Request(url + "/recognize", data=body, headers=headers), timeout=180) as response:
            result = json.load(response)
        assert isinstance(result.get("latex"), str) and result["latex"].strip()
        print(json.dumps({**result, "seconds": round(time.monotonic() - started, 2), "external_network": "blocked"}), flush=True)
    finally:
        service.shutdown()
        service.server_close()
        worker.join()
        socket.socket.connect = original_connect


if __name__ == "__main__":
    main()

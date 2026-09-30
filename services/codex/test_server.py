import base64
import io
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from PIL import Image
from server import make_server


def image_url():
    buffer = io.BytesIO()
    Image.new("RGBA", (30, 20), (0, 0, 0, 0)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


class CodexServiceTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def recognize(images):
            self.calls.append(images)
            return "A note with $x^2$"
        self.server = make_server("127.0.0.1", 0, "test-token", recognize, "gpt-test")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, token="test-token"):
        req = Request(self.url + path, data=body, headers={"Authorization": "Bearer " + token})
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_transcribes_mixed_markdown_and_reports_model(self):
        self.assertEqual(self.request("/health"), (200, {"provider": "codex", "ready": True, "model": "gpt-test"}))
        body = json.dumps({"images": [image_url()]}).encode()
        self.assertEqual(self.request("/recognize-note", body), (200, {"markdown": "A note with $x^2$"}))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0].getpixel((0, 0)), (255, 255, 255))

    def test_rejects_bad_tokens_and_legacy_endpoints(self):
        body = json.dumps({"images": [image_url()]}).encode()
        self.assertEqual(self.request("/recognize-note", body, "wrong")[0], 401)
        self.assertEqual(self.request("/recognize", body)[0], 404)
        self.assertEqual(self.request("/recognize-text", body)[0], 404)
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_payload(self):
        for body in [b"{}", b"[]", b"invalid", json.dumps({"images": ["bad"]}).encode()]:
            self.assertEqual(self.request("/recognize-note", body)[0], 400)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

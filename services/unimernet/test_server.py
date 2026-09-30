import base64
import io
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from PIL import Image
from server import decode_image, make_server


def image_body():
    buffer = io.BytesIO()
    Image.new("RGBA", (30, 20), (0, 0, 0, 0)).save(buffer, format="PNG")
    return json.dumps({"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}).encode()


def note_body():
    return json.dumps({"images": [json.loads(image_body())["image"]]}).encode()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def recognize(image):
            self.calls.append(image)
            return r"\frac{1}{2}"
        def recognize_text(image):
            self.calls.append(image)
            return "handwritten text"
        def recognize_note(image):
            self.calls.append(image)
            return "A note with $x^2$"
        self.server = make_server("127.0.0.1", 0, "test-token", recognize, recognize_text,
                                  recognize_note, "gpt-test")
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

    def test_health_and_recognition(self):
        self.assertEqual(self.request("/health"), (200, {"provider": "unimernet", "ready": True,
                                                        "text_ready": True, "note_ready": True,
                                                        "note_model": "gpt-test"}))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.request("/recognize", image_body()), (200, {"latex": r"\frac{1}{2}"}))
        self.assertEqual(self.calls[0].getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(self.request("/recognize-text", image_body()), (200, {"text": "handwritten text"}))
        self.assertEqual(self.request("/recognize-note", note_body()), (200, {"markdown": "A note with $x^2$"}))
        self.assertEqual(len(self.calls[-1]), 1)

    def test_authorization_before_processing(self):
        self.assertEqual(self.request("/recognize", image_body(), "wrong")[0], 401)
        self.assertEqual(self.request("/health", token="wrong")[0], 401)
        self.assertEqual(self.calls, [])

    def test_bad_payloads_do_not_run_model(self):
        for body in [b"invalid", b"{}", b"[]", b'{"image":"data:image/png;base64,@@@@"}']:
            self.assertEqual(self.request("/recognize", body)[0], 400)
        self.assertEqual(self.request("/unknown", image_body())[0], 404)
        self.assertEqual(self.calls, [])

    def test_large_payload_rejected(self):
        req = Request(self.url + "/recognize", data=b"{}", headers={"Authorization": "Bearer test-token", "Content-Length": "5000000"})
        with self.assertRaises(HTTPError) as caught:
            urlopen(req, timeout=5)
        self.assertEqual(caught.exception.code, 413)

    def test_image_dimensions_bounded(self):
        buffer = io.BytesIO()
        Image.new("L", (3000, 3000), 255).save(buffer, format="PNG")
        with self.assertRaises(ValueError):
            decode_image(json.dumps({"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}))

    def test_text_endpoint_requires_an_installed_model(self):
        other = make_server("127.0.0.1", 0, "test-token", lambda image: "x")
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        old_url = self.url
        self.url = f"http://127.0.0.1:{other.server_port}"
        try:
            self.assertEqual(self.request("/health")[1]["text_ready"], False)
            self.assertEqual(self.request("/health")[1]["note_ready"], False)
            self.assertEqual(self.request("/recognize-text", image_body())[0], 503)
            self.assertEqual(self.request("/recognize-note", note_body())[0], 503)
        finally:
            self.url = old_url
            other.shutdown()
            other.server_close()
            thread.join()

    def test_busy_service_rejects_duplicates_and_recovers(self):
        entered, release = threading.Event(), threading.Event()
        def model(image):
            entered.set()
            release.wait(5)
            return "x"
        other = make_server("127.0.0.1", 0, "test-token", model)
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        self.url = f"http://127.0.0.1:{other.server_port}"
        first_result = []
        first = threading.Thread(target=lambda: first_result.append(self.request("/recognize", image_body())))
        first.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.request("/recognize", image_body())[0], 429)
            release.set()
            first.join(5)
            self.assertEqual(first_result, [(200, {"latex": "x"})])
            self.assertEqual(self.request("/recognize", image_body())[0], 200)
        finally:
            release.set()
            first.join(5)
            other.shutdown()
            other.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()

import unittest
from PIL import Image, ImageDraw
from text_ocr import text_lines


class TextLineTests(unittest.TestCase):
    def test_separates_two_handwritten_lines_in_reading_order(self):
        image = Image.new("RGB", (240, 120), "white")
        draw = ImageDraw.Draw(image)
        draw.line((20, 22, 180, 25), fill="black", width=3)
        draw.line((25, 80, 200, 84), fill="black", width=3)
        lines = text_lines(image)
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(line.width < image.width for line in lines))

    def test_blank_selection_has_no_lines(self):
        self.assertEqual(text_lines(Image.new("RGB", (100, 100), "white")), [])


if __name__ == "__main__":
    unittest.main()

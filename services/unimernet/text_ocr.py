"""Optional, offline English handwriting OCR using Microsoft's TrOCR model."""
import os
from pathlib import Path


def text_lines(image):
    """Crop horizontal handwriting lines; preserve their top-to-bottom order."""
    gray = image.convert("L")
    width, height = gray.size
    pixels = gray.load()
    dark = [sum(pixels[x, y] < 210 for x in range(width)) for y in range(height)]
    threshold = max(2, width // 400)
    rows = [y for y, count in enumerate(dark) if count >= threshold]
    if not rows:
        return []
    bands = []
    start = end = rows[0]
    min_gap = max(8, min(24, height // 60))
    for y in rows[1:]:
        if y - end <= min_gap:
            end = y
        else:
            bands.append((start, end))
            start = end = y
    bands.append((start, end))
    if len(bands) > 24:
        raise ValueError("Select at most 24 handwritten lines at a time.")
    result = []
    for top, bottom in bands:
        top = max(0, top - 6)
        bottom = min(height, bottom + 7)
        columns = [x for x in range(width) if any(pixels[x, y] < 210 for y in range(top, bottom))]
        if not columns:
            continue
        left = max(0, columns[0] - 8)
        right = min(width, columns[-1] + 9)
        result.append(image.crop((left, top, right, bottom)))
    return result


def load_text_recognizer(model_dir):
    """Load lazily, so math-only users do not pay the TrOCR memory/startup cost."""
    folder = Path(model_dir).resolve()
    if not (folder / "model.safetensors").is_file():
        raise FileNotFoundError(f"Run text setup first: missing {folder / 'model.safetensors'}")
    model = processor = None

    def recognize(image):
        nonlocal model, processor
        if model is None:
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            import torch
            from transformers import TrOCRProcessor, VisionEncoderDecoderModel
            processor = TrOCRProcessor.from_pretrained(folder, local_files_only=True)
            model = VisionEncoderDecoderModel.from_pretrained(folder, local_files_only=True).eval()
            torch.set_num_threads(min(8, os.cpu_count() or 1))
        lines = text_lines(image)
        if not lines:
            raise ValueError("No handwriting found in the selection.")
        import torch
        output = []
        with torch.inference_mode():
            for line in lines:
                pixels = processor(images=line, return_tensors="pt").pixel_values
                generated = model.generate(pixels, max_new_tokens=128)
                output.append(processor.batch_decode(generated, skip_special_tokens=True)[0].strip())
        text = "\n".join(line for line in output if line)
        if not text:
            raise ValueError("No text recognized.")
        return text

    return recognize

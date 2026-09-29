"""Explicit one-time download of the English handwriting OCR model."""
import argparse
from huggingface_hub import snapshot_download

MODEL_REPO = "microsoft/trocr-base-handwritten"
MODEL_REVISION = "eaacaf452b06415df8f10bb6fad3a4c11e609406"

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    snapshot_download(
        MODEL_REPO, revision=MODEL_REVISION, local_dir=args.model_dir,
        allow_patterns=["*.json", "*.txt", "model.safetensors"], max_workers=2,
    )
    print("TrOCR handwritten-text download complete.")

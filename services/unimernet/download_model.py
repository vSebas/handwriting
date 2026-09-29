"""Explicit one-time download; inference never downloads model files."""
import argparse
from huggingface_hub import snapshot_download

MODEL_REPO = "wanderkid/unimernet_base"
MODEL_REVISION = "af898d48ebb1765cd3511d88f5d5f7c92279c731"

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    snapshot_download(MODEL_REPO, revision=MODEL_REVISION, local_dir=args.model_dir,
                      allow_patterns=["*.json", "pytorch_model.pth", "README.md"], max_workers=2)
    print("UniMERNet base download complete.")

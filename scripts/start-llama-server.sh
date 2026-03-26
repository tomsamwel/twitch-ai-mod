#!/usr/bin/env bash
# Start llama-server with KV cache checkpointing for qwen3:4b-instruct.
# Requires: brew install llama.cpp
#
# Usage:
#   ./scripts/start-llama-server.sh                  # default model
#   ./scripts/start-llama-server.sh <model-tag>      # e.g. qwen3:4b-instruct

set -euo pipefail

MODEL_TAG="${1:-qwen3:4b-instruct}"
PORT="${LLAMA_SERVER_PORT:-8081}"
CTX_SIZE="${LLAMA_CTX_SIZE:-2048}"
CHECKPOINT_EVERY="${LLAMA_CHECKPOINT_EVERY:-256}"

# Resolve the GGUF blob from Ollama's local storage.
MANIFEST_DIR="$HOME/.ollama/models/manifests/registry.ollama.ai/library"
TAG_DIR=$(echo "$MODEL_TAG" | tr ':' '/')
MANIFEST="$MANIFEST_DIR/$TAG_DIR"

if [ ! -f "$MANIFEST" ]; then
  echo "error: model manifest not found at $MANIFEST" >&2
  echo "hint:  run 'ollama pull $MODEL_TAG' first to download the model" >&2
  exit 1
fi

# Extract the model layer digest (the GGUF blob, not the config blob).
# The model layer has mediaType "application/vnd.ollama.image.model".
DIGEST=$(python3 -c "
import json, sys
with open('$MANIFEST') as f:
    m = json.load(f)
for layer in m['layers']:
    if 'model' in layer['mediaType']:
        print(layer['digest'])
        break
")
# Ollama stores blobs with dashes instead of colons in the digest.
BLOB_PATH="$HOME/.ollama/models/blobs/$(echo "$DIGEST" | tr ':' '-')"

if [ ! -f "$BLOB_PATH" ]; then
  echo "error: model blob not found at $BLOB_PATH" >&2
  exit 1
fi

if ! command -v llama-server &>/dev/null; then
  echo "error: llama-server not found. Install with: brew install llama.cpp" >&2
  exit 1
fi

echo "Starting llama-server on port $PORT"
echo "  model:      $MODEL_TAG"
echo "  blob:       $BLOB_PATH"
echo "  ctx_size:   $CTX_SIZE"
echo "  checkpoint:  every $CHECKPOINT_EVERY tokens"
echo ""

exec llama-server \
  -m "$BLOB_PATH" \
  --port "$PORT" \
  -c "$CTX_SIZE" \
  -ngl 999 \
  --checkpoint-every-n-tokens "$CHECKPOINT_EVERY"

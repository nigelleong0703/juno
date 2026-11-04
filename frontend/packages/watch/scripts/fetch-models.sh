#!/bin/sh
# The CoreML voice models (not committed; Smart Turn is 16.7 MB). Run once before building. Their licenses are committed in Models/LICENSE-*.txt.
#  - Silero VAD v6.2.1, MIT (https://huggingface.co/aufklarer/Silero-VAD-v6.2.1-CoreML, from snakers4/silero-vad)
#  - Smart Turn v3.2, BSD-2-Clause, (c) Daily (https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML, from pipecat-ai/smart-turn)
set -eu
cd "$(dirname "$0")/.."
fetch() { # repo model files...
  repo=$1; model=$2; shift 2
  for f in "$@"; do
    mkdir -p "Models/$model.mlmodelc/$(dirname "$f")"
    curl -sfL "https://huggingface.co/$repo/resolve/main/$model.mlmodelc/$f" -o "Models/$model.mlmodelc/$f"
  done
}
fetch aufklarer/Silero-VAD-v6.2.1-CoreML silero_vad analytics/coremldata.bin coremldata.bin metadata.json model.mil weights/weight.bin
fetch aufklarer/Smart-Turn-v3.2-CoreML smart_turn analytics/coremldata.bin coremldata.bin model.mil weights/weight.bin
curl -sfL https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML/resolve/main/LICENSE -o Models/LICENSE-smart-turn.txt

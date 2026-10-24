#!/usr/bin/env bash
# Shrinks raw Tripo3D exports (~1M triangles, 4K textures) into web-ready models/*.glb.
# Usage: ./optimize-models.sh   (run from this folder; needs Node 18+)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models
GT="npx --yes @gltf-transform/cli@4.1.1"

opt() { # <source.glb> <name> <simplify ratio, 1 = keep all> <texture size>
  [ -f "$1" ] || { echo "skip: $1 not found"; return; }
  $GT optimize "$1" "models/$2.glb" \
    --simplify-ratio "$3" --simplify-error 0.002 \
    --texture-size "$4" --texture-compress webp --compress meshopt
}

opt "stylized_tree_3d_model.glb"       tree   1 2048
opt "stylized shrub 3d model.glb"      bush   0.08 1024
opt "pink_fuzzy_flower_3d_model_1.glb" flower 1 2048
opt "cloud_3d_model.glb"               cloud  1 1024
echo "Done. Optimized models are in ./models"

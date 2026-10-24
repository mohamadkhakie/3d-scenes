# Golden Meadow

A real-time three.js sunrise meadow. The grass, hill turf and lighting are procedural (shell-fur shaders, bloom, depth of field). The trees, shrubs, flowers and clouds are Tripo3D models.

## Run it

Browsers block loading `.glb` files from `file://`, so serve the folder:

```bash
cd ~/Desktop/dom
npx serve .            # or: python3 -m http.server 8000
```

Then open the printed address (for example http://localhost:3000).

The scene plays a seamless 8-second loop modelled on the reference clip: clouds drift and bob, trees sway and breathe, flowers nod, the grass ripples and the camera drifts slightly for parallax. Every motion uses whole-number multiples of one phase, so the end of the loop meets the start exactly (`LOOP` and `animate()` in `main.js`).

The scene renders at exactly 941 × 1672 (the reference image size) with a fixed camera matched to the reference, and scales to fit the window. There is no on-screen UI.

To compare against the reference, add one of these to the address: `#overlay` (reference at 50% on top), `#split` (reference on the right half), `#splitr` (reference on the left half) or `#ref` (reference only). Reload after changing it.

## Post-processing (realism-effects)

The render goes through [realism-effects](https://github.com/0beqz/realism-effects) on top of the [postprocessing](https://github.com/pmndrs/postprocessing) composer:

| Effect | Default | What it does here |
| --- | --- | --- |
| SSGI | on | Screen-space global illumination: sky and neighbouring surfaces bounce soft light into the scene |
| HBAO | on (subtle) | Contact shadows where bushes, trees and flowers meet the grass |
| TRAA | on | Temporal anti-aliasing, smooths the fine grass strands |
| Motion blur | on | Per-object motion blur (only visible if the camera or objects move) |
| SSR | off | Screen-space reflections; the scene is fully matte, so it adds little |
| SSAO | off | Alternative to HBAO |

After those come the custom depth of field, bloom and a light grain.

Switch effects from the address bar and reload: `#fx-ssr`, `#fx-ssao`, `#no-ssgi`, `#no-hbao`, `#no-traa`, `#no-motionblur`, `#no-dof`. Join several with dots, for example `#no-hbao.fx-ssao` or `#fx-ssr.split`. Add `debug` (e.g. `#debug`) to show any console errors on the page.

Versions are pinned to what realism-effects 1.1.2 (its latest npm release, May 2023) was built against: three.js 0.152.2 and postprocessing 6.31.2. Newer three.js releases changed APIs it relies on.

Notes on how it is wired, in `main.js`:

- TRAA jitters the camera through `setViewOffset`, so the reference's off-centre horizon is built into the projection matrix instead (`camera.updateProjectionMatrix` override).
- SSGI and the velocity pass re-render the scene with their own materials. The custom grass/hill shaders carry a `.color` hint for them, and only one fur layer is drawn in those passes.
- `GI_ALBEDO` and `AMBIENT` balance SSGI's bounce light against the shaders' own ambient term; `giOptions` holds the SSGI settings.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page shell |
| `reference.png` | Your reference image, used only by the comparison modes |
| `main.js` | The scene: sky, fur grass and hills, realism-effects post-processing, model loading |
| `models/*.glb` | Optimized Tripo3D models the scene loads (tree, bush, flower, cloud) |
| `*.glb` in this folder | Your original Tripo3D exports (untouched). Trees use `stylized_tree_3d_model.glb`, bushes `stylized shrub 3d model.glb` (with the fur layer), flowers `pink_fuzzy_flower_3d_model_1.glb`, clouds `cloud_3d_model.glb` |
| `optimize-models.sh` | Rebuilds `models/` from the originals |
| `tripo-generate.mjs` | Generates new models through the Tripo3D API |

## Swapping models

- Replace an original export in this folder and run `./optimize-models.sh`, or save an already-optimized file as `models/<name>.glb`.

The raw Tripo exports are about 1 million triangles each, and the scene shows 13 copies. Always run them through `optimize-models.sh` (it cuts them to 50–100k triangles and 1024px WebP textures) or the page will stutter.

## Tuning

In `main.js`:

- `PLACES` positions every tree, bush, flower and cloud by the pixel it covers in the reference plus its distance from the camera.
- `HILLS` and `FAR` trace each hill's ridge line in reference pixels; the meshes are solved so their outlines land on those lines.
- `F`, `HZ` and `EYE` are the camera's focal length (px), horizon row (px) and height.
- `stylize()` gives trees, bushes and clouds the reference's soft look (sage tone, darker underside, warm backlit rim); each call's options set the tint and rim strength.
- The `DofEffect` uniforms `uFocus` and `uK` set the focus distance and blur strength.

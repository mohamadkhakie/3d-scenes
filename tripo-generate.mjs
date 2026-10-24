// Generate the Golden Meadow props with Tripo3D and save them as .glb files.
//
// Usage (Node 18+):
//   TRIPO_API_KEY=tsk_xxx node tripo-generate.mjs            # all four assets
//   TRIPO_API_KEY=tsk_xxx node tripo-generate.mjs tree flower # only some
//
// Output: ./models/tree.glb, bush.glb, flower.glb, cloud.glb
// Then drop those files onto the Golden Meadow page. File names decide which objects they replace.

import { mkdir, writeFile } from 'node:fs/promises';

const KEY = process.env.TRIPO_API_KEY;
if (!KEY) { console.error('Set TRIPO_API_KEY (get one at platform.tripo3d.ai).'); process.exit(1); }

const API = 'https://api.tripo3d.ai/v2/openapi';
const OUT = './models';

// Shared style suffix keeps all four assets in the same soft, clay-like world as the reference.
const STYLE = 'soft stylized 3D render, matte velvety materials, rounded chunky forms, cozy miniature diorama look, pastel sunrise palette, single object, no base, no ground plane';

const ASSETS = {
  tree:   `a round topiary tree, perfectly spherical canopy made of dense tiny fluffy leaf clusters, sage and olive green, short thick maroon-brown trunk, ${STYLE}`,
  bush:   `a low dome-shaped shrub, dense tiny fluffy leaf clusters, dark sage green, ${STYLE}`,
  flower: `a single cute pink flower with five puffy rounded petals, glowing pale yellow center, short green stem with one small leaf, ${STYLE}`,
  cloud:  `a small puffy cartoon cloud made of four soft round blobs, peach-white, ${STYLE}`,
};

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== 0) throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(name, prompt) {
  console.log(`[${name}] submitting…`);
  const { task_id } = await api('/task', {
    method: 'POST',
    body: JSON.stringify({
      type: 'text_to_model',
      prompt,
      texture: true,
      pbr: true,
      // Optional knobs, depending on your plan / API version:
      // texture_quality: 'detailed',
      // face_limit: 40000,
    }),
  });

  for (;;) {
    await sleep(5000);
    const t = await api(`/task/${task_id}`);
    process.stdout.write(`\r[${name}] ${t.status} ${t.progress ?? ''}%   `);
    if (t.status === 'success') {
      const url = t.output?.pbr_model || t.output?.model || t.result?.pbr_model?.url || t.result?.model?.url;
      if (!url) throw new Error(`[${name}] finished but no model URL in response: ${JSON.stringify(t.output ?? t.result)}`);
      const bin = Buffer.from(await (await fetch(url)).arrayBuffer());
      await writeFile(`${OUT}/${name}.glb`, bin);
      console.log(`\n[${name}] saved ${OUT}/${name}.glb (${(bin.length / 1e6).toFixed(1)} MB)`);
      return;
    }
    if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(t.status)) {
      throw new Error(`\n[${name}] task ${task_id} ended with status "${t.status}"`);
    }
  }
}

await mkdir(OUT, { recursive: true });
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ASSETS);
const results = await Promise.allSettled(wanted.map((n) => {
  if (!ASSETS[n]) return Promise.reject(new Error(`Unknown asset "${n}". Use: ${Object.keys(ASSETS).join(', ')}`));
  return generate(n, ASSETS[n]);
}));
results.forEach((r, i) => r.status === 'rejected' && console.error(`✗ ${wanted[i]}: ${r.reason.message}`));

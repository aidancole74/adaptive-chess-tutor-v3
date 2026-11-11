/** Collects every public/packs/<id>/pack.json into public/packs/manifest.json (run after any pipeline). */
import fs from 'node:fs';
import path from 'node:path';
import { PACKS } from './lib/pack';
import type { PackInfo, PackManifest } from '../src/content/types';

const packs: PackInfo[] = [];
if (fs.existsSync(PACKS)) {
  for (const d of fs.readdirSync(PACKS)) {
    const f = path.join(PACKS, d, 'pack.json');
    if (!fs.existsSync(f)) continue;
    const p = JSON.parse(fs.readFileSync(f, 'utf8')) as PackInfo;
    // The manifest stays small: per-pack meta is read by the QA report from pack.json, not by the app.
    packs.push({ ...p, meta: undefined });
  }
}
const manifest: PackManifest = { schema: 1, generatedAt: new Date().toISOString(), packs };
fs.mkdirSync(PACKS, { recursive: true });
fs.writeFileSync(path.join(PACKS, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`[manifest] ${packs.map((p) => `${p.id}(${p.count})`).join(', ') || 'no packs'}`);

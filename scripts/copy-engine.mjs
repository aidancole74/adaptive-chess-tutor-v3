// Copies the single-threaded lite Stockfish WASM build into public/engine (served same-origin to a Web Worker).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'node_modules', 'stockfish', 'bin');
const out = path.join(root, 'public', 'engine');
if (!fs.existsSync(bin)) {
  console.warn('[copy-engine] stockfish package not installed yet; skipping');
  process.exit(0);
}
const js = fs.readdirSync(bin).find((f) => /^stockfish-[\d.]+-lite-single\.js$/.test(f));
if (!js) throw new Error('[copy-engine] no stockfish-*-lite-single.js found in ' + bin);
const wasm = js.replace(/\.js$/, '.wasm');
fs.mkdirSync(out, { recursive: true });
// Stable names so the app does not depend on the engine version in the filename.
// The JS loader derives the wasm name from its own URL, so both are renamed consistently.
fs.copyFileSync(path.join(bin, js), path.join(out, 'stockfish.js'));
fs.copyFileSync(path.join(bin, wasm), path.join(out, 'stockfish.wasm'));
fs.copyFileSync(path.join(root, 'node_modules', 'stockfish', 'Copying.txt'), path.join(out, 'COPYING.txt'));
fs.writeFileSync(path.join(out, 'VERSION.txt'), js + '\n');
console.log('[copy-engine] copied', js, '->', 'public/engine/stockfish.js (+wasm)');

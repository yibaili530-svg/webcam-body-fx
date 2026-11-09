// Copies the MediaPipe wasm runtime into public/ so it is served locally.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const to = resolve(root, 'public/mediapipe/wasm');

if (!existsSync(from)) {
  // Nothing to copy yet (e.g. a partial install); don't fail the install.
  console.warn(`[copy-wasm] ${from} not found; skipped`);
  process.exit(0);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-wasm] copied to ${to}`);

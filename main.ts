// png-squeeze entry: read every instance under the input directory, squeeze each
// 1280x720 screenshot losslessly into the smallest PNG it can, and write the
// answers under the output directory. Deterministic: fixed work per image, no
// clock, no environment input beyond the two directory paths.
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png-decode.ts';
import { encodePng } from './png-encode.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  // Instances are directories; ignore any stray file in the input directory.
  if (!lstatSync(join(INPUT_DIR, id)).isDirectory()) continue;
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodePng(image.rgba, image.width, image.height));
}

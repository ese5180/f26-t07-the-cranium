#!/usr/bin/env node
/**
 * Write the team's photos for the customer site's About page (docs/customer-site.md, "About") into
 * customer/assets/customer-team-photos.js, as data: addresses.
 *
 *   node cloud/web/build-team-photos.mjs
 *
 * The photos are the files of cloud/web/team-photos/, each named by its person, in lower case with a
 * hyphen between the names: vihaan-ravishankar.webp, demetrius-bosket.webp, adam-shalabi.webp,
 * christian-durante.webp. WebP, JPEG or PNG, square, at most 60 KB each (320 by 320 is plenty). A
 * person without a file gets their initials in a circle instead.
 *
 * Why a module and not image files: the phone apps' bundle holds only text files (bundle.mjs TYPES),
 * and every app already installed refuses a bundle with any other kind. A data: address is text, and
 * both the site's policy and the apps' allow data: images. The tests check that the module is the one
 * this script writes from the folder, so a photo cannot be added without it.
 *
 * No dependencies.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PHOTOS_DIR = new URL('./team-photos/', import.meta.url);
export const MODULE_PATH = new URL('./src/customer/assets/customer-team-photos.js', import.meta.url);
export const MAX_PHOTO_BYTES = 60 * 1024;

const NAME = /^([a-z]+(?:-[a-z]+)+)\.(webp|jpe?g|png)$/;
const TYPES = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

/** Whether the bytes are of the kind their name says. */
function looksLike(type, bytes) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** The photos of the folder, by person: { 'vihaan-ravishankar': 'data:image/webp;base64,...' }. */
export function readPhotos(dir = PHOTOS_DIR) {
  const photos = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const match = NAME.exec(entry.name);
    if (!entry.isFile() || !match)
      throw new Error(`team-photos/${entry.name}: not a photo named like name-surname.webp`);
    const [, person, extension] = match;
    const type = TYPES[extension];
    const bytes = readFileSync(new URL(entry.name, dir));
    if (bytes.length > MAX_PHOTO_BYTES) {
      throw new Error(`team-photos/${entry.name}: ${bytes.length} bytes, more than ${MAX_PHOTO_BYTES}`);
    }
    if (!looksLike(type, bytes)) throw new Error(`team-photos/${entry.name}: not a ${type} file`);
    if (person in photos) throw new Error(`team-photos/: two photos of ${person}`);
    photos[person] = `data:${type};base64,${bytes.toString('base64')}`;
  }
  return photos;
}

/** The module's text, as Prettier would leave it. */
export function photosModule(photos) {
  const lines = Object.entries(photos).map(([person, uri]) => `  '${person}':\n    '${uri}',\n`);
  return (
    '// The team’s photos on the About page, by person (customer-views.js aboutView). Written by\n' +
    '// cloud/web/build-team-photos.mjs from cloud/web/team-photos/: change those, not this file.\n' +
    `export const TEAM_PHOTOS = Object.freeze({${lines.length ? `\n${lines.join('')}` : ''}});\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const photos = readPhotos();
  writeFileSync(MODULE_PATH, photosModule(photos));
  console.log(`customer-team-photos.js: ${Object.keys(photos).join(', ') || 'no photos'}`);
}

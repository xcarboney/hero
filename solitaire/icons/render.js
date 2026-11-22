/*
 * Renders the PWA icon PNGs from icon.svg. A development tool: nothing loads it at runtime.
 *
 *   node solitaire/icons/render.js            writes the PNGs next to this file
 *   node solitaire/icons/render.js <out-dir>  writes them somewhere else (to compare before replacing)
 *
 * Needs Playwright with Chromium (`require('playwright')`); the game itself has no dependencies.
 * Run it again after every change to icon.svg and commit the PNGs: the manifest, sw.js and
 * js/pwa.js refer to them by name, and tests/pwa.test.js checks their pixel sizes.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const SOURCE = path.join(__dirname, 'icon.svg');
const SOURCE_SIZE = 512; // width/height of icon.svg in CSS px

/*
 * variant ''          icon.svg            rounded plate, transparent corners
 * variant 'maskable'  icon.svg#maskable   felt to the edges, opaque
 * iOS draws transparent pixels black and rounds the corners itself, so its icon is the opaque one.
 */
const OUTPUTS = [
  { file: 'icon-192.png', size: 192, variant: '' },
  { file: 'icon-512.png', size: 512, variant: '' },
  { file: 'icon-maskable-192.png', size: 192, variant: 'maskable' },
  { file: 'icon-maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, variant: 'maskable' },
];

async function main() {
  const outDir = path.resolve(process.argv[2] || __dirname);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const out of OUTPUTS) {
      // The SVG is laid out at 512 CSS px; the device scale factor turns that into the wanted
      // number of real pixels, so every size is rasterised from the vectors, never resampled.
      const context = await browser.newContext({
        viewport: { width: SOURCE_SIZE, height: SOURCE_SIZE },
        deviceScaleFactor: out.size / SOURCE_SIZE,
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(SOURCE).href + (out.variant ? '#' + out.variant : ''));
      const target = path.join(outDir, out.file);
      await page.screenshot({
        path: target,
        omitBackground: true, // keep the corners of the plate transparent
        clip: { x: 0, y: 0, width: SOURCE_SIZE, height: SOURCE_SIZE },
      });
      await context.close();
      console.log(out.file, out.size + 'x' + out.size, fs.statSync(target).size + ' bytes');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

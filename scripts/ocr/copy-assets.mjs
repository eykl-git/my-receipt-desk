#!/usr/bin/env node
/**
 * Copies the self-hosted OCR assets from node_modules into public/ocr/
 * (ocr-design.md §3). Usage: node scripts/ocr/copy-assets.mjs [--out <dir>]
 *
 * - worker.min.js from tesseract.js, the three LSTM-only core builds from
 *   tesseract.js-core, and one traineddata variant (4.0.0_best_int) per language.
 * - Each traineddata file is checked against its pinned size and SHA-256
 *   (the same values as src/ocr/languages.ts OCR_LANGUAGE_DATA); a mismatch aborts.
 * - Idempotent: files are overwritten. Nothing is fetched from the network.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

const LANGUAGES = {
  eng: { bytes: 2952873, sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' },
  msa: { bytes: 1177136, sha256: '35ae490b99462d04cf4e2a7985d98f0ba5e10ca62adb13aeda070c6f1783f097' },
  chi_sim: { bytes: 1718768, sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c' },
  chi_tra: { bytes: 1656239, sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743' },
};
const VARIANT = '4.0.0_best_int';
const CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
];

function packageDir(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i === -1) return resolve('public/ocr');
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error('copy-assets: --out needs a directory.');
    process.exit(2);
  }
  return resolve(value);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main() {
  const out = parseOut(process.argv.slice(2));
  const tesseract = packageDir('tesseract.js');
  const core = packageDir('tesseract.js-core');
  const copies = [
    { from: join(tesseract, 'dist', 'worker.min.js'), to: 'worker.min.js' },
    ...CORE_FILES.map((f) => ({ from: join(core, f), to: join('core', f) })),
    ...Object.keys(LANGUAGES).map((lang) => ({
      from: join(packageDir(`@tesseract.js-data/${lang}`), VARIANT, `${lang}.traineddata.gz`),
      to: join('lang', `${lang}.traineddata.gz`),
      lang,
    })),
    { from: join(tesseract, 'LICENSE.md'), to: join('licenses', 'tesseract.js-LICENSE.md') },
    { from: join(core, 'LICENSE'), to: join('licenses', 'tesseract.js-core-LICENSE') },
  ];

  for (const c of copies) {
    if (!c.lang) continue;
    const expected = LANGUAGES[c.lang];
    const size = statSync(c.from).size;
    const digest = sha256(c.from);
    if (size !== expected.bytes || digest !== expected.sha256) {
      console.error(
        `copy-assets: ${relative(process.cwd(), c.from)} does not match the pinned ${VARIANT} file ` +
          `(expected ${expected.bytes} bytes, sha256 ${expected.sha256}; got ${size} bytes, sha256 ${digest}). ` +
          'Reinstall with npm ci, or update the pinned values in this script and src/ocr/languages.ts together.',
      );
      process.exit(1);
    }
  }

  let total = 0;
  for (const c of copies) {
    const target = join(out, c.to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(c.from, target);
    const bytes = statSync(target).size;
    total += bytes;
    console.log(`${relative(process.cwd(), target)} ${bytes}`);
  }
  console.log(`total ${total} bytes in ${copies.length} files`);
}

main();

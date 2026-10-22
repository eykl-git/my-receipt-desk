#!/usr/bin/env node
/**
 * Renders the fictional OCR sample receipts (ocr-design.md §3) from SVG to PNG
 * with Playwright Chromium, and writes the matching MYR card statement CSV.
 * Usage: node scripts/ocr/make-samples.mjs [--out <dir>]   (default public/samples)
 *
 * Everything here is fictional: "Contoh" (Malay) / "示例" / "示範" mean "example",
 * the street names are made up, and phone and registration numbers are zeros.
 * Each image says "Fictional sample". Fonts are macOS system fonts (Menlo,
 * PingFang SC / PingFang HK); the PNGs are committed, so CI never renders them.
 * Expected fields for each image live in tests/fixtures/ocr/<name>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const WIDTH = 440;
const PAD = 28;
const LINE = 30;

/** Row kinds: text (left, optional right), center, rule (dashed separator), gap. */
const RECEIPTS = [
  {
    file: 'sample-receipt-my.png',
    font: 'Menlo, "Courier New", monospace',
    size: 17,
    rows: [
      { center: 'CONTOH MART SDN BHD', bold: true, size: 20 },
      { center: 'Reg. No: 200001000000 (000000-X)' },
      { center: '12, Jalan Contoh 1/1' },
      { center: '46000 Petaling Jaya, Selangor' },
      { center: 'Tel: +60 3-0000 0000' },
      { gap: true },
      { center: 'RESIT / RECEIPT', bold: true },
      { left: 'No. Resit: CM-0314-0042' },
      { left: 'Tarikh: 14/03/2026 10:42' },
      { rule: true },
      { left: 'Roti Canai x2', right: '4.00' },
      { left: 'Teh Tarik', right: '3.50' },
      { left: 'Nasi Lemak Ayam', right: '9.20' },
      { left: 'Air Mineral', right: '5.00' },
      { rule: true },
      { left: 'Subtotal', right: '21.70' },
      { left: 'SST 6%', right: '1.30' },
      { left: 'Rounding', right: '0.00' },
      { left: 'Jumlah Besar', right: 'RM 23.00', bold: true },
      { left: 'Tunai', right: 'RM 50.00' },
      { left: 'Baki', right: 'RM 27.00' },
      { rule: true },
      { center: 'Terima kasih' },
      { gap: true },
      { center: 'Fictional sample', size: 14 },
    ],
  },
  {
    file: 'sample-receipt-my-zh.png',
    font: '"PingFang SC", sans-serif',
    size: 18,
    rows: [
      { center: '示例美食有限公司', bold: true, size: 22 },
      { center: '(200001000000)' },
      { center: '吉隆坡示例路8号' },
      { center: '电话: +60 3-0000 0000' },
      { gap: true },
      { center: '收据', bold: true },
      { left: '单号: SL-0316-0007' },
      { left: '日期: 2026年3月16日 12:05' },
      { rule: true },
      { left: '海南鸡饭', right: '9.50' },
      { left: '叻沙', right: '11.00' },
      { left: '冰咖啡', right: '4.50' },
      { rule: true },
      { left: '小计', right: '25.00' },
      { left: '服务税 6%', right: '1.50' },
      { left: '合计', right: 'RM 26.50', bold: true },
      { left: '现金', right: 'RM 30.00' },
      { left: '找零', right: 'RM 3.50' },
      { rule: true },
      { center: '谢谢光临' },
      { gap: true },
      { center: 'Fictional sample', size: 14 },
    ],
  },
  {
    file: 'sample-receipt-hk-zh.png',
    font: '"PingFang HK", "PingFang TC", sans-serif',
    size: 18,
    rows: [
      { center: '示範茶餐廳有限公司', bold: true, size: 22 },
      { center: '香港九龍旺角示範街8號地舖' },
      { center: '電話: +852 0000 0000' },
      { gap: true },
      { center: '收據', bold: true },
      { left: '單號: HK-0318-0021' },
      { left: '日期: 18/03/2026 13:20' },
      { rule: true },
      { left: '凍檸茶', right: '18.00' },
      { left: '叉燒飯', right: '52.00' },
      { left: '菠蘿油', right: '12.00' },
      { rule: true },
      { left: '小計', right: '82.00' },
      { left: '服務費 10%', right: '8.20' },
      { left: '總計', right: 'HK$ 90.20', bold: true },
      { left: '現金', right: 'HK$ 100.00' },
      { left: '找續', right: 'HK$ 9.80' },
      { rule: true },
      { center: '多謝惠顧' },
      { gap: true },
      { center: 'Fictional sample', size: 14 },
    ],
  },
];

/** Bytes conventions as design §12.4: UTF-8 BOM, CRLF, trailing blank line. */
const STATEMENT_CSV = {
  file: 'example-card-statement-my.csv',
  rows: [
    'Date,Posted,Details,Amount,Currency',
    '14/03/2026,15/03/2026,CONTOH MART PJ,-23.00,MYR',
    '16/03/2026,17/03/2026,CONTOH MAKANAN KL,-26.50,MYR',
    '19/03/2026,20/03/2026,CONTOH PARKING,-5.00,MYR',
    '21/03/2026,23/03/2026,CONTOH BOOKS,-42.90,MYR',
  ],
};

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgFor(receipt) {
  const parts = [];
  let y = PAD;
  for (const row of receipt.rows) {
    const size = row.size ?? receipt.size;
    const weight = row.bold ? 'bold' : 'normal';
    const attrs = `font-size="${size}" font-weight="${weight}"`;
    if (row.gap) {
      y += LINE / 2;
      continue;
    }
    if (row.rule) {
      const ry = y + LINE / 2;
      parts.push(`<line x1="${PAD}" y1="${ry}" x2="${WIDTH - PAD}" y2="${ry}" stroke="#444" stroke-width="1.5" stroke-dasharray="6 4"/>`);
      y += LINE;
      continue;
    }
    const base = y + LINE * 0.72;
    if (row.center !== undefined) {
      parts.push(`<text x="${WIDTH / 2}" y="${base}" text-anchor="middle" ${attrs}>${escapeXml(row.center)}</text>`);
    } else {
      parts.push(`<text x="${PAD}" y="${base}" ${attrs}>${escapeXml(row.left)}</text>`);
      if (row.right !== undefined) {
        parts.push(`<text x="${WIDTH - PAD}" y="${base}" text-anchor="end" ${attrs}>${escapeXml(row.right)}</text>`);
      }
    }
    y += LINE + (size > receipt.size ? 4 : 0);
  }
  const height = Math.ceil(y + PAD);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" ` +
    `font-family='${receipt.font}' fill="#111">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${parts.join('')}</svg>`
  );
}

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i === -1) return resolve('public/samples');
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error('make-samples: --out needs a directory.');
    process.exit(2);
  }
  return resolve(value);
}

async function main() {
  const out = parseOut(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: WIDTH + 40, height: 1200 } });
    // Offline render: block every request so nothing is fetched while drawing.
    await page.route('**/*', (route) => route.abort());
    for (const receipt of RECEIPTS) {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svgFor(receipt)}</body></html>`);
      // Runs in the page, so `document` is the page's global.
      await page.evaluate(() => globalThis.document.fonts.ready.then(() => true));
      const target = join(out, receipt.file);
      await page.locator('svg').screenshot({ path: target, omitBackground: false });
      console.log(`${relative(process.cwd(), target)}`);
    }
  } finally {
    await browser.close();
  }
  const csvPath = join(out, STATEMENT_CSV.file);
  writeFileSync(csvPath, `\uFEFF${STATEMENT_CSV.rows.join('\r\n')}\r\n\r\n`, 'utf8');
  console.log(`${relative(process.cwd(), csvPath)}`);
}

await main();

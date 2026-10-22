/** Locale detection (brief §27, ocr-design.md §2.1): evidence lists, a 2-kind threshold, never a score. */
import { describe, expect, it } from 'vitest';
import {
  LOCALE_MIN_SIGNAL_KINDS,
  detectReceiptLocale,
  detectedRegions,
  isLocaleDetected,
} from '../../src/domain/capture/ocrLocale';

/** Every number anywhere in a value (deep walk). */
function numbersIn(value: unknown): unknown[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('OCR locale detection', () => {
  it('OL01 a region needs at least 2 distinct signal kinds; one kind repeated is not enough', () => {
    expect(LOCALE_MIN_SIGNAL_KINDS).toBe(2);
    const repeated = detectReceiptLocale('Jumlah 5.00\nTunai 10.00\nBaki 5.00\nTarikh');
    expect(repeated.malaysia.map((s) => s.kind)).toEqual(['malay-keyword', 'malay-keyword', 'malay-keyword', 'malay-keyword']);
    expect(isLocaleDetected(repeated.malaysia)).toBe(false);
    expect(detectedRegions(repeated)).toEqual([]);
    const two = detectReceiptLocale('Jumlah RM 5.00');
    expect(two.malaysia).toEqual([
      { kind: 'malay-keyword', text: 'Jumlah' },
      { kind: 'currency', text: 'RM' },
    ]);
    expect(detectedRegions(two)).toEqual(['malaysia']);
  });

  it('OL02 Malaysia signals: RM/MYR, Sdn Bhd, SSM numbers, SST, Malay keywords, +60, places, 马币/令吉', () => {
    const text = `CONTOH SDN. BHD. (202001012345)
Old reg 1234567-W
No. 1 Jalan Contoh, Shah Alam, Selangor
Tel +60 12-345 6789
SST 6% Service Tax
Jumlah Besar MYR 23.00
马币 令吉 吉隆坡`;
    const { malaysia, hongKong } = detectReceiptLocale(text);
    expect(new Set(malaysia.map((s) => s.kind))).toEqual(
      new Set(['currency', 'company-suffix', 'registration-number', 'sales-tax', 'malay-keyword', 'phone', 'place']),
    );
    expect(malaysia).toContainEqual({ kind: 'company-suffix', text: 'SDN. BHD.' });
    expect(malaysia).toContainEqual({ kind: 'registration-number', text: '202001012345' });
    expect(malaysia).toContainEqual({ kind: 'registration-number', text: '1234567-W' });
    expect(malaysia).toContainEqual({ kind: 'phone', text: '+60 12-345 6789' });
    expect(malaysia).toContainEqual({ kind: 'currency', text: '马币' });
    expect(malaysia).toContainEqual({ kind: 'place', text: '吉隆坡' });
    expect(hongKong).toEqual([]);
  });

  it('OL03 Hong Kong vs Malaysia: HK$/HKD, 有限公司 with Traditional characters, +852, 香港 and districts', () => {
    const hk = detectReceiptLocale('示範茶餐廳有限公司\n香港九龍旺角\n電話: +852 0000 0000\n總計 HK$ 90.20\nHKD');
    expect(hk.hongKong).toEqual([
      { kind: 'company-suffix', text: '有限公司' },
      { kind: 'place', text: '香港' },
      { kind: 'place', text: '九龍' },
      { kind: 'place', text: '旺角' },
      { kind: 'phone', text: '+852 0000 0000' },
      { kind: 'currency', text: 'HK$' },
      { kind: 'currency', text: 'HKD' },
    ]);
    expect(hk.malaysia).toEqual([]);
    expect(detectedRegions(hk)).toEqual(['hong-kong']);
    const latin = detectReceiptLocale('Page Corner, Causeway Bay, Hong Kong\nTotal HKD 120.00');
    expect(detectedRegions(latin)).toEqual(['hong-kong']);
  });

  it('OL04 有限公司 with Simplified-only text is not a Hong Kong signal', () => {
    const { hongKong, malaysia } = detectReceiptLocale('示例美食有限公司\n吉隆坡示例路8号\n合计 RM 26.50');
    expect(hongKong).toEqual([]);
    expect(detectedRegions({ malaysia, hongKong })).toEqual(['malaysia']);
  });

  it('OL05 signals are de-duplicated by (kind, text) and kept in appearance order', () => {
    const { malaysia } = detectReceiptLocale('RM 1.00\nSelangor\nRM 2.00\nSelangor\nTunai');
    expect(malaysia).toEqual([
      { kind: 'currency', text: 'RM' },
      { kind: 'place', text: 'Selangor' },
      { kind: 'malay-keyword', text: 'Tunai' },
    ]);
  });

  it('OL06 no numeric field anywhere in the output (no score)', () => {
    for (const text of ['', 'CONTOH SDN BHD Jumlah RM 5.00', '示範餐廳有限公司 香港 HK$ 5.00', 'RM HK$ 香港 Selangor']) {
      const locale = detectReceiptLocale(text);
      expect(numbersIn(locale)).toEqual([]);
      expect(Object.keys(locale).sort()).toEqual(['hongKong', 'malaysia']);
      for (const s of [...locale.malaysia, ...locale.hongKong]) expect(Object.keys(s).sort()).toEqual(['kind', 'text']);
    }
  });

  it('OL07 no region at all: plain text yields empty lists and nothing detected', () => {
    const none = detectReceiptLocale('Corner Shop\nTotal 5.00\nThank you');
    expect(none).toEqual({ malaysia: [], hongKong: [] });
    expect(detectedRegions(none)).toEqual([]);
  });
});

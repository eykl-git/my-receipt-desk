/**
 * Receipt locale detection (brief §27, ocr-design.md §2.1). Pure and
 * deterministic: the receipt text is untrusted data and is only matched, never
 * interpreted. The result is evidence lists per locale. There is never a
 * numeric score; a locale counts as detected only with at least
 * LOCALE_MIN_SIGNAL_KINDS distinct signal kinds.
 */

export type MalaysiaSignalKind =
  | 'currency' // RM / MYR amounts, 马币, 令吉
  | 'company-suffix' // Sdn Bhd, Sdn. Bhd., Bhd, Berhad
  | 'registration-number' // SSM old 123456-X, new 12 digits starting 19xx/20xx
  | 'sales-tax' // SST, Service Tax
  | 'malay-keyword' // Jumlah, Jumlah Besar, Tarikh, Tunai, Baki, Resit
  | 'phone' // +60 numbers
  | 'place'; // Malaysian states and cities (Latin and Chinese names)
export type HongKongSignalKind =
  | 'currency' // HK$, HKD
  | 'company-suffix' // 有限公司 on a line that also has Traditional-only characters
  | 'phone' // +852 numbers
  | 'place'; // 香港 / Hong Kong and HK district names

export interface LocaleSignal<K extends string = string> {
  readonly kind: K;
  /** The matched receipt text (untrusted; render as a text node). */
  readonly text: string;
}

export interface ReceiptLocale {
  readonly malaysia: readonly LocaleSignal<MalaysiaSignalKind>[];
  readonly hongKong: readonly LocaleSignal<HongKongSignalKind>[];
}

export type ReceiptRegion = 'malaysia' | 'hong-kong';

/** A region is "detected" only with at least this many DISTINCT signal kinds. */
export const LOCALE_MIN_SIGNAL_KINDS = 2;

interface Pattern<K extends string> {
  readonly kind: K;
  readonly re: RegExp;
}

/** Builds a case-insensitive whole-word alternation for Latin names. */
function latinWords(words: readonly string[]): RegExp {
  const alts = words.map((w) => w.replace(/\s+/g, '\\s+')).join('|');
  return new RegExp(`(?<![A-Za-z])(?:${alts})(?![A-Za-z])`, 'gi');
}

/** Builds a plain alternation for CJK names (no word boundaries in Chinese text). */
function cjkWords(words: readonly string[]): RegExp {
  return new RegExp(words.join('|'), 'g');
}

// Malaysian states, federal territories and major cities. Ambiguous Chinese
// names that are also common words (e.g. 芙蓉, 美里) are left out on purpose.
const MY_PLACES_LATIN = [
  'Malaysia',
  'Kuala Lumpur',
  'Putrajaya',
  'Labuan',
  'Selangor',
  'Johor Bahru',
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Malacca',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Penang',
  'Sabah',
  'Sarawak',
  'Terengganu',
  'Petaling Jaya',
  'Shah Alam',
  'Subang Jaya',
  'Cyberjaya',
  'Puchong',
  'Klang',
  'Ipoh',
  'Kota Kinabalu',
  'Kuching',
  'Seremban',
  'Kuantan',
  'Alor Setar',
  'Kota Bharu',
  'Kuala Terengganu',
  'George Town',
  'Sandakan',
];
const MY_PLACES_CJK = [
  '马来西亚',
  '馬來西亞',
  '吉隆坡',
  '雪兰莪',
  '雪蘭莪',
  '柔佛',
  '新山',
  '槟城',
  '檳城',
  '马六甲',
  '馬六甲',
  '怡保',
  '布城',
  '沙巴',
  '砂拉越',
  '砂勞越',
  '森美兰',
  '森美蘭',
  '彭亨',
  '霹雳',
  '霹靂',
  '吉打',
  '吉兰丹',
  '吉蘭丹',
  '登嘉楼',
  '登嘉樓',
  '玻璃市',
  '八打灵再也',
  '八打靈再也',
  '莎阿南',
  '巴生',
  '古晋',
  '古晉',
  '亚庇',
  '亞庇',
];

// Hong Kong and its districts. "Aberdeen" is left out (also a Scottish city).
const HK_PLACES_LATIN = [
  'Hong Kong',
  'Central',
  'Admiralty',
  'Sheung Wan',
  'Wan Chai',
  'Causeway Bay',
  'North Point',
  'Quarry Bay',
  'Kowloon',
  'Mong Kok',
  'Tsim Sha Tsui',
  'Yau Ma Tei',
  'Sham Shui Po',
  'Kwun Tong',
  'Sha Tin',
  'Tsuen Wan',
  'Tuen Mun',
  'Yuen Long',
  'Tai Po',
  'Sai Kung',
  'Tseung Kwan O',
  'Kwai Chung',
  'Tung Chung',
  'Lantau',
  'New Territories',
];
const HK_PLACES_CJK = [
  '香港',
  '中環',
  '金鐘',
  '上環',
  '灣仔',
  '銅鑼灣',
  '北角',
  '鰂魚涌',
  '九龍',
  '旺角',
  '尖沙咀',
  '油麻地',
  '深水埗',
  '觀塘',
  '沙田',
  '荃灣',
  '屯門',
  '元朗',
  '大埔',
  '西貢',
  '將軍澳',
  '葵涌',
  '東涌',
  '大嶼山',
  '新界',
];

/**
 * Characters used in Traditional but not in Simplified Chinese. 有限公司 is
 * written the same in both scripts, so it is a Hong Kong signal only when its
 * line also has one of these. The set is deliberately small: common receipt
 * and address characters whose Simplified forms differ.
 */
export const TRADITIONAL_ONLY_CHARS = new Set(
  Array.from('廳號樓廣場東灣龍區業貿興發華門書島國際電話總計實應現續數額範樣舖餅麵飯凍檸飲雞燒臘鴨魚'),
);

const MALAYSIA_PATTERNS: readonly Pattern<MalaysiaSignalKind>[] = [
  // "RM", "RM 23.00" and "RM23.00" all yield the signal text "RM".
  { kind: 'currency', re: /(?<![A-Za-z])RM(?![A-Za-z])/g },
  { kind: 'currency', re: /(?<![A-Za-z])MYR(?![A-Za-z])/g },
  { kind: 'currency', re: /马币|馬幣|令吉/g },
  { kind: 'company-suffix', re: /(?<![A-Za-z])(?:Sdn\.?\s*Bhd|Bhd|Berhad)(?![A-Za-z])\.?/gi },
  { kind: 'registration-number', re: /(?<!\d)(?:19|20)\d{10}(?!\d)/g },
  { kind: 'registration-number', re: /(?<![\dA-Za-z])\d{6,7}-[A-Z](?![A-Za-z\d])/g },
  { kind: 'sales-tax', re: /(?<![A-Za-z])(?:SST|Service\s+Tax)(?![A-Za-z])/gi },
  { kind: 'malay-keyword', re: /(?<![A-Za-z])(?:Jumlah\s+Besar|Jumlah|Tarikh|Tunai|Baki|Resit)(?![A-Za-z])/gi },
  { kind: 'phone', re: /\+\s?60(?:[\s-]?\d){8,10}(?!\d)/g },
  { kind: 'place', re: latinWords(MY_PLACES_LATIN) },
  { kind: 'place', re: cjkWords(MY_PLACES_CJK) },
];

const HONG_KONG_PATTERNS: readonly Pattern<HongKongSignalKind>[] = [
  { kind: 'currency', re: /(?<![A-Za-z])HK\s?\$/g },
  { kind: 'currency', re: /(?<![A-Za-z])HKD(?![A-Za-z])/g },
  { kind: 'phone', re: /\+\s?852(?:[\s-]?\d){8}(?!\d)/g },
  { kind: 'place', re: latinWords(HK_PLACES_LATIN) },
  { kind: 'place', re: cjkWords(HK_PLACES_CJK) },
];

interface Hit<K extends string> {
  readonly kind: K;
  readonly text: string;
  readonly index: number;
}

function collect<K extends string>(text: string, patterns: readonly Pattern<K>[]): Hit<K>[] {
  const hits: Hit<K>[] = [];
  for (const { kind, re } of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      hits.push({ kind, text: m[0].trim(), index: m.index });
    }
  }
  return hits;
}

/** 有限公司 counts for Hong Kong only on a line that also has a Traditional-only character. */
function hongKongCompanyHits(text: string): Hit<'company-suffix'>[] {
  const hits: Hit<'company-suffix'>[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const at = line.indexOf('有限公司');
    if (at >= 0 && Array.from(line).some((ch) => TRADITIONAL_ONLY_CHARS.has(ch))) {
      hits.push({ kind: 'company-suffix', text: '有限公司', index: offset + at });
    }
    offset += line.length + 1;
  }
  return hits;
}

/** Orders hits by position (then kind, for ties) and keeps the first of each (kind, text). */
function toSignals<K extends string>(hits: Hit<K>[]): LocaleSignal<K>[] {
  const sorted = [...hits].sort((a, b) => a.index - b.index || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const seen = new Set<string>();
  const out: LocaleSignal<K>[] = [];
  for (const h of sorted) {
    if (h.text === '') continue;
    const key = `${h.kind}\u0000${h.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ kind: h.kind, text: h.text }));
  }
  return out;
}

export function detectReceiptLocale(text: string): ReceiptLocale {
  const t = text.normalize('NFKC');
  return Object.freeze({
    malaysia: Object.freeze(toSignals(collect(t, MALAYSIA_PATTERNS))),
    hongKong: Object.freeze(toSignals([...collect(t, HONG_KONG_PATTERNS), ...hongKongCompanyHits(t)])),
  });
}

export function isLocaleDetected(signals: readonly LocaleSignal[]): boolean {
  return new Set(signals.map((s) => s.kind)).size >= LOCALE_MIN_SIGNAL_KINDS;
}

/** Regions with ≥ 2 distinct signal kinds, in the order ['malaysia', 'hong-kong']. */
export function detectedRegions(locale: ReceiptLocale): ReceiptRegion[] {
  const out: ReceiptRegion[] = [];
  if (isLocaleDetected(locale.malaysia)) out.push('malaysia');
  if (isLocaleDetected(locale.hongKong)) out.push('hong-kong');
  return out;
}

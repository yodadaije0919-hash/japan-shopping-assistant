// Fetch real product info for the catalog from the Yahoo!ショッピング 商品検索API (v3).
//
//   YAHOO_APP_ID=<Client ID> node data/fetch-products.mjs
//
// Reads data/catalog.json, writes data/products.json and prints a review table.
// API: https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html
// Limit: 1 query per second. The Client ID stays in the environment and is never written to disk.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';
// Multi-packs: "セット", "×3", "×10個", "20箱", "3個" etc. ("1箱（10本入）", "18枚入", "100mL×10本" and "2枚×8包" are single items.)
const BUNDLE = /セット|まとめ|ケース|コストコ|アソート|コラボ|たまごっち|[×xX]\s*(?:[2-9]|\d{2,})(?!\d*\s*(?:本|枚|錠|包|ml|g))|(?:^|[^\d])(?:[2-9]|\d{2,})\s*(?:箱|個|袋|パック)(?!入)/;
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
// Every word of the search term (brand, product, size) has to appear in the listing name.
export const matchesQuery = (name, query) => query.split(/\s+/).filter(Boolean).every(w => norm(name).includes(norm(w)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function search(appid, params) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ appid, results: '30', sort: '-score', in_stock: 'true', image_size: '300', ...params });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('HTTP 429 three times');
}

// Pick one product out of the search hits: the JAN that the most single (non-bundle) listings share.
export function summarize(entry, hits) {
  const singles = (hits || []).filter(h => h && h.condition !== 'used' && !BUNDLE.test(h.name || '') && Number.isInteger(h.price) && h.price > 0
    && (entry.jan || matchesQuery(h.name, entry.query)));
  const byJan = new Map();
  for (const h of singles) if (/^\d{8}$|^\d{13}$/.test(h.janCode || '')) byJan.set(h.janCode, [...(byJan.get(h.janCode) || []), h]);
  let jan = entry.jan || '';
  if (!jan) jan = [...byJan.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || '';
  const group = jan ? (byJan.get(jan) || []) : [];
  const prices = group.map(h => h.price);
  const best = [...group].sort((a, b) => (b.review?.count || 0) - (a.review?.count || 0))[0];
  const reasons = [];
  if (!entry.jan) reasons.push('JAN 미확정 (검색 결과 최다 JAN)');
  if (group.length < 3) reasons.push(`같은 JAN 판매처 ${group.length}곳뿐`);
  return {
    id: entry.id, cat: entry.cat, query: entry.query,
    jan, name_ja: best?.name || null, brand: best?.brand?.name || null,
    image: best?.exImage?.url || best?.image?.medium || null,
    online: { median: median(prices), min: prices.length ? Math.min(...prices) : null, sellers: group.length },
    reviews: group.reduce((n, h) => n + (h.review?.count || 0), 0),
    needs_review: reasons,
  };
}

async function main() {
  const appid = process.env.YAHOO_APP_ID;
  if (!appid) { console.error('YAHOO_APP_ID 환경변수에 야후 Client ID를 넣어 주세요.'); process.exit(1); }
  const { products } = JSON.parse(await readFile(join(DIR, 'catalog.json'), 'utf8'));
  const out = [];
  for (const [i, entry] of products.entries()) {
    if (i) await sleep(1100);
    try {
      const data = await search(appid, entry.jan ? { jan_code: entry.jan } : { query: entry.query });
      out.push(summarize(entry, data.hits));
    } catch (e) {
      out.push({ id: entry.id, query: entry.query, error: String(e.message || e) });
    }
    const r = out.at(-1);
    console.log(`${String(i + 1).padStart(2)} ${entry.id.padEnd(10)} ${r.error ? 'ERROR ' + r.error : `${r.jan || '-'}  중앙값 ${r.online.median ?? '-'}엔  판매처 ${r.online.sellers}  ${r.needs_review.join(', ')}`}`);
  }
  await writeFile(join(DIR, 'products.json'), JSON.stringify({ source: 'Yahoo!ショッピング 商品検索API v3', fetchedAt: new Date().toISOString(), products: out }, null, 1) + '\n');
  console.log(`\ndata/products.json 저장 (${out.length}개). needs_review가 있는 상품은 JAN을 확인해서 catalog.json에 적고 다시 실행하세요.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

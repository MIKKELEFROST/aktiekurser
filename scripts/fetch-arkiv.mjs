// Hele kurshistorikken, én fil pr. papir.
//
//   data/arkiv/<SYM>.json   – daglige lukkekurser fra første notering til og
//                             med 31. december sidste år
//
// Den daglige fil i data/historik dækker de seneste to år og bliver skrevet om
// hver aften. Arkivet slutter derimod ved årsskiftet, og derfor er det frosset:
// det skrives én gang pr. papir og røres først igen, når året skifter. Uden det
// snit ville 6.226 filer på tilsammen en halv gigabyte blive til nye git-objekter
// hver eneste hverdag.
//
// Yahoos range-parameter stopper ved ti år, og range=max nedsampler til omkring
// 300 bjælker uanset hvilket interval man beder om. period1/period2 gør ikke
// nogen af delene: med period1=0 kommer hver eneste handelsdag tilbage — 11.526
// for Apple, tilbage til december 1980.
//
// Formatet er sammentrykt, fordi datoerne ellers fylder mere end kurserne:
// i stedet for "2024-09-09" står der antal dage siden første kurs. Det halverer
// filen og kan læses med tre linjer på modtagersiden.
//
//   node scripts/fetch-arkiv.mjs                 alt der mangler
//   node scripts/fetch-arkiv.mjs --limit=50      de første 50 (til prøvekørsel)
//   node scripts/fetch-arkiv.mjs --force         hent om, også hvad der findes
//   node scripts/fetch-arkiv.mjs --only=aktier   kun aktier (eller =etf)

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'data/arkiv');
const STOCKS = resolve(ROOT, 'data/aktier.json');
const FUNDS = resolve(ROOT, 'data/etf.json');

const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const FORCE = argv.includes('--force');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CONCURRENCY = 5;

// Arkivet slutter ved sidste årsskifte. Det er snittet der gør filen frossen.
const THROUGH_YEAR = new Date().getUTCFullYear() - 1;
const PERIOD2 = Math.floor(Date.UTC(THROUGH_YEAR + 1, 0, 1) / 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 4) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) { const j = i++; await fn(items[j], j); }
  });
  await Promise.all(workers);
}

// 429 er ikke en fejl i kaldet — det er Yahoo der beder om ro. Den venter
// derfor sekunder, ikke millisekunder, og giver op efter fjerde forsøg.
async function retrying(fn, attempts = 4) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    if (a) {
      const rate = /HTTP 429/.test(String(last && last.message));
      await sleep(rate ? 5000 * a + Math.random() * 2500 : 500 * Math.pow(2, a) + Math.random() * 400);
    }
    try { return await fn(); } catch (err) { last = err; }
  }
  throw last;
}

async function fetchArchive(symbol) {
  return retrying(async () => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
      + '?period1=0&period2=' + PERIOD2 + '&interval=1d';
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = (await res.json())?.chart?.result?.[0];
    const stamps = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];

    // Dagsbjælker er stemplet i børsens åbningstid, så UTC-datoen er den
    // rigtige handelsdag. Det er kun periodebjælker der skal korrigeres, og
    // dem henter vi ikke her.
    const dates = [], vals = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || stamps[i] == null) continue;
      dates.push(new Date(stamps[i] * 1000).toISOString().slice(0, 10));
      vals.push(round(closes[i]));
    }
    if (dates.length < 2) throw new Error('kun ' + dates.length + ' punkter');
    return { dates, closes: vals };
  });
}

// "2024-09-09" fylder tolv tegn, tallet 8642 fylder fire. Datoerne er ellers
// mere end halvdelen af filen, så de gemmes som dage siden den første kurs.
function pack(symbol, dates, closes) {
  const base = Date.UTC(...dates[0].split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const d = dates.map((x) => {
    const t = Date.UTC(...x.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
    return Math.round((t - base) / 86400000);
  });
  return { symbol, first: dates[0], last: dates[dates.length - 1], through: THROUGH_YEAR, d, c: closes };
}

async function alreadyDone(symbol) {
  if (FORCE) return false;
  try {
    const f = JSON.parse(await readFile(resolve(OUT_DIR, symbol + '.json'), 'utf8'));
    return f.through === THROUGH_YEAR && Array.isArray(f.d) && f.d.length > 1;
  } catch { return false; }
}

async function symbolsFrom(path, key) {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    return (j[key] || []).map((r) => r.symbol).filter(Boolean);
  } catch { return []; }
}

async function main() {
  let symbols = [];
  if (ONLY !== 'etf') symbols = symbols.concat(await symbolsFrom(STOCKS, 'stocks'));
  if (ONLY !== 'aktier') symbols = symbols.concat(await symbolsFrom(FUNDS, 'etfs'));
  symbols = [...new Set(symbols)];
  if (!symbols.length) { console.error('Ingen symboler — kør aktie- og ETF-hentningen først.'); process.exit(1); }

  await mkdir(OUT_DIR, { recursive: true });

  const todo = [];
  for (const s of symbols) if (!(await alreadyDone(s))) todo.push(s);
  console.log(`${symbols.length} papirer, ${symbols.length - todo.length} allerede arkiveret til og med ${THROUGH_YEAR}.`);
  if (!todo.length) { console.log('Intet at hente.'); return; }

  const work = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`Henter ${work.length}…`);

  let done = 0, written = 0, points = 0, bytes = 0;
  const failed = [];
  await pool(work, CONCURRENCY, async (symbol) => {
    try {
      const { dates, closes } = await fetchArchive(symbol);
      const json = JSON.stringify(pack(symbol, dates, closes)) + '\n';
      await writeFile(resolve(OUT_DIR, symbol + '.json'), json);
      written++; points += dates.length; bytes += json.length;
    } catch (err) {
      failed.push({ symbol, reason: err.message });
    }
    if (++done % 200 === 0) console.log(`  ${done}/${work.length}…`);
  });

  console.log(`Skrev ${written} arkiver, ${points.toLocaleString('da-DK')} kursdage, `
    + `${(bytes / 1e6).toFixed(0)} MB` + (failed.length ? `, ${failed.length} fejlede` : ''));
  if (failed.length) {
    const why = {};
    for (const f of failed) why[f.reason] = (why[f.reason] || 0) + 1;
    for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`    ${v}× ${k}`);
    }
  }

  // Et papir der er faldet ud af universet skal ikke efterlade sit arkiv.
  if (!LIMIT && !ONLY) {
    const keep = new Set(symbols.map((s) => s + '.json'));
    let removed = 0;
    for (const f of await readdir(OUT_DIR)) {
      if (f.endsWith('.json') && !keep.has(f)) { await unlink(resolve(OUT_DIR, f)); removed++; }
    }
    if (removed) console.log(`  ${removed} forældede arkiver fjernet`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

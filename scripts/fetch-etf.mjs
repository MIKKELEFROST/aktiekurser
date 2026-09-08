// Henter ETF'er og skriver data/etf.json + data/etf-historik/<SYM>.json.
//
// Kept apart from fetch-stocks.mjs on purpose. That script is built around a
// company — sectors, index membership, Wikipedia constituents, a market-value
// rank, four quarters of statements — and a fund has none of those. Threading a
// second kind of thing through it would make both harder to read, and a bug in
// the new half would take the working half down twice a day. The two share a
// handful of primitives; that duplication is the cheaper of the two costs.
//
//   node scripts/fetch-etf.mjs [--quotes-only] [--limit=N]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_LIST = resolve(ROOT, 'data/etf.json');
const OUT_HIST = resolve(ROOT, 'data/etf-historik');

const argv = process.argv.slice(2);
const QUOTES_ONLY = argv.includes('--quotes-only');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
// The three years of daily closes are fetched either way — the sparkline and
// every period return are derived from them — but they are only written to disk
// when something reads them. There is no fund page yet, and 24 MB of files that
// nothing opens would still be 24 MB rewritten in the repository twice a day.
const KEEP_HISTORY = argv.includes('--history');

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CONCURRENCY = 6;
const QUOTE_BATCH = 150;
const SPARK_POINTS = 30;

// Where a Danish investor's ETFs actually trade. Frankfurt and Amsterdam carry
// the UCITS funds Danish brokers sell; the three American venues carry the ones
// everybody has heard of. The Nordic exchanges list almost nothing — one fund
// in Copenhagen, two in Oslo — but those few are taken whole, because a Danish
// list that omits the only Danish-listed ETF would be strange.
//
// The cap is per venue and by fund size: Frankfurt alone lists six thousand
// share classes of a few hundred funds, and the tail is currency variants of
// the same thing.
const VENUES = [
  { code: 'GER', market: 'DE', label: 'Deutsche Börse Xetra', take: 500 },
  { code: 'AMS', market: 'NL', label: 'Euronext Amsterdam',   take: 250 },
  { code: 'PCX', market: 'US', label: 'NYSE Arca',            take: 450 },
  { code: 'BTS', market: 'US', label: 'Cboe BZX',             take: 250 },
  { code: 'NGM', market: 'US', label: 'Nasdaq',               take: 250 },
  { code: 'CPH', market: 'DK', label: 'Nasdaq København',     take: 50 },
  { code: 'STO', market: 'SE', label: 'Nasdaq Stockholm',     take: 50 },
  { code: 'OSL', market: 'NO', label: 'Oslo Børs',            take: 50 },
  { code: 'HEL', market: 'FI', label: 'Nasdaq Helsinki',      take: 50 },
];

// Below this a fund is a share class nobody holds, or a launch with no assets.
const MIN_NET_ASSETS_USD = 50e6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const isoDay = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);
// Samme oprydning som aktielisten: kilden leverer navne med dobbelte
// mellemrum og af og til i anførselstegn.
const cleanName = (n, fallback) => {
  // The source truncates long names, which can cut off the closing quote and
  // leave a lone leading one — "Sprott Physical Gold and Silve — so each end is
  // stripped on its own rather than only as a matched pair.
  const t = String(n == null ? '' : n)
    .replace(/\s+/g, ' ').trim()
    .replace(/^["']+/, '').replace(/["']+$/, '')
    .trim();
  return t || fallback || null;
};

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── Yahoo ────────────────────────────────────────────────────────────────
async function yahooSession() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': YF_UA } });
  const cookie = (r1.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('ingen cookies fra Yahoo');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { 'user-agent': YF_UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.startsWith('<')) throw new Error('ingen crumb');
  return { headers: { 'user-agent': YF_UA, cookie }, crumb };
}

// Yahoo throttles a long burst, and a throttled request looks exactly like a
// fund with no data. Back off and ask again rather than record an absence.
//
// A 401 is different: the crumb has gone stale, and asking again with the same
// one fails just as fast three times over. It is minted afresh instead — which
// is what emptied the whole fund list once, because nothing here did that.
async function retrying(fn, attempts = 4, session = null) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    if (a) await sleep(400 * Math.pow(2, a) + Math.random() * 300);
    try { return await fn(); } catch (err) {
      last = err;
      if (session && /HTTP 40[13]/.test(String(err.message))) {
        try {
          const fresh = await yahooSession();
          session.headers = fresh.headers;
          session.crumb = fresh.crumb;
          console.warn('  Yahoo afviste kaldet — ny session hentet');
        } catch { /* så fejler næste forsøg også, og det er svaret */ }
      }
    }
  }
  throw last;
}

// ── Universe ─────────────────────────────────────────────────────────────
async function screenVenue(venue, session) {
  const out = [];
  for (let offset = 0; offset < venue.take; offset += 250) {
    const size = Math.min(250, venue.take - offset);
    const body = {
      size, offset, sortField: 'fundnetassets', sortType: 'DESC',
      quoteType: 'ETF', topOperator: 'AND',
      query: { operator: 'AND', operands: [
        { operator: 'or', operands: [{ operator: 'EQ', operands: ['exchange', venue.code] }] },
      ] },
      userId: '', userIdType: 'guid',
    };
    const page = await retrying(async () => {
      const res = await fetch('https://query1.finance.yahoo.com/v1/finance/screener?crumb='
        + encodeURIComponent(session.crumb) + '&lang=en-US&region=US&formatted=false',
        { method: 'POST', headers: { ...session.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return (await res.json()).finance?.result?.[0]?.quotes || [];
    }, 4, session);
    if (!page.length) break;
    out.push(...page);
    if (page.length < size) break;
    await sleep(200);
  }
  return out;
}

async function buildUniverse(session, usdPer) {
  const seen = new Map();
  for (const venue of VENUES) {
    let rows = [];
    try { rows = await screenVenue(venue, session); }
    catch (err) { console.warn(`  ${venue.code} fejlede (${err.message})`); continue; }

    let kept = 0;
    for (const q of rows) {
      if (!q.symbol || seen.has(q.symbol)) continue;
      // Net assets are reported in the fund's own currency; the floor is in
      // dollars, so a Swedish fund is measured on the same scale as an American.
      const rate = usdPer[q.currency];
      const usd = q.netAssets != null && rate ? q.netAssets / rate : null;
      if (usd != null && usd < MIN_NET_ASSETS_USD) continue;
      seen.set(q.symbol, {
        symbol: q.symbol,
        name: cleanName(q.longName || q.shortName, q.symbol),
        exchange: venue.label,
        market: venue.market,
        currency: q.currency || null,
        net_assets: q.netAssets ?? null,
      });
      kept++;
    }
    console.log(`  ${venue.code} ${String(rows.length).padStart(4)} fundet → ${kept} med`);
    await sleep(200);
  }
  return [...seen.values()];
}

// ── Rates ────────────────────────────────────────────────────────────────
// Same source the stock list uses, so a figure converted on one page matches
// the same figure on the other.
async function fetchRates() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=DKK');
  if (!res.ok) throw new Error('valutakurser HTTP ' + res.status);
  const j = await res.json();
  const perDkk = { ...j.rates, DKK: 1 };            // 1 DKK = x fremmed valuta
  const usdPer = {};                                 // 1 USD = x fremmed valuta
  for (const [cur, v] of Object.entries(perDkk)) usdPer[cur] = v / perDkk.USD;
  return { date: j.date, perDkk, usdPer, usd: round(1 / perDkk.USD, 4) };
}

// GBp is pence, not pounds — a hundredth of the quoted currency.
function toDkk(value, currency, perDkk) {
  if (value == null || !currency) return null;
  if (currency === 'GBp') return perDkk.GBP ? value / 100 / perDkk.GBP : null;
  const rate = perDkk[currency];
  return rate ? value / rate : null;
}

// ── Quotes ───────────────────────────────────────────────────────────────
async function fetchQuotes(symbols, session) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const chunk = symbols.slice(i, i + QUOTE_BATCH);
    try {
      const rows = await retrying(async () => {
        const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
          + encodeURIComponent(chunk.join(',')) + '&crumb=' + encodeURIComponent(session.crumb);
        const res = await fetch(url, { headers: session.headers });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return (await res.json()).quoteResponse?.result || [];
      }, 4, session);
      for (const q of rows) {
        if (!q.symbol) continue;
        out.set(q.symbol, {
          price: q.regularMarketPrice ?? null,
          change: q.regularMarketChange ?? null,
          percent_change: q.regularMarketChangePercent ?? null,
          previous_close: q.regularMarketPreviousClose ?? null,
          currency: q.currency || null,
          net_assets: q.netAssets ?? null,
          ytd: q.ytdReturn ?? null,
          delayed_by: q.exchangeDataDelayedBy ?? null,
        });
      }
    } catch (err) { console.warn(`  kurser ${i}–${i + chunk.length} fejlede (${err.message})`); }
    await sleep(150);
  }
  return out;
}

// ── History ──────────────────────────────────────────────────────────────
// Trading days, not calendar days: a week is five sessions, a year is 252.
const WINDOWS = { change_7d: 5, change30d: 30, change_6m: 126, change_1y: 252, change_3y: 756 };

function moveOver(closes, back) {
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - back];
  return base && last != null ? round(((last - base) / base) * 100, 2) : null;
}

async function fetchHistory(symbol, session) {
  return retrying(async () => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
      + '?interval=1d&range=3y';
    const res = await fetch(url, { headers: session.headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = (await res.json()).chart?.result?.[0];
    const stamps = r?.timestamp || [], closes = r?.indicators?.quote?.[0]?.close || [];
    const dates = [], vals = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || stamps[i] == null) continue;
      dates.push(isoDay(stamps[i]));
      vals.push(round(closes[i], 4));
    }
    if (dates.length < 2) throw new Error('kun ' + dates.length + ' punkter');
    return { dates, closes: vals };
  });
}

function derive(hist) {
  const c = hist.closes;
  const out = { spark: c.slice(-SPARK_POINTS) };
  for (const [key, back] of Object.entries(WINDOWS)) out[key] = moveOver(c, back);
  const year = c.slice(-252);
  out.high_52w = round(Math.max(...year), 4);
  out.low_52w = round(Math.min(...year), 4);
  out.first_date = hist.dates[0];
  return out;
}

// ── Profile ──────────────────────────────────────────────────────────────
// The provider is always there. The category and the ongoing charge are filled
// in for the American funds and almost never for the European ones, so they are
// carried as null rather than as a zero the page would print as "0,00 %".
async function fetchProfile(symbol, session) {
  return retrying(async () => {
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
      + '?modules=fundProfile&formatted=false&crumb=' + encodeURIComponent(session.crumb);
    const res = await fetch(url, { headers: session.headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fp = (await res.json()).quoteSummary?.result?.[0]?.fundProfile;
    if (!fp) throw new Error('ingen fundProfile');
    const fee = fp.feesExpensesInvestment?.annualReportExpenseRatio;
    return {
      family: fp.family || null,
      category: fp.categoryName || null,
      expense_ratio: fee ? round(fee * 100, 3) : null,   // 0 betyder "ikke oplyst"
    };
  }, 3, session);
}

// ── Output ───────────────────────────────────────────────────────────────
async function writeJson(path, value, compact) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, compact ? JSON.stringify(value) + '\n' : JSON.stringify(value, null, 2) + '\n');
}

async function main() {
  const session = await yahooSession();
  const fx = await fetchRates();
  console.log(`USD→DKK ${fx.usd} (ECB ${fx.date})`);

  let universe;
  if (QUOTES_ONLY) {
    universe = (JSON.parse(await readFile(OUT_LIST, 'utf8')).etfs || [])
      .map((e) => ({ symbol: e.symbol, name: e.name, exchange: e.exchange, market: e.market,
                     currency: e.currency, net_assets: e.net_assets, family: e.family,
                     category: e.category, expense_ratio: e.expense_ratio }));
    console.log(`Univers genbrugt: ${universe.length} ETF'er`);
  } else {
    console.log('Screener:');
    universe = await buildUniverse(session, fx.usdPer);
    console.log(`Univers: ${universe.length} ETF'er`);
  }
  if (LIMIT) universe = universe.slice(0, LIMIT);

  console.log('Kurser…');
  const quotes = await fetchQuotes(universe.map((e) => e.symbol), session);

  console.log('Historik og profiler…');
  let done = 0;
  const failed = [];
  const rows = await pool(universe, CONCURRENCY, async (e) => {
    const q = quotes.get(e.symbol);
    if (!q || q.price == null) { failed.push({ symbol: e.symbol, reason: 'ingen kurs' }); return null; }

    let hist = null, extra = {};
    if (!QUOTES_ONLY) {
      try {
        hist = await fetchHistory(e.symbol, session);
        if (KEEP_HISTORY) {
          await writeJson(resolve(OUT_HIST, e.symbol + '.json'),
            { symbol: e.symbol, dates: hist.dates, closes: hist.closes }, true);
        }
      } catch (err) { failed.push({ symbol: e.symbol, reason: 'historik: ' + err.message }); }
      try { extra = await fetchProfile(e.symbol, session); } catch { extra = {}; }
    }
    if (++done % 100 === 0) console.log(`  ${done}/${universe.length}…`);

    const currency = q.currency || e.currency;
    const net = q.net_assets ?? e.net_assets ?? null;
    return {
      symbol: e.symbol,
      name: e.name,
      exchange: e.exchange,
      market: e.market,
      currency,
      price: round(q.price, 4),
      price_dkk: round(toDkk(q.price, currency, fx.perDkk), 4),
      change: round(q.change, 4),
      percent_change: round(q.percent_change, 2),
      previous_close: round(q.previous_close, 4),
      net_assets: net,
      net_assets_dkk: round(toDkk(net, currency, fx.perDkk), 0),
      ytd: round(q.ytd, 2),
      delayed_by: q.delayed_by,
      family: extra.family ?? e.family ?? null,
      category: extra.category ?? e.category ?? null,
      expense_ratio: extra.expense_ratio ?? e.expense_ratio ?? null,
      ...(hist ? derive(hist) : {}),
    };
  });

  const etfs = rows.filter(Boolean).sort((a, b) => (b.net_assets_dkk ?? -1) - (a.net_assets_dkk ?? -1));
  etfs.forEach((e, i) => { e.rank = i + 1; });

  // Et tomt eller stærkt afkortet resultat er en fejl i hentningen, ikke en
  // nyhed om markedet — og den fil der allerede ligger, er rigtig. Da Yahoo
  // afviste screeneren med 401, skrev denne linje 0 fonde hen over 1.728 og
  // committede det. Nu bliver den stående.
  let existing = 0;
  try { existing = (JSON.parse(await readFile(OUT_LIST, 'utf8')).etfs || []).length; } catch { /* ingen fil endnu */ }
  if (!LIMIT && existing && etfs.length < existing * 0.5) {
    console.error(`Kun ${etfs.length} ETF'er mod ${existing} i den nuværende fil — skriver ikke.`);
    console.error('Det er en fejl i hentningen, ikke en ændring i markedet. Den gamle fil beholdes.');
    process.exit(1);
  }
  if (!etfs.length) {
    console.error('Ingen ETF\'er hentet — skriver ikke.');
    process.exit(1);
  }

  await writeJson(OUT_LIST, {
    updated_at: new Date().toISOString(),
    source: 'Yahoo Finance',
    fx: { base: 'DKK', date: fx.date, usd: fx.usd },
    count: etfs.length,
    etfs,
    failed,
  }, true);

  console.log(`Skrev ${etfs.length} ETF'er` + (failed.length ? `, ${failed.length} fejlede` : ''));
}

main().catch((err) => { console.error(err); process.exit(1); });

// Build-time fetch of Danish and US stock quotes.
//
// Runs in GitHub Actions, not in a browser, so there is no CORS restriction and
// no API key: Yahoo's chart endpoint, Wikipedia and the ECB rates behind
// Frankfurter all answer plain HTTP requests from a server. Results are
// committed as JSON and the pages read those files, so the site stays a static
// deploy with nothing secret in it.
//
// Writes:
//   data/univers.json         – the resolved ticker universe, and the fallback
//                               when Wikipedia is unreachable
//   data/aktier.json          – one row per company, plus a 30-point sparkline
//   data/historik/<SYM>.json  – two years of daily closes plus a long series
//                               back to the listing, one file per company
//   data/nogletal.json        – per-share and statement figures for every
//                               company, small enough for any page to hold,
//                               plus the median P/E per sector
//   data/regnskab/<SYM>.json  – earnings calendar, four quarters of estimates
//                               against actuals, ownership and insider trades
//   data/indeks.json          – two years of closes for the benchmark indices
//
// Run locally with:  node scripts/fetch-stocks.mjs
//   --quotes-only   reuse data/univers.json instead of refreshing constituents
//   --no-history    skip writing the history files
//   --limit=N       only the first N companies, for a quick local check

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_UNIVERSE = resolve(ROOT, 'data/univers.json');
const OUT_LIST     = resolve(ROOT, 'data/aktier.json');
const OUT_HIST_DIR = resolve(ROOT, 'data/historik');
const OUT_KEY      = resolve(ROOT, 'data/nogletal.json');
const OUT_BENCH    = resolve(ROOT, 'data/indeks.json');
const OUT_FUND_DIR = resolve(ROOT, 'data/regnskab');

const argv = process.argv.slice(2);
const QUOTES_ONLY = argv.includes('--quotes-only');
const NO_HISTORY  = argv.includes('--no-history');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

// ── Danish universe ──────────────────────────────────────────────────────
// Nasdaq Copenhagen has no maintained constituent page worth scraping, so its
// large caps are listed here. Sector names use the same GICS vocabulary the
// S&P table supplies, so one sector filter covers both markets.
const DANISH = [
  ['NOVO-B.CO',   'Novo Nordisk B',         'Health Care'],
  ['MAERSK-B.CO', 'A.P. Møller - Mærsk B',  'Industrials'],
  ['MAERSK-A.CO', 'A.P. Møller - Mærsk A',  'Industrials'],
  ['DSV.CO',      'DSV',                    'Industrials'],
  ['NSIS-B.CO',   'Novonesis B',            'Materials'],
  ['VWS.CO',      'Vestas Wind Systems',    'Industrials'],
  ['ORSTED.CO',   'Ørsted',                 'Utilities'],
  ['DANSKE.CO',   'Danske Bank',            'Financials'],
  ['COLO-B.CO',   'Coloplast B',            'Health Care'],
  ['GMAB.CO',     'Genmab',                 'Health Care'],
  ['CARL-B.CO',   'Carlsberg B',            'Consumer Staples'],
  ['PNDORA.CO',   'Pandora',                'Consumer Discretionary'],
  ['TRYG.CO',     'Tryg',                   'Financials'],
  ['DEMANT.CO',   'Demant',                 'Health Care'],
  ['ROCK-B.CO',   'Rockwool B',             'Industrials'],
  ['AMBU-B.CO',   'Ambu B',                 'Health Care'],
  ['ZEAL.CO',     'Zealand Pharma',         'Health Care'],
  ['GN.CO',       'GN Store Nord',          'Health Care'],
  ['JYSK.CO',     'Jyske Bank',             'Financials'],
  ['ISS.CO',      'ISS',                    'Industrials'],
  ['NKT.CO',      'NKT',                    'Industrials'],
  ['BAVA.CO',     'Bavarian Nordic',        'Health Care'],
  ['RBREW.CO',    'Royal Unibrew',          'Consumer Staples'],
  ['NETC.CO',     'Netcompany Group',       'Information Technology'],
];

// The Nasdaq-100 table classifies under ICB, the S&P table under GICS. Two
// vocabularies for the same idea would split the sector filter in half, so the
// ICB names fold into their GICS equivalents.
const SECTOR_ALIASES = {
  'Technology': 'Information Technology',
  'Telecommunications': 'Communication Services',
  'Consumer Cyclicals': 'Consumer Discretionary',
  'Consumer Non-Cyclicals': 'Consumer Staples',
  'Basic Materials': 'Materials',
  'Health care': 'Health Care',
};
const normSector = (s) => SECTOR_ALIASES[s] || s || 'Ukendt';

// Index tables quote share classes with a dot; Yahoo uses a dash (BRK.B → BRK-B).
const normTicker = (t) => String(t).trim().toUpperCase().replace(/\./g, '-');

const MIN_OK_RATIO = 0.7;
const SPARK_POINTS = 30;
const RETRIES = 3;
const CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── Constituents ─────────────────────────────────────────────────────────
function parseWikiTable(htmlText) {
  const table = htmlText.match(/<table[^>]*id="constituents"[^>]*>([\s\S]*?)<\/table>/);
  if (!table) throw new Error('constituents-tabellen blev ikke fundet');

  const strip = (c) => c.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\[\d+\]/g, '').trim();

  const rows = [];
  for (const tr of table[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [])
      .map((c) => strip(c.replace(/^<t[dh][^>]*>/, '').replace(/<\/t[dh]>$/, '')));
    if (cells.length >= 3) rows.push(cells);
  }
  return rows.slice(1); // drop the header row
}

async function fetchWiki(page) {
  const res = await fetch('https://en.wikipedia.org/wiki/' + page, {
    headers: { 'user-agent': 'aktiekurser/1.0 (build-time constituent refresh)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseWikiTable(await res.text());
}

async function buildUniverse() {
  const byTicker = new Map();

  const add = (ticker, name, sector, index) => {
    const t = normTicker(ticker);
    if (!t || !/^[A-Z0-9-]{1,12}$/.test(t)) return;
    const existing = byTicker.get(t);
    if (existing) { if (!existing.indices.includes(index)) existing.indices.push(index); return; }
    byTicker.set(t, { symbol: t, name, sector: normSector(sector), market: 'US', indices: [index] });
  };

  const [sp, ndx] = await Promise.all([
    fetchWiki('List_of_S%26P_500_companies').catch((e) => { console.warn('  S&P 500 fejlede:', e.message); return null; }),
    fetchWiki('List_of_NASDAQ-100_companies').catch((e) => { console.warn('  Nasdaq-100 fejlede:', e.message); return null; }),
  ]);

  if (sp)  for (const r of sp)  add(r[0], r[1], r[2], 'SP500');
  if (ndx) for (const r of ndx) add(r[0], r[1], r[2], 'NDX');

  // A partial scrape would silently shrink the site, so treat it as a failure
  // and let the caller fall back to the committed universe.
  if (byTicker.size < 400) throw new Error('for få amerikanske selskaber (' + byTicker.size + ')');

  for (const [symbol, name, sector] of DANISH) {
    byTicker.set(symbol, { symbol, name, sector: normSector(sector), market: 'DK', indices: ['DK-LARGE'] });
  }

  const companies = [...byTicker.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    source: 'Wikipedia (S&P 500 + Nasdaq-100), samt en fast liste for Nasdaq København',
    counts: {
      total: companies.length,
      sp500: companies.filter((c) => c.indices.includes('SP500')).length,
      ndx:   companies.filter((c) => c.indices.includes('NDX')).length,
      dk:    DANISH.length,
    },
    companies,
  };
}

// ── FX ───────────────────────────────────────────────────────────────────
// ECB reference rates via Frankfurter: keyless, quoted against EUR, so USD→DKK
// is derived by dividing the two legs.
async function fetchUsdDkk() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=DKK,USD',
    { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('FX HTTP ' + res.status);
  const { date, rates } = await res.json();
  if (!rates?.DKK || !rates?.USD) throw new Error('FX mangler DKK eller USD');
  return { rate: Number((rates.DKK / rates.USD).toFixed(6)), date, source: 'ECB via Frankfurter' };
}

// ── Market cap ───────────────────────────────────────────────────────────
// The chart endpoint carries no market cap, and the quote endpoint that does
// requires a crumb. Yahoo hands one out to anyone who asks: fetch cookies, swap
// them for a crumb, then send both. Still no account and no API key — but it is
// an undocumented flow, so every failure here is non-fatal: without it the rows
// simply carry no rank and the pages hide the column.
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CAP_BATCH = 150;

// One handshake, reused by everything below that needs it.
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

// 150 symbols a request, so the whole universe costs four round trips. Earnings
// per share is stored rather than the P/E Yahoo also reports: the pages divide
// it into the price they are showing, so the ratio can never disagree with the
// figure printed beside it.
async function fetchQuoteFields(symbols, session) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += CAP_BATCH) {
    const chunk = symbols.slice(i, i + CAP_BATCH);
    const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
      + encodeURIComponent(chunk.join(',')) + '&crumb=' + encodeURIComponent(session.crumb);
    const res = await fetch(url, { headers: session.headers });
    if (!res.ok) throw new Error('quote HTTP ' + res.status);
    const json = await res.json();
    for (const q of json.quoteResponse?.result || []) {
      if (!q.symbol) continue;
      out.set(q.symbol, {
        market_cap: q.marketCap ?? null,
        eps_ttm: q.epsTrailingTwelveMonths ?? null,
        eps_fwd: q.epsForward ?? null,
        book_value: q.bookValue ?? null,
        div_yield: q.dividendYield ?? null,             // allerede i procent
        shares: q.sharesOutstanding ?? null,
        rating: q.averageAnalystRating ?? null,
        next_earnings: q.earningsTimestampStart ? isoDay(q.earningsTimestampStart) : null,
      });
    }
    await sleep(200);
  }
  return out;
}

const isoDay = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);
const raw = (o) => (o && o.raw != null && Number.isFinite(o.raw) ? o.raw : null);

// The statement figures, the earnings calendar, the analysts' record against
// this company, who owns it and what the insiders have been doing. One request
// per symbol — about nine seconds for the whole universe — and every failure is
// non-fatal, so a company simply carries no key figures.
const FUND_MODULES = ['defaultKeyStatistics', 'financialData', 'calendarEvents',
  'earningsHistory', 'majorHoldersBreakdown', 'insiderTransactions', 'summaryDetail'].join(',');

// Yahoo's transaction text is prose. Only these two forms are someone deciding
// to trade with their own money; grants, gifts and option exercises are pay, and
// lumping them together would make routine compensation look like conviction.
function insiderKind(text) {
  const t = String(text || '').toLowerCase();
  if (t.startsWith('purchase at price')) return 'buy';
  if (t.startsWith('sale at price')) return 'sell';
  return 'other';
}

async function fetchFundamentals(symbol, session) {
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
    + '?modules=' + FUND_MODULES + '&crumb=' + encodeURIComponent(session.crumb);
  const res = await fetch(url, { headers: session.headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const r = (await res.json()).quoteSummary?.result?.[0];
  if (!r) throw new Error('tomt svar');

  const ks = r.defaultKeyStatistics || {}, fd = r.financialData || {};
  const sd = r.summaryDetail || {}, mh = r.majorHoldersBreakdown || {};
  const ev = r.calendarEvents?.earnings || {};
  const revenue = raw(fd.totalRevenue), fcf = raw(fd.freeCashflow);

  return {
    // Small enough for every page to hold for every company.
    small: {
      eps_ttm: raw(ks.trailingEps),
      pb: raw(ks.priceToBook),
      revenue: revenue,
      revenue_growth: raw(fd.revenueGrowth),
      fcf: fcf,
      fcf_margin: revenue && fcf != null ? round(fcf / revenue, 4) : null,
      profit_margin: raw(fd.profitMargins),
      gross_margin: raw(fd.grossMargins),
      inst_pct: raw(mh.institutionsPercentHeld),
      ins_pct: raw(mh.insidersPercentHeld),
      peg: raw(ks.pegRatio),
    },
    // Only the company page reads this.
    detail: {
      next_earnings: ev.earningsDate?.[0]?.fmt || null,
      earnings_estimated: ev.isEarningsDateEstimate === true,
      earnings_call: ev.earningsCallDate?.[0]?.fmt || null,
      eps_estimate: raw(ev.earningsAverage),
      ex_dividend: sd.exDividendDate?.fmt || null,
      dividend_date: sd.dividendDate?.fmt || null,
      payout_ratio: raw(sd.payoutRatio),
      inst_count: raw(mh.institutionsCount),
      eps_history: (r.earningsHistory?.history || [])
        .filter((h) => raw(h.epsActual) != null && raw(h.epsEstimate) != null)
        .map((h) => ({
          quarter: h.quarter?.fmt || null,
          estimate: raw(h.epsEstimate),
          actual: raw(h.epsActual),
          surprise_pct: raw(h.surprisePercent) == null ? null : round(raw(h.surprisePercent) * 100, 2),
        })),
      insiders: (r.insiderTransactions?.transactions || [])
        .filter((t) => t.startDate?.fmt)
        .slice(0, 10)
        .map((t) => ({
          name: t.filerName || null,
          role: t.filerRelation || null,
          kind: insiderKind(t.transactionText),
          text: t.transactionText || null,
          value: raw(t.value),
          shares: raw(t.shares),
          date: t.startDate.fmt,
        })),
    },
  };
}

// The yardsticks a company's own move is measured against. Four series, four
// requests, and the pages read closes only.
const BENCHMARKS = [
  { code: 'NDX',    symbol: '^NDX',     label: 'Nasdaq-100' },
  { code: 'SP500',  symbol: '^GSPC',    label: 'S&P 500' },
  { code: 'SOX',    symbol: '^SOX',     label: 'Semiconductors' },
  { code: 'OMXC25', symbol: '^OMXC25',  label: 'OMX København 25' },
];

async function fetchBenchmarks() {
  const out = {};
  for (const b of BENCHMARKS) {
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(b.symbol)
        + '?interval=1d&range=2y';
      const res = await fetch(url, { headers: { 'user-agent': YF_UA, accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json()).chart?.result?.[0];
      const stamps = r?.timestamp || [], closes = r?.indicators?.quote?.[0]?.close || [];
      const dates = [], vals = [];
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] == null || stamps[i] == null) continue;
        dates.push(isoDay(stamps[i]));
        vals.push(round(closes[i], 2));
      }
      if (dates.length) out[b.code] = { label: b.label, symbol: b.symbol, dates, closes: vals };
    } catch (err) {
      console.warn('  benchmark ' + b.code + ' fejlede (' + err.message + ')');
    }
    await sleep(150);
  }
  return out;
}

// Index membership is weighted by market value, so ordering the members by
// market cap reproduces the index order closely. It is not identical: S&P
// weights float-adjusted shares and Nasdaq applies a modified scheme on top, so
// the pages call this a market-value rank rather than an official index weight.
function assignRanks(rows) {
  // Yahoo reports market cap in the listing currency, so a Danish company's
  // figure is in kroner and a US one in dollars. Ranking the whole universe on
  // the raw number would compare 1.3e12 DKK against 5.6e12 USD and place the
  // Danish names roughly six times too high. Cross-market ranking therefore
  // uses the converted figure; ranking inside one index needs no conversion,
  // since its members all share a currency.
  const byCap = (field) => (a, b) => (b[field] ?? -1) - (a[field] ?? -1);
  const rankWithin = (subset, field, on) => {
    subset.filter((r) => r[on] != null).sort(byCap(on))
      .forEach((r, i) => { r[field] = i + 1; });
  };
  rankWithin(rows, 'rank_all', 'market_cap_dkk');
  rankWithin(rows.filter((r) => (r.indices || []).includes('SP500')), 'rank_sp500', 'market_cap');
  rankWithin(rows.filter((r) => (r.indices || []).includes('NDX')), 'rank_ndx', 'market_cap');
  rankWithin(rows.filter((r) => r.market === 'DK'), 'rank_dk', 'market_cap');
}

// ── Quotes ───────────────────────────────────────────────────────────────
async function fetchTicker(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?interval=1d&range=2y';

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; aktiekurser/1.0)', accept: 'application/json' },
      });
      // Back off harder on throttling than on an ordinary error.
      if (res.status === 429) throw new Error('429 rate limited');
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const json = await res.json();
      if (json?.chart?.error) throw new Error(json.chart.error.description || 'chart error');
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('tomt svar');
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(attempt * (/429/.test(err.message) ? 3000 : 700));
    }
  }
  throw lastErr;
}

// Yahoo answers range=max with monthly closes whatever interval is asked for,
// which is ~20 KB per company and reaches back to the listing. That is enough
// for an all-time high, accurate to the month; combining it with the daily
// series below makes the recent two years exact, and a stock's peak is usually
// recent anyway. Failure is non-fatal — the fields stay null.
async function fetchLifetime(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol) + '?interval=1mo&range=max';
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; aktiekurser/1.0)', accept: 'application/json' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error('tomt svar');

  const stamps = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];

  // A bar is stamped with the period's FIRST day but carries its LAST close —
  // verified against the daily series, where the bar stamped 2025-09-01 holds
  // the close of 2025-09-30. Left alone, every long-range date would be adrift
  // from the price beside it.
  //
  // The period is not always a month: Yahoo quietly downsamples long histories,
  // so range=max returns quarterly bars for a company listed in the 1980s even
  // when a month was asked for. Rather than trust the granularity it reports,
  // each bar is dated the day before the next one opens, which is right for any
  // period length. The final bar keeps its own stamp — Yahoo dates the running
  // period with its real last trading day.
  // Period bars are stamped at midnight in the exchange's own timezone, which
  // in Copenhagen is 22:00 UTC the day before — so read straight out of UTC,
  // every Danish month started on the 31st of the month before. The daily bars
  // are stamped during trading hours and are unaffected, which is why this
  // correction lives here and not in the daily fetch.
  const tz = r.meta?.gmtoffset || 0;
  const day = (secs) => new Date((secs + tz) * 1000).toISOString().slice(0, 10);
  const dayBefore = (iso) => new Date(new Date(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

  // Granularity is not fixed either. A company listed last year gets daily bars
  // back from range=max, and there the stamp already IS the date — applying the
  // period rule to it would push every Friday onto the Sunday.
  const granularity = r.meta?.dataGranularity || '1mo';
  if (!/(wk|mo|y)$/.test(granularity)) {
    const byDay = new Map();
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && stamps[i] != null) byDay.set(day(stamps[i]), closes[i]);
    }
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, close]) => ({ date, close }));
  }

  // Yahoo also appends a snapshot bar for right now, stamped with a real
  // trading day rather than a period boundary, on top of the bar for the period
  // that day falls in. Both carry the same close, so the period bar is dropped
  // and the snapshot kept: keeping both would end the series with today's price
  // twice, the second time under an earlier date.
  const last = stamps.length - 1;
  const snapshot = last >= 1 && stamps[last] != null && day(stamps[last]).slice(-2) !== '01';
  const upTo = snapshot ? last - 2 : last;

  const byDate = new Map();
  for (let i = 0; i <= upTo; i++) {
    if (closes[i] == null || stamps[i] == null) continue;
    // The bar closed the day before the next one opened, whatever the period
    // length — which is what makes this safe against the quarterly downsampling.
    const end = stamps[i + 1] != null ? dayBefore(day(stamps[i + 1])) : day(stamps[i]);
    byDate.set(end, closes[i]);
  }
  if (snapshot && closes[last] != null) byDate.set(day(stamps[last]), closes[last]);

  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, close]) => ({ date, close }));
}


// Everything here is derived from the daily series we already hold, so it costs
// no extra request. Each figure is labelled as computed on the page.
function computeStats(dates, closes, volumes) {
  const n = closes.length;
  const win = Math.min(n - 1, 252);              // one trading year, or all we have
  const stats = {};

  // Daily returns over the window
  const rets = [];
  for (let i = n - win; i < n; i++) {
    const prev = closes[i - 1];
    if (prev) rets.push({ r: (closes[i] - prev) / prev, date: dates[i] });
  }

  if (rets.length) {
    const best = rets.reduce((a, b) => (b.r > a.r ? b : a));
    const worst = rets.reduce((a, b) => (b.r < a.r ? b : a));
    stats.best_day = { pct: round(best.r * 100, 2), date: best.date };
    stats.worst_day = { pct: round(worst.r * 100, 2), date: worst.date };
    stats.up_days = rets.filter((x) => x.r > 0).length;
    stats.trading_days = rets.length;

    // Annualised volatility: the spread of daily moves, scaled by root-252.
    const mean = rets.reduce((a, x) => a + x.r, 0) / rets.length;
    const varc = rets.reduce((a, x) => a + (x.r - mean) ** 2, 0) / rets.length;
    stats.volatility = round(Math.sqrt(varc) * Math.sqrt(252) * 100, 1);
  }

  // Current run of up or down days, and the longest run in the window.
  let cur = 0, dir = 0, bestUp = 0, bestDown = 0, run = 0, runDir = 0;
  for (let i = 1; i < n; i++) {
    const d = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    if (d === 0) { run = 0; runDir = 0; continue; }
    if (d === runDir) run++; else { runDir = d; run = 1; }
    if (d === 1) bestUp = Math.max(bestUp, run); else bestDown = Math.max(bestDown, run);
  }
  cur = run; dir = runDir;
  stats.streak = { days: cur, dir };
  stats.longest_up = bestUp;
  stats.longest_down = bestDown;

  // Moving averages — the levels chart-readers quote most often.
  const ma = (k) => (n >= k ? round(closes.slice(-k).reduce((a, x) => a + x, 0) / k) : null);
  stats.ma50 = ma(50);
  stats.ma200 = ma(200);

  if (volumes.length) {
    let mi = 0;
    for (let i = 1; i < volumes.length; i++) if (volumes[i] > volumes[mi]) mi = i;
    // volumes was filled in step with closes, so the index maps onto dates
    stats.max_volume = { volume: volumes[mi], date: dates[Math.min(mi, dates.length - 1)] };
  }
  return stats;
}

function normalise(result, company, usdDkk) {
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};

  // Yahoo pads non-trading days with nulls; drop those, keeping dates aligned.
  const stamps = result.timestamp || [];
  const rawCloses = quote.close || [];
  const rawVolumes = quote.volume || [];
  const dates = [], closes = [], volumes = [];
  for (let i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] == null || stamps[i] == null) continue;
    dates.push(new Date(stamps[i] * 1000).toISOString().slice(0, 10));
    closes.push(round(rawCloses[i]));
    if (rawVolumes[i] != null) volumes.push(rawVolumes[i]);
  }
  if (closes.length < 2) throw new Error('for få lukkekurser');

  // Yahoo's chart meta carries no average volume, so it is the mean of the last
  // 60 sessions — a computed statistic over real values, labelled as computed
  // on the page rather than passed off as a source field.
  const recent = volumes.slice(-60);
  const averageVolume = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;

  const price = round(meta.regularMarketPrice ?? closes[closes.length - 1]);

  // The day's move is measured against the previous session's close. Yahoo's
  // chartPreviousClose is the close before the whole range starts, so using it
  // here would label a two-year move as "i dag".
  const previousClose = closes[closes.length - 2];
  const change = price - previousClose;

  // Longer horizons come off the same series. ~252 sessions is a trading year;
  // when the history is shorter than a window the field stays null rather than
  // quietly reporting a shorter one.
  const moveOver = (sessions) => {
    if (closes.length <= sessions) return null;
    const then = closes[closes.length - 1 - sessions];
    return then ? round(((price - then) / then) * 100, 4) : null;
  };

  const currency = meta.currency || (company.market === 'DK' ? 'DKK' : 'USD');
  // One derived field, kept beside the untouched native price, so the pages can
  // offer a DKK view without any table figure being a silent conversion.
  const toDkk = (n) => (n == null ? null : currency === 'DKK' ? n : round(n * usdDkk));

  return {
    row: {
      symbol: meta.symbol || company.symbol,
      name: meta.shortName || company.name,
      market: company.market,
      sector: company.sector,
      indices: company.indices,
      exchange: meta.fullExchangeName || '',
      currency,
      price,
      price_dkk: toDkk(price),
      previous_close: round(previousClose),
      change: round(change),
      percent_change: round(previousClose ? (change / previousClose) * 100 : null, 4),
      change_7d: moveOver(5),      // en handelsuge ≈ syv kalenderdage
      change_6m: moveOver(126),
      change_1y: moveOver(252),
      high: round(meta.regularMarketDayHigh),
      low: round(meta.regularMarketDayLow),
      market_cap: null,      // i noteringsvalutaen; udfyldes efter batch-hentningen
      market_cap_dkk: null,  // samme tal i kroner, så tværmarkeds-rangering er meningsfuld
      rank_all: null, rank_sp500: null, rank_ndx: null, rank_dk: null,
      volume: meta.regularMarketVolume ?? null,
      average_volume: averageVolume,
      average_volume_days: recent.length,
      week52_low: round(meta.fiftyTwoWeekLow),
      week52_high: round(meta.fiftyTwoWeekHigh),
      stats: computeStats(dates, closes, volumes),
      ath: null, ath_date: null, first_trade_date: null, drawdown_pct: null,
      spark: closes.slice(-SPARK_POINTS),
      quote_time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    },
    history: { dates, closes },
  };
}

// ── Output ───────────────────────────────────────────────────────────────
// Leave a file alone when nothing but the timestamp would change. updated_at is
// a clock reading, so rewriting unconditionally would dirty every file on every
// run — including holidays, when the exchanges are shut and nothing moved.
async function writeIfChanged(path, body, label) {
  try {
    const { updated_at, ...previous } = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(previous) === JSON.stringify(body)) {
      if (label) console.log('  ' + label + ': uændret');
      return false;
    }
  } catch { /* ingen brugbar tidligere fil; skriv en ny */ }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ updated_at: new Date().toISOString(), ...body }, null, 2) + '\n', 'utf8');
  if (label) console.log('  ' + label + ': skrevet');
  return true;
}

async function main() {
  // 1. Universe
  let universe;
  if (QUOTES_ONLY) {
    universe = JSON.parse(await readFile(OUT_UNIVERSE, 'utf8'));
    console.log(`Univers genbrugt: ${universe.companies.length} selskaber`);
  } else {
    try {
      universe = await buildUniverse();
      console.log(`Univers: ${universe.counts.total} selskaber `
        + `(S&P 500: ${universe.counts.sp500}, Nasdaq-100: ${universe.counts.ndx}, DK: ${universe.counts.dk})`);
      await writeIfChanged(OUT_UNIVERSE, universe, 'univers.json');
    } catch (err) {
      console.warn('Kunne ikke opdatere universet (' + err.message + ') — bruger den committede liste.');
      universe = JSON.parse(await readFile(OUT_UNIVERSE, 'utf8'));
    }
  }

  // 2. FX
  const fx = await fetchUsdDkk();
  console.log(`USD→DKK ${fx.rate} (ECB ${fx.date})`);

  // 3. Quotes
  const companies = LIMIT ? universe.companies.slice(0, LIMIT) : universe.companies;
  const t0 = Date.now();
  let done = 0;
  const results = await pool(companies, CONCURRENCY, async (c) => {
    try {
      const out = normalise(await fetchTicker(c.symbol), c, fx.rate);
      if (++done % 100 === 0) console.log(`  ${done}/${companies.length}…`);
      return out;
    } catch (err) { done++; return { failed: c.symbol, reason: err.message }; }
  });

  const rows = [], history = {}, failed = [];
  for (const r of results) {
    if (!r || r.failed) { if (r) failed.push(r.failed); continue; }
    rows.push(r.row);
    history[r.row.symbol] = r.history;
  }

  const ratio = rows.length / companies.length;
  console.log(`\n${rows.length}/${companies.length} hentet (${(ratio * 100).toFixed(1)}%) på ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed.length) {
    console.log('  fejlede:', failed.slice(0, 20).join(', ') + (failed.length > 20 ? ` … +${failed.length - 20}` : ''));
  }

  if (ratio < MIN_OK_RATIO) {
    console.error(`For mange fejlede (kræver ${MIN_OK_RATIO * 100}%). Beholder de eksisterende datafiler.`);
    process.exit(1);
  }

  // 4. All-time highs and lows
  // A second pass, because the 2-year window the pages chart cannot tell you
  // how far a stock sits below its peak. The monthly series is combined with
  // the daily one already held, so the last two years stay day-accurate.
  let athOk = 0;
  const lifetime = {};
  await pool(rows, CONCURRENCY, async (r) => {
    try {
      const monthly = await fetchLifetime(r.symbol);
      if (!monthly.length) return;
      const recent = (history[r.symbol]?.closes || []).map((c, i) => ({ date: history[r.symbol].dates[i], close: c }));
      const all = monthly.concat(recent);

      const hi = all.reduce((a, x) => (x.close > a.close ? x : a));
      r.ath = round(hi.close); r.ath_date = hi.date;
      r.first_trade_date = monthly[0].date;
      // Drawdown is negative or zero; a stock at its peak reads 0.
      r.drawdown_pct = hi.close ? round(((r.price - hi.close) / hi.close) * 100, 2) : null;

      // Kept rather than discarded now: the same series answers "how far below
      // its peak has it been", "what would 10.000 kr have become" and the
      // multi-year returns, none of which two years of daily closes can reach.
      lifetime[r.symbol] = {
        dates: monthly.map((m) => m.date),
        closes: monthly.map((m) => round(m.close, 4)),
      };
      athOk++;
    } catch { /* uden all-time-data står felterne tomme */ }
  });
  console.log(`  all-time: ${athOk}/${rows.length} selskaber`);

  // 5. Market cap, per-share figures and index ranks
  let capsOk = 0, session = null;
  const quoteFields = new Map();
  try {
    session = await yahooSession();
    const got = await fetchQuoteFields(rows.map((r) => r.symbol), session);
    for (const r of rows) {
      const q = got.get(r.symbol);
      if (!q) continue;
      quoteFields.set(r.symbol, q);
      if (q.market_cap != null) {
        r.market_cap = q.market_cap;
        r.market_cap_dkk = Math.round(r.currency === 'DKK' ? q.market_cap : q.market_cap * fx.rate);
        capsOk++;
      }
    }
    assignRanks(rows);
    console.log(`  markedsværdi: ${capsOk}/${rows.length} selskaber, rangeret per indeks`);
  } catch (err) {
    console.warn('  markedsværdi kunne ikke hentes (' + err.message + ') — rækkerne får ingen placering.');
  }

  // 6. Fundamentals, benchmarks and sector medians
  // Skipped on the intraday runs: a company's revenue does not move between
  // 09:30 and 13:30, and rewriting the files would dirty the repo for nothing.
  let keyFigures = null, sectorStats = null;
  if (!QUOTES_ONLY && session) {
    const small = {}, detail = {};
    let fundOk = 0;
    await pool(rows, CONCURRENCY, async (r) => {
      try {
        const f = await fetchFundamentals(r.symbol, session);
        const q = quoteFields.get(r.symbol) || {};
        // Yahoo's two sources for earnings per share disagree now and then;
        // the statement module is the more considered of the two.
        small[r.symbol] = {
          ...f.small,
          eps_ttm: f.small.eps_ttm != null ? f.small.eps_ttm : (q.eps_ttm ?? null),
          eps_fwd: q.eps_fwd ?? null,
          div_yield: q.div_yield ?? null,
          shares: q.shares ?? null,
          rating: q.rating ?? null,
          next_earnings: f.detail.next_earnings || q.next_earnings || null,
        };
        detail[r.symbol] = f.detail;
        fundOk++;
      } catch { /* uden nøgletal viser siden ingen */ }
    });
    console.log(`  nøgletal: ${fundOk}/${rows.length} selskaber`);

    // A company's P/E means little alone. The comparison is the median of the
    // other companies on this very list in the same sector — computed here, not
    // taken from a source we cannot check.
    const perSector = {};
    for (const r of rows) {
      const s = small[r.symbol];
      if (!s || !s.eps_ttm || s.eps_ttm <= 0 || !r.price) continue;
      (perSector[r.sector] = perSector[r.sector] || []).push(r.price / s.eps_ttm);
    }
    const median = (xs) => {
      const a = xs.slice().sort((x, y) => x - y);
      if (!a.length) return null;
      const m = a.length >> 1;
      return round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2, 2);
    };
    sectorStats = {};
    for (const [sector, list] of Object.entries(perSector)) {
      sectorStats[sector] = { pe_median: median(list), companies: list.length };
    }

    keyFigures = { source: 'Yahoo Finance', sectors: sectorStats, stocks: small };
    await writeIfChanged(OUT_KEY, keyFigures, 'nogletal.json');

    await mkdir(OUT_FUND_DIR, { recursive: true });
    let fWritten = 0;
    for (const [symbol, d] of Object.entries(detail)) {
      if (await writeIfChanged(resolve(OUT_FUND_DIR, symbol + '.json'),
        { source: 'Yahoo Finance', symbol, ...d }, null)) fWritten++;
    }
    if (!LIMIT) {
      const keep = new Set(Object.keys(detail).map((s) => s + '.json'));
      for (const f of await readdir(OUT_FUND_DIR)) {
        if (f.endsWith('.json') && !keep.has(f)) await unlink(resolve(OUT_FUND_DIR, f));
      }
    }
    console.log(`  regnskabsdetaljer: ${fWritten} skrevet af ${Object.keys(detail).length}`);

    const bench = await fetchBenchmarks();
    if (Object.keys(bench).length) {
      await writeIfChanged(OUT_BENCH, { source: 'Yahoo Finance', range: '2y', indices: bench }, 'indeks.json');
    }
  }

  // 7. Files
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  await writeIfChanged(OUT_LIST, {
    source: 'Yahoo Finance',
    markets: [
      { code: 'DK', label: 'Danmark', exchange: 'Nasdaq København', currency: 'DKK' },
      { code: 'US', label: 'USA',     exchange: 'NasdaqGS / NYSE',  currency: 'USD' },
    ],
    indices: [
      { code: 'SP500',    label: 'S&P 500' },
      { code: 'NDX',      label: 'Nasdaq-100' },
      { code: 'DK-LARGE', label: 'København' },
    ],
    sectors: [...new Set(rows.map((r) => r.sector))].sort(),
    ranked: capsOk,
    fx: { pair: 'USD/DKK', ...fx },
    failed,
    stocks: rows,
  }, 'aktier.json');

  if (NO_HISTORY) { console.log('  historik: sprunget over (--no-history)'); return; }

  // One file per symbol: a detail page then downloads only the company it
  // shows, and a day that moves ten stocks rewrites ten small files.
  await mkdir(OUT_HIST_DIR, { recursive: true });
  let written = 0;
  for (const [symbol, h] of Object.entries(history)) {
    if (await writeIfChanged(resolve(OUT_HIST_DIR, symbol + '.json'),
      { source: 'Yahoo Finance', range: '2y', symbol, ...h,
        monthly: lifetime[symbol] || null }, null)) written++;
  }

  // Drop files for companies that have left the universe, so the directory does
  // not accumulate delisted symbols forever. Only when the run was complete —
  // a --limit run holds just a slice and must not delete the rest.
  let removed = 0;
  if (!LIMIT) {
    const keep = new Set(Object.keys(history).map((s) => s + '.json'));
    for (const f of await readdir(OUT_HIST_DIR)) {
      if (f.endsWith('.json') && !keep.has(f)) { await unlink(resolve(OUT_HIST_DIR, f)); removed++; }
    }
  }
  console.log(`  historik: ${written} skrevet, ${removed} fjernet, ${Object.keys(history).length} i alt`);
}

main().catch((err) => { console.error(err); process.exit(1); });

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
  'Healthcare': 'Health Care',
  'Financial Services': 'Financials',
  'Consumer Cyclical': 'Consumer Discretionary',
  'Consumer Defensive': 'Consumer Staples',
  'Industrial Goods': 'Industrials',
  'Telecommunications': 'Communication Services',
  'Consumer Cyclicals': 'Consumer Discretionary',
  'Consumer Non-Cyclicals': 'Consumer Staples',
  'Basic Materials': 'Materials',
  'Health care': 'Health Care',
};
const normSector = (s) => SECTOR_ALIASES[s] || s || 'Ukendt';

// Index tables quote share classes with a dot; Yahoo uses a dash (BRK.B → BRK-B).
const normTicker = (t) => String(t).trim().toUpperCase().replace(/\./g, '-');

// Every exchange whose primary listings we take. Yahoo's screener will also
// serve Frankfurt, Paris, London and Milan, but those are dominated by
// secondary listings of American companies (NVIDIA trades in Frankfurt as
// NVD.DE) and, in Paris and Milan, by bonds classified as equity. Taking them
// would fill the list with duplicates of rows it already has.
const EXCHANGES = [
  { code: 'NMS', market: 'US', label: 'USA' },
  { code: 'NYQ', market: 'US', label: 'USA' },
  { code: 'ASE', market: 'US', label: 'USA' },
  { code: 'CPH', market: 'DK', label: 'Danmark' },
  { code: 'STO', market: 'SE', label: 'Sverige' },
  { code: 'OSL', market: 'NO', label: 'Norge' },
  { code: 'HEL', market: 'FI', label: 'Finland' },
  { code: 'ICE', market: 'IS', label: 'Island' },
];

// A floor rather than a ceiling on how many companies to take. Below about
// fifty million dollars the exchanges are mostly shells and fund classes that
// Yahoo carries no figures for; requiring a market value is what separates a
// company from an instrument.
const MIN_MARKET_CAP_USD = 50e6;

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

// Yahoo's screener will page through a whole exchange, sorted by market
// value. It is the same undocumented crumb flow used elsewhere, so a failure
// here is not fatal: the universe falls back to the index lists alone.
const SCREEN_PAGE = 250;

async function screenExchange(exchange, session) {
  const out = [];
  for (let offset = 0; offset < 6000; offset += SCREEN_PAGE) {
    const body = {
      size: SCREEN_PAGE, offset, sortField: 'intradaymarketcap', sortType: 'DESC',
      quoteType: 'EQUITY', topOperator: 'AND',
      query: { operator: 'AND', operands: [
        { operator: 'or', operands: [{ operator: 'EQ', operands: ['exchange', exchange] }] },
      ] },
      userId: '', userIdType: 'guid',
    };
    const res = await fetch('https://query1.finance.yahoo.com/v1/finance/screener?crumb='
      + encodeURIComponent(session.crumb) + '&lang=en-US&region=US&formatted=false',
      { method: 'POST', headers: { ...session.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
    if (!res.ok) throw new Error('screener HTTP ' + res.status);
    const r = (await res.json()).finance?.result?.[0];
    const quotes = r?.quotes || [];
    out.push(...quotes);
    if (quotes.length < SCREEN_PAGE || out.length >= (r.total || 0)) break;
    await sleep(220);
  }
  return out;
}

async function buildUniverse(session, rates) {
  const byTicker = new Map();

  const add = (ticker, name, sector, index) => {
    const t = normTicker(ticker);
    if (!t || !/^[A-Z0-9-]{1,12}$/.test(t)) return;
    const existing = byTicker.get(t);
    if (existing) { if (!existing.indices.includes(index)) existing.indices.push(index); return; }
    byTicker.set(t, { symbol: t, name, sector: normSector(sector), market: 'US', indices: [index] });
  };

  // All four index tables share the layout the parser expects: ticker, name,
  // GICS sector. Together they are the S&P Composite 1500 plus the Nasdaq-100.
  const WIKI = [
    ['List_of_S%26P_500_companies',   'SP500',  'S&P 500'],
    ['List_of_NASDAQ-100_companies',  'NDX',    'Nasdaq-100'],
    ['List_of_S%26P_400_companies',   'SP400',  'S&P 400'],
    ['List_of_S%26P_600_companies',   'SP600',  'S&P 600'],
  ];
  const lists = await Promise.all(WIKI.map(([page, , label]) =>
    fetchWiki(page).catch((e) => { console.warn('  ' + label + ' fejlede:', e.message); return null; })));
  lists.forEach((rows, i) => {
    if (rows) for (const r of rows) add(r[0], r[1], r[2], WIKI[i][1]);
  });

  // A partial scrape would silently shrink the site, so treat it as a failure
  // and let the caller fall back to the committed universe.
  if (byTicker.size < 400) throw new Error('for få amerikanske selskaber (' + byTicker.size + ')');
  const fromIndices = byTicker.size;

  // Then every other company the exchanges list. The index tables carry GICS
  // sectors and are trusted for the companies they cover; the screener fills in
  // the rest, and its sector comes later from the company profile.
  let screened = 0;
  if (session) {
    for (const ex of EXCHANGES) {
      try {
        const quotes = await screenExchange(ex.code, session);
        for (const q of quotes) {
          const cap = q.marketCap;
          if (!(cap > 0)) continue;                     // no value: a shell or a fund class
          const rate = rates[q.currency] || null;
          if (!rate) continue;                          // a currency we cannot convert
          if ((cap * rate) / rates.USD < MIN_MARKET_CAP_USD) continue;

          const t = String(q.symbol || '').trim().toUpperCase();
          if (!t) continue;
          const existing = byTicker.get(t);
          if (existing) { existing.exchange = ex.code; continue; }
          byTicker.set(t, {
            symbol: t,
            name: q.longName || q.shortName || t,
            sector: null,                               // filled from the profile
            market: ex.market,
            exchange: ex.code,
            indices: [],
          });
          screened++;
        }
      } catch (err) {
        console.warn('  børs ' + ex.code + ' fejlede (' + err.message + ')');
      }
    }
  }

  // The hand-kept Danish names stay as the floor: if Copenhagen were ever
  // unreachable, the site should still know Novo Nordisk.
  for (const [symbol, name, sector] of DANISH) {
    const existing = byTicker.get(symbol);
    if (existing) { existing.sector = existing.sector || normSector(sector); continue; }
    byTicker.set(symbol, { symbol, name, sector: normSector(sector), market: 'DK', indices: ['DK-LARGE'] });
  }
  console.log('  ' + fromIndices + ' fra indekslister, ' + screened + ' flere fra børserne');

  const companies = [...byTicker.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const markets = {};
  for (const c of companies) markets[c.market] = (markets[c.market] || 0) + 1;

  return {
    source: 'Wikipedia (S&P 500, Nasdaq-100, S&P 400, S&P 600) og Yahoos børsoversigt for de øvrige',
    counts: {
      total: companies.length,
      markets,
      sp500: companies.filter((c) => c.indices.includes('SP500')).length,
      ndx:   companies.filter((c) => c.indices.includes('NDX')).length,
      dk:    companies.filter((c) => c.market === 'DK').length,
    },
    companies,
  };
}

// ── FX ───────────────────────────────────────────────────────────────────
// ECB reference rates via Frankfurter: keyless, quoted against EUR, so USD→DKK
// is derived by dividing the two legs.
async function fetchRates() {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=DKK',
    { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('FX HTTP ' + res.status);
  const { date, rates } = await res.json();
  if (!rates?.USD) throw new Error('FX mangler USD');

  // Stored the way the pages use them: kroner per unit of the listing
  // currency. GBp is pence, a hundredth of a pound, and is the quote unit on
  // the London exchange rather than a currency of its own.
  const perDkk = Object.assign({}, rates, { DKK: 1 });
  const toDkk = { DKK: 1 };
  for (const [code, v] of Object.entries(perDkk)) {
    if (v > 0) toDkk[code] = Number((1 / v).toFixed(6));
  }
  if (toDkk.GBP) toDkk.GBp = Number((toDkk.GBP / 100).toFixed(6));
  return { rates: toDkk, usd: toDkk.USD, date, source: 'ECB via Frankfurter' };
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
        open: q.regularMarketOpen ?? null,
        eps_ttm: q.epsTrailingTwelveMonths ?? null,
        eps_fwd: q.epsForward ?? null,
        book_value: q.bookValue ?? null,
        div_yield: q.dividendYield ?? null,             // allerede i procent
        shares: q.sharesOutstanding ?? null,
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
const FUND_MODULES = ['defaultKeyStatistics', 'financialData', 'calendarEvents', 'earningsHistory',
  'majorHoldersBreakdown', 'insiderTransactions', 'summaryDetail', 'assetProfile'].join(',');

// Yahoo's transaction text is prose. Only these two forms are someone deciding
// to trade with their own money; grants, gifts and option exercises are pay, and
// lumping them together would make routine compensation look like conviction.
function insiderKind(text) {
  const t = String(text || '').toLowerCase();
  if (t.startsWith('purchase at price')) return 'buy';
  if (t.startsWith('sale at price')) return 'sell';
  return 'other';
}

// Yahoo throttles a long burst of these: at 542 companies every one answered,
// at 4.500 more than a third came back empty and the same symbols were fine
// when asked again a moment later. So back off and retry rather than treat a
// throttled request as a company without figures.
async function fetchFundamentals(symbol, session) {
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
    + '?modules=' + FUND_MODULES + '&crumb=' + encodeURIComponent(session.crumb);

  let r = null, lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 * Math.pow(2, attempt) + Math.random() * 300);
    try {
      const res = await fetch(url, { headers: session.headers });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error('HTTP ' + res.status); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      r = (await res.json()).quoteSummary?.result?.[0];
      if (r) break;
      lastErr = new Error('tomt svar');
    } catch (err) { lastErr = err; }
  }
  if (!r) throw lastErr || new Error('tomt svar');

  const ks = r.defaultKeyStatistics || {}, fd = r.financialData || {};
  const profile = r.assetProfile || {};
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
      ebitda: raw(fd.ebitda),
      profit_margin: raw(fd.profitMargins),
      gross_margin: raw(fd.grossMargins),
      inst_pct: raw(mh.institutionsPercentHeld),
      ins_pct: raw(mh.insidersPercentHeld),
      peg: raw(ks.pegRatio),
    },
    sector: profile.sector || null,
    country: profile.country || null,
    // Only the company page reads this.
    detail: {
      // What the app's "Om" and "Information" cards show. assetProfile is
      // already being requested for the sector, so these cost nothing extra.
      summary: profile.longBusinessSummary || null,
      industry: profile.industry || null,
      website: profile.website || null,
      employees: raw({ raw: profile.fullTimeEmployees }),
      ceo: (profile.companyOfficers || [])
        .filter((o) => /chief executive|ceo\b/i.test(o.title || ''))
        .map((o) => o.name)[0] || null,
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
  // Yahoo carries the Stockholm 30 under ^OMX. ^OMXS30 resolves to the same
  // index but returns a single bar, which silently emptied every Swedish
  // comparison on the site.
  { code: 'OMXS30', symbol: '^OMX',     label: 'OMX Stockholm 30' },
  { code: 'OMXH25', symbol: '^OMXH25',  label: 'OMX Helsinki 25' },
  { code: 'OSEAX',  symbol: '^OSEAX',   label: 'Oslo Børs All-Share' },
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
      // Two years of daily bars is around 500 points. A handful means the
      // symbol resolved but carries no history, which is worse than a clean
      // failure: the pages would draw a comparison line from one point.
      if (dates.length < 100) throw new Error('kun ' + dates.length + ' punkter');
      out[b.code] = { label: b.label, symbol: b.symbol, dates, closes: vals };
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
  // One ranking per market. Members of a market share a currency, so these
  // need no conversion.
  for (const m of [...new Set(rows.map((r) => r.market))]) {
    rankWithin(rows.filter((r) => r.market === m), 'rank_market', 'market_cap');
  }
  // Kept under its old name so the Danish pages do not have to change.
  for (const r of rows) if (r.market === 'DK') r.rank_dk = r.rank_market;
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

function normalise(result, company, rates) {
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
  // Each listing converts at its own currency's rate; a Swedish krona and a
  // dollar are not interchangeable just because neither is a Danish krone.
  const fx = rates[currency] || null;
  const toDkk = (n) => (n == null || fx == null ? null : currency === 'DKK' ? n : round(n * fx));

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
async function writeIfChanged(path, body, label, compact) {
  try {
    const { updated_at, ...previous } = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(previous) === JSON.stringify(body)) {
      if (label) console.log('  ' + label + ': uændret');
      return false;
    }
  } catch { /* ingen brugbar tidligere fil; skriv en ny */ }

  await mkdir(dirname(path), { recursive: true });
  const full = { updated_at: new Date().toISOString(), ...body };
  await writeFile(path, compact ? JSON.stringify(full) + '\n'
    : JSON.stringify(full, null, 2) + '\n', 'utf8');
  if (label) console.log('  ' + label + ': skrevet');
  return true;
}

async function main() {
  // 0. One Yahoo session for the screener, the quotes and the profiles
  let session0 = null;
  try { session0 = await yahooSession(); }
  catch (err) { console.warn('Yahoo-session fejlede (' + err.message + ') — kun indekslisterne.'); }

  // 1. FX first: the market-value floor the universe applies is in dollars, so
  // the rates have to exist before a Swedish company can be measured against it.
  const fx = await fetchRates();
  console.log(`USD→DKK ${fx.usd} (ECB ${fx.date}), ${Object.keys(fx.rates).length} valutaer`);

  // 2. Universe
  let universe;
  if (QUOTES_ONLY) {
    universe = JSON.parse(await readFile(OUT_UNIVERSE, 'utf8'));
    console.log(`Univers genbrugt: ${universe.companies.length} selskaber`);
  } else {
    try {
      universe = await buildUniverse(session0, fx.rates);
      const perMarket = universe.counts.markets || {};
      console.log(`Univers: ${universe.counts.total} selskaber (`
        + Object.entries(perMarket).map(([m, n]) => m + ': ' + n).join(', ') + ')');
      await writeIfChanged(OUT_UNIVERSE, universe, 'univers.json');
    } catch (err) {
      console.warn('Kunne ikke opdatere universet (' + err.message + ') — bruger den committede liste.');
      universe = JSON.parse(await readFile(OUT_UNIVERSE, 'utf8'));
    }
  }

  // 3. Quotes
  const companies = LIMIT ? universe.companies.slice(0, LIMIT) : universe.companies;
  const t0 = Date.now();
  let done = 0;
  const results = await pool(companies, CONCURRENCY, async (c) => {
    try {
      const out = normalise(await fetchTicker(c.symbol), c, fx.rates);
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
    session = session0 || await yahooSession();
    const got = await fetchQuoteFields(rows.map((r) => r.symbol), session);
    for (const r of rows) {
      const q = got.get(r.symbol);
      if (!q) continue;
      quoteFields.set(r.symbol, q);
      // Dagens åbningskurs står ikke i chart-metadataen, kun i quoten.
      if (q.open != null) r.open = round(q.open);
      if (q.market_cap != null) {
        r.market_cap = q.market_cap;
        r.market_cap_dkk = Math.round(q.market_cap * (fx.rates[r.currency] || 0)) || null;
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
          next_earnings: f.detail.next_earnings || q.next_earnings || null,
        };
        detail[r.symbol] = f.detail;
        // The index tables give GICS sectors and are trusted where they reach.
        // Everyone else takes the sector off their own profile, folded into the
        // same vocabulary so one filter still covers the whole list.
        if (!r.sector && f.sector) r.sector = normSector(f.sector);
        fundOk++;
      } catch { /* uden nøgletal viser siden ingen */ }
    });
    for (const r of rows) if (!r.sector) r.sector = 'Ukendt';
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
      { code: 'DK', label: 'Danmark', exchange: 'Nasdaq København',  currency: 'DKK', flag: '🇩🇰' },
      { code: 'SE', label: 'Sverige', exchange: 'Nasdaq Stockholm',  currency: 'SEK', flag: '🇸🇪' },
      { code: 'NO', label: 'Norge',   exchange: 'Oslo Børs',         currency: 'NOK', flag: '🇳🇴' },
      { code: 'FI', label: 'Finland', exchange: 'Nasdaq Helsinki',   currency: 'EUR', flag: '🇫🇮' },
      { code: 'IS', label: 'Island',  exchange: 'Nasdaq Iceland',    currency: 'ISK', flag: '🇮🇸' },
      { code: 'US', label: 'USA',     exchange: 'Nasdaq / NYSE / NYSE American', currency: 'USD', flag: '🇺🇸' },
    ].filter((m) => rows.some((r) => r.market === m.code)),
    indices: [
      { code: 'SP500',    label: 'S&P 500' },
      { code: 'NDX',      label: 'Nasdaq-100' },
      { code: 'SP400',    label: 'S&P 400' },
      { code: 'SP600',    label: 'S&P 600' },
      { code: 'DK-LARGE', label: 'København' },
    ],
    sectors: [...new Set(rows.map((r) => r.sector))].sort(),
    ranked: capsOk,
    fx: { pair: 'USD/DKK', rate: fx.usd, date: fx.date, source: fx.source, rates: fx.rates },
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
        monthly: lifetime[symbol] || null }, null, true)) written++;
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

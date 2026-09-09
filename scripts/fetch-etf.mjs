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

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_LIST = resolve(ROOT, 'data/etf.json');
const OUT_HIST = resolve(ROOT, 'data/etf-historik');
const OUT_DETAIL = resolve(ROOT, 'data/etf-detaljer');

const argv = process.argv.slice(2);
const QUOTES_ONLY = argv.includes('--quotes-only');
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
// De tre år med daglige lukkekurser hentes under alle omstændigheder — både
// sparklinjen og hvert periodeafkast udledes af dem. De skrives til disk med
// --history, som fondssiden læser. Kun den fulde aftenkørsel gør det, og kun
// filer med nyt indhold røres, så en dag uden handel ikke koster en ny blob.
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

// Investeringsforeninger — de danske foreninger, der ikke er ETF'er.
//
// Screeneren kan ikke nå dem. Yahoo typer en dansk investeringsforening som
// EQUITY og ikke som ETF, så den står uden for hver eneste søgning ovenfor,
// uanset hvor mange papirer København får lov at levere. Kurs, dagens handel
// og hele historikken svarer Yahoo derimod gerne på, og det er dem siden viser.
//
// Til gengæld findes der ingen fundProfile: kaldet svarer 404, og det navn
// kilden opgiver, er foreningens frem for afdelingens — alle tre Coop
// Bank-afdelinger hedder det samme dér, og for den ene af dem opgiver den slet
// intet kort navn. Derfor står navn og udbyder her, som de står i fondenes egne
// faktaark, og resten hentes som for alle andre fonde.
//
// Formuen oplyser kilden heller ikke. Den bliver stående som null, og fonden
// lander derfor sidst på rangeringen efter formue. Det er en oplysning der
// mangler, ikke en påstand om, at fonden er lille.
const EXTRA = [
  { symbol: 'WEICBS.CO', name: 'Wealth Invest Coop Bank Stabil'  },
  { symbol: 'WEICBB.CO', name: 'Wealth Invest Coop Bank Balance' },
  { symbol: 'WEICBV.CO', name: 'Wealth Invest Coop Bank Vækst'   },
].map((e) => ({
  family: 'Wealth Invest',
  exchange: 'Nasdaq København',
  market: 'DK',
  currency: 'DKK',
  kind: 'investeringsforening',
  ...e,
}));

// Lægges oven på universet i begge kørselstyper, så en ny linje i EXTRA er med
// allerede ved næste kurskørsel — der henter universet fra filen og altså ikke
// selv ville kende den. Listen her er kilden til navn og udbyder, så den vinder
// over det der måtte stå i filen i forvejen.
function withExtras(universe) {
  const extra = new Map(EXTRA.map((e) => [e.symbol, e]));
  return universe.filter((e) => !extra.has(e.symbol)).concat([...extra.values()]);
}

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
    if (a) {
      // 429 er ikke en fejl i kaldet — det er Yahoo der beder os vente. Et
      // sekund er ikke nok; da den lange serie kom til og fordoblede antallet
      // af kald, faldt 255 fonde ud på præcis det.
      const rate = /HTTP 429/.test(String(last && last.message));
      await sleep(rate ? 4000 * a + Math.random() * 2000
                       : 400 * Math.pow(2, a) + Math.random() * 300);
    }
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
// Vinduerne måles på datoer, ikke på antal kurser i serien. For en ETF der
// handles hver dag er det samme sag — 252 kurser er et børsår. Men en dansk
// investeringsforening printer kun en kurs, når nogen handler den: Coop Bank
// Stabil har 269 kurser på to et halvt år, og "de seneste 252" rakte derfor
// helt tilbage til februar 2024 og stod på siden som "1 år".
const WINDOWS = {
  change_7d: (iso) => shiftDays(iso, 7),
  change30d: (iso) => shiftDays(iso, 30),
  change_6m: (iso) => shiftMonths(iso, 6),
  change_1y: (iso) => shiftMonths(iso, 12),
  change_3y: (iso) => shiftMonths(iso, 36),
};

const shiftDays = (iso, days) =>
  new Date(new Date(iso + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10);

const shiftMonths = (iso, months) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

// Kursen som den stod på skæringsdagen: den sidste kurs på eller før den. Null
// hvis serien ikke rækker så langt tilbage — så er der ikke noget at måle over,
// og en streg er svaret.
function moveSince(dates, closes, cut) {
  if (!dates.length || dates[0] > cut) return null;
  let i = dates.length - 1;
  while (i > 0 && dates[i] > cut) i--;
  const base = closes[i], last = closes[closes.length - 1];
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

// Den daglige serie rækker tre år tilbage. Fondssiden skal kunne vise mere end
// det, og range=max giver alligevel kun omkring 300 bjælker uanset hvilket
// interval man beder om — så den lange serie hentes månedligt, som aktierne
// gør det. Bjælken er stemplet med periodens FØRSTE dag, men bærer dens SIDSTE
// kurs, så hver bjælke dateres dagen før den næste åbner.
// Månedsserien får ét nyt punkt om måneden. At hente den for 1.728 fonde hver
// aften er spildte kald — og det var dem der udløste rate-grænsen. Ligger der
// allerede en med et punkt fra indeværende måned, genbruges den.
async function cachedLifetime(symbol, session) {
  const path = resolve(OUT_HIST, symbol + '.json');
  const thisMonth = new Date().toISOString().slice(0, 7);
  try {
    const old = JSON.parse(await readFile(path, 'utf8'));
    const m = old.monthly;
    // Genbrug kræver to ting: at månedsserien allerede rækker ind i denne
    // måned, og at filen er skrevet af en kørsel der kendte til hændelser.
    // Uden det andet krav ville filerne fra før udbytterne kom til blive
    // genbrugt i det uendelige og aldrig få dem — hvad de gjorde i én kørsel,
    // hvor VUSA.DE stod med nul udbytter og har femogtredive.
    if (m && m.dates && m.dates.length > 1 && m.dates[m.dates.length - 1].slice(0, 7) === thisMonth
        && old.events) {
      return { monthly: m, events: old.events, reused: true };
    }
  } catch { /* ingen fil endnu */ }
  try {
    const lt = await fetchLifetime(symbol, session);
    return { monthly: lt ? lt.monthly : null, events: lt ? lt.events : null, reused: false };
  } catch { return { monthly: null, events: null, reused: false }; }
}

async function fetchLifetime(symbol, session) {
  return retrying(async () => {
    // events=div,split koster ingen ekstra forespørgsel — de ligger i det
    // samme svar. Og for en fond er de mere end pynt: en fond uden en eneste
    // udbetaling gennem ti år er akkumulerende, og det afgør beskatningen.
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
      + '?interval=1mo&range=max&events=div%2Csplit';
    const res = await fetch(url, { headers: session.headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = (await res.json()).chart?.result?.[0];
    const stamps = r?.timestamp || [], closes = r?.indicators?.quote?.[0]?.close || [];
    const tz = r?.meta?.gmtoffset || 0;
    const day = (secs) => new Date((secs + tz) * 1000).toISOString().slice(0, 10);
    const dayBefore = (iso) => new Date(new Date(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

    const dates = [], vals = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || stamps[i] == null) continue;
      const isLast = i === closes.length - 1;
      dates.push(isLast ? day(stamps[i]) : dayBefore(day(stamps[i + 1] ?? stamps[i])));
      vals.push(round(closes[i], 4));
    }
    if (dates.length < 2) return null;

    // Udbyttedatoen er den dag fonden handles uden udbytte. Den stemples i
    // børsens åbningstid, så UTC-datoen er den rigtige dag.
    const ev = r?.events || {};
    const dividends = Object.values(ev.dividends || {})
      .filter((d) => d && d.date != null && d.amount != null)
      .map((d) => ({ date: isoDay(d.date), amount: round(d.amount, 6) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const splits = Object.values(ev.splits || {})
      .filter((x) => x && x.date != null)
      .map((x) => ({ date: isoDay(x.date),
                     ratio: x.splitRatio || ((x.numerator ?? '?') + ':' + (x.denominator ?? '?')) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // Altid med, også tom: en fond uden udbetalinger er ikke en fond vi
    // mangler at spørge om, og det er nøjagtig den forskel genbruget læser.
    return { monthly: { dates, closes: vals }, events: { dividends, splits } };
  }, 3, session);
}

function derive(hist, monthly) {
  const c = hist.closes, d = hist.dates;
  const last = d[d.length - 1];
  const out = { spark: c.slice(-SPARK_POINTS) };
  for (const [key, cutOf] of Object.entries(WINDOWS)) out[key] = moveSince(d, c, cutOf(last));

  // Højeste og laveste lukkekurs inden for det seneste år, afgrænset på
  // datoerne. Kilden har sit eget 52-ugers interval, men det er dagens
  // yderpunkter og bærer derfor fejlprints med sig — én af de nye fonde stod
  // med en top på 3.000 mod en kurs på 16.
  const year = c.filter((_, i) => d[i] >= shiftMonths(last, 12));
  out.high_52w = year.length ? round(Math.max(...year), 4) : null;
  out.low_52w = year.length ? round(Math.min(...year), 4) : null;
  out.first_date = monthly && monthly.dates.length ? monthly.dates[0] : hist.dates[0];

  // Den daglige serie er tre år lang, og tre år er 756 handelsdage — så
  // change_3y faldt ud for to tredjedele af fondene, fordi den bad om ét
  // punkt mere end filen havde. Når den lange serie er der, måles de lange
  // vinduer på den i stedet.
  //
  // Den lange serie dateres på samme måde, og af samme grund: Yahoo vælger selv
  // opløsningen på range=max og giver en fond noteret for halvandet år siden
  // ugebjælker. Talt i bjælker blev 36 af dem til “3 år” for en fond, der ikke
  // har levet halvdelen af det.
  if (monthly && monthly.closes.length > 12) {
    const md = monthly.dates, mc = monthly.closes, mlast = md[md.length - 1];
    if (out.change_3y == null) out.change_3y = moveSince(md, mc, shiftMonths(mlast, 36));
    if (out.change_1y == null) out.change_1y = moveSince(md, mc, shiftMonths(mlast, 12));
  }
  return out;
}

// ── Profil og indhold ────────────────────────────────────────────────────
// The provider is always there. The category and the ongoing charge are filled
// in for the American funds and almost never for the European ones, so they are
// carried as null rather than as a zero the page would print as "0,00 %".
//
// De fire moduler hentes i ét kald. Det er samme forespørgsel som før — kun
// modullisten er længere — så beholdningerne koster ikke en eneste ekstra
// rundtur. Det er hele grunden til at de ligger her og ikke i en egen funktion:
// en fond mere at slå op var det, der udløste Yahoos rate-grænse sidst.
const DETAIL_MODULES = 'fundProfile,topHoldings,fundPerformance,defaultKeyStatistics';

// Yahoo udleverer de fire prisforhold som deres omvendte: 0,04035 for et P/E
// på 24,8. Deres eget "fmt" skriver 0,04, som er indtjeningsafkastet og ikke
// det tallet hedder. Kontrolleret på tværs af fondstyper — QQQ 29,2, S&P 500
// 24,8, value 20,7, small cap 17,3 — så det er ikke tilfældigt for én fond.
const invert = (v) => (v && Number.isFinite(v) && v > 0 ? round(1 / v, 2) : null);
const asPct = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : round(v * 100, d));

// Sektorvægtene kommer som en liste af objekter med én nøgle hver:
// [{ realestate: 0.018 }, { technology: 0.3869 }, …].
function flattenSectors(list) {
  const out = [];
  for (const entry of (list || [])) {
    for (const [k, v] of Object.entries(entry || {})) {
      const w = asPct(v);
      if (w != null && w > 0) out.push({ k, w });
    }
  }
  return out.sort((a, b) => b.w - a.w);
}

async function fetchDetail(symbol, session) {
  return retrying(async () => {
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol)
      + '?modules=' + DETAIL_MODULES + '&formatted=false&crumb=' + encodeURIComponent(session.crumb);
    const res = await fetch(url, { headers: session.headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const q = (await res.json()).quoteSummary?.result?.[0];
    if (!q) throw new Error('tomt quoteSummary');

    const fp = q.fundProfile, th = q.topHoldings, perf = q.fundPerformance, ks = q.defaultKeyStatistics;
    const fee = fp?.feesExpensesInvestment?.annualReportExpenseRatio;

    // Det der hører til i listen: tre felter, som før.
    const list = {
      family: fp?.family || null,
      category: fp?.categoryName || null,
      expense_ratio: fee ? round(fee * 100, 3) : null,   // 0 betyder "ikke oplyst"
    };

    const holdings = (th?.holdings || [])
      .filter((h) => h && h.holdingName)
      .map((h) => ({ s: h.symbol || null, n: cleanName(h.holdingName), w: asPct(h.holdingPercent) }))
      .filter((h) => h.w != null && h.w > 0);

    const sectors = flattenSectors(th?.sectorWeightings);

    const alloc = {};
    for (const [key, raw] of [['aktier', th?.stockPosition], ['obligationer', th?.bondPosition],
                              ['kontant', th?.cashPosition], ['andet', th?.otherPosition],
                              ['praeference', th?.preferredPosition], ['konvertible', th?.convertiblePosition]]) {
      const w = asPct(raw);
      if (w != null && w > 0.005) alloc[key] = w;
    }

    const eq = th?.equityHoldings || {};
    const equity = {
      pe: invert(eq.priceToEarnings), pb: invert(eq.priceToBook),
      ps: invert(eq.priceToSales), pcf: invert(eq.priceToCashflow),
    };

    const bh = th?.bondHoldings || {};
    const bond = {
      duration: bh.duration ?? null,
      maturity: bh.maturity ?? null,
      credit_quality: bh.creditQuality ?? null,
    };
    const bond_ratings = flattenSectors(th?.bondRatings);

    // Kalenderårsafkast. Det er totalafkast — udbytterne er med — og derfor
    // det eneste sted på siden hvor en udbyttebetalende fond måles retfærdigt.
    const annual = (perf?.annualTotalReturns?.returns || [])
      .filter((x) => x && x.year && x.annualValue != null)
      .map((x) => ({ y: String(x.year), v: asPct(x.annualValue) }))
      .filter((x) => x.v != null)
      .sort((a, b) => (a.y < b.y ? -1 : 1));

    const risk = (perf?.riskOverviewStatistics?.riskStatistics || [])
      .filter((x) => x && x.year && x.stdDev != null)
      .map((x) => ({ y: String(x.year), alpha: x.alpha ?? null, beta: x.beta ?? null,
                     stddev: x.stdDev ?? null, sharpe: x.sharpeRatio ?? null }));

    const detail = {
      holdings, sectors,
      allocation: Object.keys(alloc).length ? alloc : null,
      equity: Object.values(equity).some((v) => v != null) ? equity : null,
      bond: Object.values(bond).some((v) => v != null) ? bond : null,
      bond_ratings,
      annual, risk,
      yield: asPct(ks?.yield),
      // Nul betyder "ikke oplyst", præcis som ved gebyret. En indeksfond
      // udskifter ikke bogstaveligt talt intet på et år.
      turnover: fp?.feesExpensesInvestment?.annualHoldingsTurnover
        ? asPct(fp.feesExpensesInvestment.annualHoldingsTurnover) : null,
      inception: ks?.fundInceptionDate ? isoDay(ks.fundInceptionDate) : null,
      legal_type: fp?.legalType || ks?.legalType || null,
    };

    // En fond hvor intet af det her findes, skal ikke have en fil. 404'eren er
    // billigere end en tom fil, og rækken siger selv at der ikke er nogen.
    const has = holdings.length || sectors.length || annual.length
      || detail.allocation || detail.equity || bond_ratings.length;

    return { list, detail: has ? detail : null };
  }, 3, session);
}

// ── Output ───────────────────────────────────────────────────────────────
async function writeJson(path, value, compact) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, compact ? JSON.stringify(value) + '\n' : JSON.stringify(value, null, 2) + '\n');
}

// Rører kun filen hvis indholdet faktisk er et andet. En fond der ikke blev
// handlet, giver samme tre år igen, og en identisk fil skrevet forfra ville
// stadig blive en ny blob i git.
async function writeIfChanged(path, value) {
  const next = JSON.stringify(value) + '\n';
  try { if (await readFile(path, 'utf8') === next) return false; } catch { /* findes ikke endnu */ }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return true;
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
                     category: e.category, expense_ratio: e.expense_ratio,
                     kind: e.kind, has_detail: e.has_detail }));
    console.log(`Univers genbrugt: ${universe.length} ETF'er`);
  } else {
    console.log('Screener:');
    universe = await buildUniverse(session, fx.usdPer);
    console.log(`Univers: ${universe.length} ETF'er`);
  }
  if (LIMIT) universe = universe.slice(0, LIMIT);
  // Efter --limit, ikke før: en prøvekørsel på tyve fonde skal kunne se dem.
  const before = universe.length;
  universe = withExtras(universe);
  if (universe.length > before) {
    console.log(`Investeringsforeninger: ${universe.length - before} lagt til`);
  }

  console.log('Kurser…');
  const quotes = await fetchQuotes(universe.map((e) => e.symbol), session);

  // Hvad der stod i filen i forvejen. Slår historikken fejl for en enkelt fond
  // — Yahoo svarer 429, eller kaldet timer ud — er det forrige tal stadig et
  // rigtigt tal. Uden det her blankede en dårlig aften spark, 52-ugers
  // interval og alle periodeafkast for de fonde der ikke kom igennem.
  const previous = new Map();
  try {
    for (const e of (JSON.parse(await readFile(OUT_LIST, 'utf8')).etfs || [])) previous.set(e.symbol, e);
  } catch { /* første kørsel */ }
  const CARRIED = ['spark', 'high_52w', 'low_52w', 'first_date',
                   'change_7d', 'change30d', 'change_6m', 'change_1y', 'change_3y'];
  const carryOver = (symbol) => {
    const old = previous.get(symbol);
    if (!old) return {};
    const out = {};
    for (const k of CARRIED) if (old[k] != null) out[k] = old[k];
    return out;
  };

  console.log('Historik og profiler…');
  let done = 0, reused = 0;
  const failed = [];
  const detailFailed = [];
  const rows = await pool(universe, CONCURRENCY, async (e) => {
    const q = quotes.get(e.symbol);
    if (!q || q.price == null) { failed.push({ symbol: e.symbol, reason: 'ingen kurs' }); return null; }

    let hist = null, monthly = null, extra = {}, hasDetail = false;
    if (!QUOTES_ONLY) {
      try {
        hist = await fetchHistory(e.symbol, session);
        // Den lange serie bruges to steder: den skrives til fondens fil, og
        // de lange vinduer i nøgletallene måles på den. Derfor hentes den her
        // og ikke inde i skriveblokken.
        const lt = await cachedLifetime(e.symbol, session);
        monthly = lt.monthly;
        if (lt.reused) reused++;
        if (KEEP_HISTORY) {
          await writeIfChanged(resolve(OUT_HIST, e.symbol + '.json'),
            { symbol: e.symbol, updated_at: new Date().toISOString().slice(0, 10),
              dates: hist.dates, closes: hist.closes,
              ...(monthly ? { monthly } : {}),
              ...(lt.events ? { events: lt.events } : {}) });
        }
      } catch (err) { failed.push({ symbol: e.symbol, reason: 'historik: ' + err.message }); }
      // En investeringsforening har ingen fundProfile hos Yahoo. Kaldet svarer
      // 404, og tre forsøg på det er tre kald ud i ingenting; dens udbyder og
      // navn står i EXTRA i forvejen. Det gælder også de tre andre moduler:
      // beholdninger, kalenderårsafkast og risikotal ligger i samme svar.
      if (!e.kind) {
        try {
          const d = await fetchDetail(e.symbol, session);
          extra = d.list;
          if (KEEP_HISTORY) {
            if (d.detail) {
              await writeIfChanged(resolve(OUT_DETAIL, e.symbol + '.json'),
                { symbol: e.symbol, updated_at: new Date().toISOString().slice(0, 10), ...d.detail });
              hasDetail = true;
            }
          } else {
            // Uden --history skrives ingen filer. Flaget må så blive stående som
            // det var, ellers ville en kørsel uden filskrivning fortælle siden at
            // detaljerne er væk, mens de ligger på disken.
            hasDetail = previous.get(e.symbol)?.has_detail ?? false;
          }
        } catch {
          // Et afvist kald er ikke det samme som en fond uden beholdninger.
          // Første gang de to blev behandlet ens, stod 68 fonde uden indhold,
          // og 16 af de 20 første viste sig at have det hele — Yahoo havde bare
          // sagt 429 midt i bunken. Fondens gamle tal og gamle fil gælder
          // stadig, og symbolet stilles i kø til et forsøg mere bagefter.
          const old = previous.get(e.symbol);
          extra = old ? { family: old.family ?? null, category: old.category ?? null,
                          expense_ratio: old.expense_ratio ?? null } : {};
          hasDetail = old?.has_detail ?? false;
          detailFailed.push(e.symbol);
        }
      }
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
      // Kun de fonde der ikke er ETF'er bærer feltet. Skrevet på alle 1.728
      // ville "kind":"etf" koste 20 KB på en fil siden henter ved hvert besøg.
      ...(e.kind ? { kind: e.kind } : {}),
      // Fondssiden henter kun detaljefilen når der er en. Tredive fonde uden
      // beholdninger — nordiske noteringer kilden ikke fører profil på — ville
      // ellers koste en 404 og en rundtur for ingenting hver gang nogen
      // åbnede dem.
      has_detail: QUOTES_ONLY ? (e.has_detail ?? undefined) : hasDetail,
      ...(hist ? derive(hist, monthly) : carryOver(e.symbol)),
    };
  });

  // Andet forsøg for dem Yahoo afviste. Seks samtidige kald over sytten
  // hundrede fonde rammer grænsen; to ad gangen over et halvt hundrede gør
  // ikke. Det er billigere end at vente et døgn på næste kørsel.
  if (detailFailed.length && !QUOTES_ONLY && KEEP_HISTORY) {
    const bySymbol = new Map(rows.filter(Boolean).map((r) => [r.symbol, r]));
    const queue = detailFailed.filter((sym) => bySymbol.has(sym));
    console.log(`Andet forsøg på ${queue.length} detaljer…`);
    let saved = 0;
    await pool(queue, 2, async (symbol) => {
      const row = bySymbol.get(symbol);
      try {
        const d = await fetchDetail(symbol, session);
        if (d.list.family != null) row.family = d.list.family;
        if (d.list.category != null) row.category = d.list.category;
        if (d.list.expense_ratio != null) row.expense_ratio = d.list.expense_ratio;
        if (d.detail) {
          await writeIfChanged(resolve(OUT_DETAIL, symbol + '.json'),
            { symbol, updated_at: new Date().toISOString().slice(0, 10), ...d.detail });
          row.has_detail = true;
          saved++;
        }
      } catch { /* så står fonden uden, og i morgen prøves igen */ }
      await sleep(150);
    });
    console.log(`  ${saved} hentet i andet forsøg`);
  }

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

  // --limit er en prøvekørsel. Skrev den listen, ville fem fonde lægge sig
  // hen over de sytten hundrede — og guarden ovenfor springer netop over ved
  // --limit, fordi et lille tal dér er meningen. Historik- og detaljefilerne
  // skrives stadig; de hører til hver sin fond og kan ikke ramme de andre.
  if (LIMIT) {
    console.log(`Prøvekørsel (--limit=${LIMIT}) — ${etfs.length} fonde hentet, listen skrives ikke.`);
    return;
  }

  await writeJson(OUT_LIST, {
    updated_at: new Date().toISOString(),
    source: 'Yahoo Finance',
    fx: { base: 'DKK', date: fx.date, usd: fx.usd },
    count: etfs.length,
    etfs,
    failed,
  }, true);

  // En fond der er faldet ud af universet skal ikke efterlade sin historik —
  // ellers ville /fond.html?symbol=… blive ved med at svare på noget der ikke
  // står på listen længere.
  if (KEEP_HISTORY && !LIMIT) {
    const keep = new Set(etfs.map((e) => e.symbol + '.json'));
    let removed = 0;
    try {
      for (const f of await readdir(OUT_HIST)) {
        if (f.endsWith('.json') && !keep.has(f)) { await unlink(resolve(OUT_HIST, f)); removed++; }
      }
    } catch { /* mappen findes ikke endnu */ }
    if (removed) console.log(`  historik: ${removed} forældede filer fjernet`);

    // Samme oprydning for detaljerne, og en til: en fond der har mistet sine
    // beholdninger hos kilden, skal heller ikke beholde de gamle. Rækken siger
    // nu at der ingen er, og en fil der modsagde den ville blive hentet alligevel.
    const keepDetail = new Set(etfs.filter((e) => e.has_detail).map((e) => e.symbol + '.json'));
    let goneDetail = 0;
    try {
      for (const f of await readdir(OUT_DETAIL)) {
        if (f.endsWith('.json') && !keepDetail.has(f)) { await unlink(resolve(OUT_DETAIL, f)); goneDetail++; }
      }
    } catch { /* mappen findes ikke endnu */ }
    if (goneDetail) console.log(`  detaljer: ${goneDetail} forældede filer fjernet`);
  }

  const carried = failed.filter((f) => previous.has(f.symbol)).length;
  const withDetail = etfs.filter((e) => e.has_detail).length;
  console.log(`Skrev ${etfs.length} ETF'er`
    + (withDetail ? `, ${withDetail} med beholdninger` : '')
    + (reused ? `, ${reused} lange serier genbrugt` : '')
    + (failed.length ? `, ${failed.length} fejlede` : '')
    + (carried ? ` (${carried} beholdt forrige tal)` : ''));
}

main().catch((err) => { console.error(err); process.exit(1); });

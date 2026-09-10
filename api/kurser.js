// Kurser på forespørgsel.
//
// The site ships prices as a build artifact because Yahoo sends no CORS header:
// a browser cannot call it. Server-side that restriction does not exist, so this
// function makes the same request the nightly job makes — once per edge-cache
// window — and hands the browser the answer from the site's own origin. No API
// key, no database, nothing to keep in sync.
//
// GET /api/kurser?symbols=NOVO-B.CO,AAPL,...
//   → { ok, t, q: { SYMBOL: { p, c, cp, t, d, s, cur } } }
//
//   p   seneste kurs            c   ændring i valuta
//   cp  ændring i procent       t   børsens tidsstempel (sekunder)
//   d   børsens forsinkelse i minutter (0 = uforsinket)
//   s   markedstilstand (REGULAR, CLOSED, PRE, POST …)
//   cur valuta
//
// The delay is passed through rather than hidden: Oslo reports fifteen minutes
// where Copenhagen and Stockholm report none, and a page that prints a number
// should be able to say how old it is.

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// One request covers a whole screenful of rows. The cap is a guard against a
// crafted URL, not a limit anything on the site runs into.
const MAX_SYMBOLS = 150;

// Yahoo's handshake is good for hours, and a warm function keeps it between
// invocations. It is re-minted on the first rejection rather than on a timer.
let session = null;

async function mintSession() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'user-agent': YF_UA } });
  const cookie = (r1.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('ingen cookies fra Yahoo');

  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { 'user-agent': YF_UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.startsWith('<')) throw new Error('ingen crumb fra Yahoo');

  return { cookie, crumb };
}

async function quotes(symbols, retry) {
  if (!session) session = await mintSession();

  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
    + encodeURIComponent(symbols.join(',')) + '&crumb=' + encodeURIComponent(session.crumb);
  const res = await fetch(url, {
    headers: { 'user-agent': YF_UA, cookie: session.cookie, accept: 'application/json' },
  });

  // An expired crumb reads as a refusal, not as an empty answer. One re-mint,
  // then the failure is real and the caller keeps its build-time prices.
  if (res.status === 401 || res.status === 403) {
    session = null;
    if (retry) throw new Error('Yahoo afviste også efter ny session (HTTP ' + res.status + ')');
    return quotes(symbols, true);
  }
  if (!res.ok) throw new Error('Yahoo svarede HTTP ' + res.status);

  return (await res.json()).quoteResponse?.result || [];
}

// Yahoo symbols are letters, digits and a small punctuation set (BRK-B,
// NOVO-B.CO, ^GSPC). Anything else is dropped rather than forwarded.
const CLEAN = /^[A-Za-z0-9.\-^=]{1,20}$/;

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => CLEAN.test(s)))]
    .slice(0, MAX_SYMBOLS);

  if (!symbols.length) {
    res.status(400).json({ ok: false, error: 'ingen gyldige symboler' });
    return;
  }

  try {
    const rows = await quotes(symbols, false);
    const q = {};
    for (const r of rows) {
      if (!r || !r.symbol || r.regularMarketPrice == null) continue;
      // Uden for børstiden handles amerikanske papirer videre, og Yahoo lægger
      // den handel i sit eget sæt felter — preMarket… før åbning, postMarket…
      // efter lukning. Nordiske børser har ingen af delene og sender dem ikke.
      // De to sæt udelukker hinanden, så de samles til ét: hvad der handles
      // uden for åbningstiden lige nu, og hvilken af de to sessioner det er.
      const pre = r.preMarketPrice != null;
      const post = r.postMarketPrice != null;
      const x = pre ? 'preMarket' : post ? 'postMarket' : null;

      q[r.symbol] = {
        p: r.regularMarketPrice,
        c: r.regularMarketChange ?? null,
        cp: r.regularMarketChangePercent ?? null,
        t: r.regularMarketTime ?? null,
        d: r.exchangeDataDelayedBy ?? null,
        s: r.marketState || null,
        cur: r.currency || null,
        // x* er handlen uden for børstiden. xs siger hvilken session.
        xs: x ? (pre ? 'pre' : 'post') : null,
        xp: x ? r[x + 'Price'] ?? null : null,
        xc: x ? r[x + 'Change'] ?? null : null,
        xcp: x ? r[x + 'ChangePercent'] ?? null : null,
        xt: x ? r[x + 'Time'] ?? null : null,
      };
    }

    // The edge absorbs the polling: a hundred readers on the same screenful of
    // rows cost Yahoo one request every twenty seconds, not a hundred a minute.
    res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
    res.status(200).json({ ok: true, t: new Date().toISOString(), q });
  } catch (err) {
    // A failure here is not an outage: the page already has prices and simply
    // stops asking for newer ones.
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
};

// Dagens forløb, minut for minut.
//
// De daglige filer bærer én lukkekurs pr. dag, og en dagsgraf tegnet på dem er
// to punkter forbundet med en ret linje — den siger intet om, hvad der skete i
// løbet af dagen. Yahoo har minutdata, men sender ingen CORS-header, så
// browseren kan ikke selv hente dem. Serverside findes den begrænsning ikke.
//
// GET /api/intradag?symbol=NVDA&interval=1m&range=1d
//   → { ok, symbol, cur, prev, gmtoffset, tz, t: [sekunder], c: [kurser] }
//
//   prev       forrige lukkekurs — Nordnets stiplede nullinje måles fra den
//   gmtoffset  børsens forskydning fra UTC, så klokkeslæt kan vises i børstid
//   t/c        tidsstempel og kurs, parvis, med huller uden handel skåret fra
//
// Der er ingen crumb her: chart-endepunktet svarer uden. Kun kurser gør ikke.

const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Symboler som Yahoo bruger dem: bogstaver, tal, punktum, bindestreg, ^ for
// indeks. Alt andet er ikke et symbol og skal ikke videresendes.
const CLEAN = /^[A-Za-z0-9.\-^=]{1,20}$/;

// Kun de kombinationer siden faktisk tegner. En åben passthrough ville gøre
// funktionen til en gratis Yahoo-proxy for hvem som helst.
const ALLOWED = {
  '1d': '1m',
  '5d': '5m',
};

module.exports = async (req, res) => {
  const symbol = String((req.query && req.query.symbol) || '').trim();
  const range = String((req.query && req.query.range) || '1d').trim();

  if (!CLEAN.test(symbol)) {
    res.status(400).json({ ok: false, error: 'ugyldigt symbol' });
    return;
  }
  const interval = ALLOWED[range];
  if (!interval) {
    res.status(400).json({ ok: false, error: 'ugyldig periode' });
    return;
  }

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol)
      + '?interval=' + interval + '&range=' + range + '&includePrePost=false';
    const r = await fetch(url, { headers: { 'user-agent': YF_UA, accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const result = (await r.json())?.chart?.result?.[0];
    if (!result) throw new Error('tomt svar');

    const stamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const meta = result.meta || {};

    // Minutter uden handel kommer tilbage som null. De skæres fra frem for at
    // blive tegnet som nul — en aktie falder ikke til nul, fordi ingen handlede
    // i det minut.
    const t = [], c = [];
    for (let i = 0; i < stamps.length; i++) {
      if (stamps[i] == null || closes[i] == null) continue;
      t.push(stamps[i]);
      c.push(Number(closes[i].toFixed(4)));
    }
    if (t.length < 2) throw new Error('ingen handel i perioden');

    // Minutdata ændrer sig hvert minut, men hundrede læsere på samme aktie skal
    // ikke koste Yahoo hundrede kald. Kanten holder svaret et halvt minut.
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.status(200).json({
      ok: true,
      symbol: meta.symbol || symbol,
      cur: meta.currency || null,
      prev: meta.chartPreviousClose ?? meta.previousClose ?? null,
      gmtoffset: meta.gmtoffset ?? 0,
      tz: meta.exchangeTimezoneName || null,
      state: meta.marketState || null,
      t,
      c,
    });
  } catch (err) {
    // Siden har allerede en graf at falde tilbage på; den beder bare ikke om
    // minutter, der ikke kom.
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
};

// Delt kode for de to sider om investeringsbeviser: oversigten og den enkelte
// afdeling. Begge sider skal hente det samme, regne perioderne på samme måde
// og tegne fordelingen ens — og de skal ikke drive fra hinanden, fordi to
// filer siger næsten det samme.
//
// Ligger som globalt navn ved siden af KL, ikke som modul: siderne er statiske
// og hentes uden byggetrin, præcis som resten af sitet.
//
//   window.BEV.load()            → { beviser, faelles, kilder, updatedAt }
//   window.BEV.history(symbol)   → { dates, closes } eller null
//   window.BEV.afkast(hist)      → { '7d': …, '30d': …, '3m': …, 'ytd': … }
//   window.BEV.fordelingBar(f)   → stablet søjle som HTML
//   window.BEV.risikoSkala(3, 7) → 1-7-skalaen som HTML

(function (global) {
  'use strict';
  const K = global.KL;

  // Farverne følger stigende aktieandel: rolig teal, blå, lilla. Ingen af dem
  // er rød eller grøn — på sitet betyder de op og ned.
  const COLOURS = { 'WEICBS.CO': 'var(--s1)', 'WEICBB.CO': 'var(--s2)', 'WEICBV.CO': 'var(--s3)' };
  const FALDBACK = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

  const url = (symbol) => 'investeringsbevis.html?symbol=' + encodeURIComponent(symbol);

  // ── Hentning ───────────────────────────────────────────────────────────
  // Kurserne står i fondslisten som for alle andre fonde. Alt det kilden ikke
  // har — omkostning, ISIN, beskatning, fordeling — står i den håndholdte fil.
  async function load() {
    const [listRes, faktaRes] = await Promise.all([
      fetch('data/etf.json', { cache: 'no-store' }),
      fetch('data/investeringsbeviser.json', { cache: 'no-cache' }),
    ]);
    if (!listRes.ok) throw new Error('Kunne ikke hente kurserne.');
    const list = await listRes.json();
    const fakta = faktaRes.ok ? await faktaRes.json() : { beviser: {}, faelles: {}, kilder: {} };

    const rows = (list.etfs || [])
      .filter((e) => e.kind === 'investeringsforening')
      .map((e, i) => ({ ...e, fakta: (fakta.beviser || {})[e.symbol] || null,
                        colour: COLOURS[e.symbol] || FALDBACK[i % FALDBACK.length] }));

    // Rækkefølgen er aktieandelen: det er den forskel udstederen selv peger på,
    // og den som resten af siden forklarer. Mangler den, falder vi tilbage på
    // hvor bredt kursen har svunget det seneste år.
    const nogle = (r) => (r.fakta && r.fakta.fordeling && r.fakta.fordeling.aktier != null
      ? r.fakta.fordeling.aktier
      : (r.high_52w != null && r.low_52w != null && r.price ? ((r.high_52w - r.low_52w) / r.price) * 100 : Infinity));
    rows.sort((a, b) => nogle(a) - nogle(b));

    return { rows, faelles: fakta.faelles || {}, kilder: fakta.kilder || {},
             updatedAt: list.updated_at, faktaOpdateret: fakta.opdateret || null };
  }

  async function history(symbol) {
    try {
      const res = await fetch('data/etf-historik/' + encodeURIComponent(symbol) + '.json', { cache: 'no-cache' });
      if (!res.ok) return null;
      const body = await res.json();
      if (!Array.isArray(body.dates) || !Array.isArray(body.closes)) return null;
      return { dates: body.dates, closes: body.closes };
    } catch { return null; }
  }

  // ── Perioder ───────────────────────────────────────────────────────────
  // Skåret på datoer, ikke på antal kurser. Beviserne handles ikke hver dag —
  // det roligste af dem har omkring hundrede kurser om året — så et vindue
  // talt i punkter ville dække noget helt andet end det, der står på knappen.
  const shiftDays = (iso, days) =>
    new Date(new Date(iso + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10);

  const shiftMonths = (iso, months) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 10);
  };

  // Sidste kurs på eller før skæringsdagen. Null hvis serien ikke rækker så
  // langt tilbage — så er der ikke noget at måle over.
  function siden(hist, cut) {
    const d = hist.dates, c = hist.closes;
    if (!d.length || d[0] > cut) return null;
    let i = d.length - 1;
    while (i > 0 && d[i] > cut) i--;
    const base = c[i], last = c[c.length - 1];
    return base && last != null ? { pct: ((last - base) / base) * 100, fra: d[i] } : null;
  }

  const pctOf = (x) => (x ? Math.round(x.pct * 100) / 100 : null);

  function afkast(hist) {
    if (!hist || hist.dates.length < 2) return {};
    const sidst = hist.dates[hist.dates.length - 1];
    const nytaar = sidst.slice(0, 4) + '-01-01';
    return {
      '7d':  pctOf(siden(hist, shiftDays(sidst, 7))),
      '30d': pctOf(siden(hist, shiftDays(sidst, 30))),
      '3m':  pctOf(siden(hist, shiftMonths(sidst, 3))),
      '6m':  pctOf(siden(hist, shiftMonths(sidst, 6))),
      'ytd': pctOf(siden(hist, nytaar)),
      '1y':  pctOf(siden(hist, shiftMonths(sidst, 12))),
      '3y':  pctOf(siden(hist, shiftMonths(sidst, 36))),
      'alt': pctOf({ pct: ((hist.closes[hist.closes.length - 1] - hist.closes[0]) / hist.closes[0]) * 100 }),
      fra: hist.dates[0],
      til: sidst,
    };
  }

  // ── Fordeling ──────────────────────────────────────────────────────────
  // Aktier, lang rente, kort rente og øvrigt som én stablet søjle. Det er den
  // ene figur, der forklarer forskellen mellem de tre afdelinger på ét blik.
  const DELE = [
    { key: 'aktier',     label: 'Aktier',      farve: 'var(--fill-blaa)' },
    { key: 'lang_rente', label: 'Lang rente',  farve: 'var(--fill-lilla)' },
    { key: 'kort_rente', label: 'Kort rente',  farve: 'var(--coop-satin-200)' },
    { key: 'oevrigt',    label: 'Øvrigt',      farve: 'var(--coop-neutral-100)' },
  ];

  // Fast antal decimaler, dansk komma. Fordelingen står med én decimal, mens
  // omkostningen skal have to: 0,58 % og 0,62 % er ikke det samme tal, og med
  // én decimal ville de begge hedde 0,6 %.
  const tal = (n, decimaler) => n.toLocaleString('da-DK',
    { minimumFractionDigits: decimaler, maximumFractionDigits: decimaler });
  const enDecimal = (n) => tal(n, 1);
  const omkostning = (n) => tal(n, 2);

  function fordelingBar(f, opts) {
    // Står søjlerne for flere afdelinger over hinanden, deler de én
    // forklaringsrække — og den må ikke bære det ene bevis' tal, som om de
    // gjaldt dem alle. Farve og navn, ikke procenter.
    if (opts && opts.kunNavne) {
      return DELE.map((d) => '<span class="inline-flex items-center gap-1.5 mr-4">'
        + '<span style="width:9px;height:9px;border-radius:2px;background:' + d.farve
        + ';display:inline-block;flex:none"></span>'
        + '<span class="text-xs muted">' + K.esc(d.label) + '</span></span>').join('');
    }
    if (!f) return '<p class="text-sm faint">Fordelingen er ikke oplyst.</p>';
    const dele = DELE.filter((d) => f[d.key] != null && f[d.key] > 0);
    if (!dele.length) return '<p class="text-sm faint">Fordelingen er ikke oplyst.</p>';
    const sum = dele.reduce((a, d) => a + f[d.key], 0) || 100;
    const højde = (opts && opts.hoejde) || 26;

    const segmenter = dele.map((d) =>
      '<span title="' + K.esc(d.label + ' ' + enDecimal(f[d.key]) + ' %') + '" style="width:'
      + ((f[d.key] / sum) * 100).toFixed(2) + '%;background:' + d.farve + ';display:block;height:100%"></span>').join('');

    const tekst = dele.map((d) =>
      '<span class="inline-flex items-center gap-1.5 mr-4">'
      + '<span style="width:9px;height:9px;border-radius:2px;background:' + d.farve + ';display:inline-block;flex:none"></span>'
      + '<span class="text-xs muted">' + K.esc(d.label) + '</span>'
      + '<span class="text-xs font-bold num">' + enDecimal(f[d.key]) + ' %</span></span>').join('');

    return '<div style="display:flex;height:' + højde + 'px;border-radius:6px;overflow:hidden;'
      + 'border:1px solid var(--hairline)" role="img" aria-label="'
      + K.esc(dele.map((d) => d.label + ' ' + enDecimal(f[d.key]) + ' procent').join(', ')) + '">'
      + segmenter + '</div>'
      + (opts && opts.udenTekst ? '' : '<div class="mt-2 flex flex-wrap gap-y-1">' + tekst + '</div>');
  }

  // ── Regioner ───────────────────────────────────────────────────────────
  function regionsListe(regioner) {
    if (!regioner || !regioner.length) return '<p class="text-sm faint">Regionerne er ikke oplyst.</p>';
    const maks = Math.max.apply(null, regioner.map((r) => r[1]));
    return '<div class="grid gap-2">' + regioner.map(([navn, andel]) =>
      '<div class="flex items-center gap-3">'
      + '<span class="text-xs muted" style="flex:0 0 11rem;line-height:1.3">' + K.esc(navn) + '</span>'
      + '<span style="flex:1 1 auto;background:var(--gridline);border-radius:4px;height:10px">'
      +   '<span style="display:block;height:100%;border-radius:4px;background:var(--fill-blaa);width:'
      +   ((andel / maks) * 100).toFixed(1) + '%"></span></span>'
      + '<span class="text-xs font-bold num" style="flex:0 0 4.5rem;text-align:right;white-space:nowrap">'
      +   enDecimal(andel) + ' %</span></div>').join('') + '</div>';
  }

  // ── Risiko ─────────────────────────────────────────────────────────────
  // Den syvtrins-skala udstederen selv bruger. Trinnet er markeret, ikke farvet
  // grønt eller rødt: skalaen siger noget om udsving, ikke om godt og skidt.
  function risikoSkala(vaerdi, skala) {
    const n = skala || 7;
    if (vaerdi == null) return '<span class="faint">–</span>';
    const trin = Array.from({ length: n }, (_, i) => {
      const on = i + 1 === vaerdi;
      return '<span style="flex:1 1 0;height:26px;display:flex;align-items:center;justify-content:center;'
        + 'font-size:12px;font-weight:700;border:1px solid ' + (on ? 'var(--accent)' : 'var(--hairline)') + ';'
        + 'border-radius:5px;' + (on ? 'background:var(--accent);color:#fff' : 'color:var(--text-muted)') + '">'
        + (i + 1) + '</span>';
    }).join('');
    return '<div style="display:flex;gap:4px;max-width:22rem" role="img" aria-label="Risikoindikator '
      + vaerdi + ' ud af ' + n + '">' + trin + '</div>';
  }

  global.BEV = { COLOURS, url, load, history, afkast, siden, shiftDays, shiftMonths,
                 fordelingBar, regionsListe, risikoSkala, tal, enDecimal, omkostning, DELE };
})(window);

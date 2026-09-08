/* Shared helpers for the kursliste pages: formatting, data loading, and the
   two chart marks. Exposed as a global rather than an ES module so the pages
   work when opened straight off disk as well as over HTTP.

   Everything here reads the files the GitHub Action commits; no page talks to
   an API at runtime. */
(function (global) {
  'use strict';

  // ── Formatting ────────────────────────────────────────────────────────
  const da2 = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const da0 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });

  const fmtPrice = (n) => (n == null ? '–' : da2.format(n));
  const fmtPct   = (n) => (n == null ? '–' : (n > 0 ? '+' : '') + da2.format(n) + '%');
  const fmtDelta = (n) => (n == null ? '–' : (n > 0 ? '+' : '') + da2.format(n));
  const fmtInt   = (n) => (n == null ? '–' : da0.format(n));

  function fmtBig(n) {
    if (n == null) return '–';
    // Above a trillion, whole units would round 5.563 to "6" and lose the
    // figure entirely, so the largest tier keeps two decimals.
    if (n >= 1e12) return da2.format(n / 1e12) + ' bio.';
    if (n >= 1e9) return da0.format(n / 1e9) + ' mia.';
    if (n >= 1e6) return da0.format(n / 1e6) + ' mio.';
    if (n >= 1e3) return da0.format(n / 1e3) + ' t.';
    return da0.format(n);
  }

  function fmtDate(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtAge(iso) {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return 'for ' + mins + ' min. siden';
    const hours = Math.round(mins / 60);
    if (hours < 24) return 'for ' + hours + (hours === 1 ? ' time siden' : ' timer siden');
    const days = Math.round(hours / 24);
    return 'for ' + days + (days === 1 ? ' dag siden' : ' dage siden');
  }

  const dirClass = (n) => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

  // Escape anything that came from the data file before it reaches innerHTML.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Currency view ─────────────────────────────────────────────────────
  // Two modes. "native" shows what the exchange quotes, and every figure is a
  // raw source value. "dkk" converts USD rows at the ECB rate so prices are
  // sortable across markets — a derived number, so callers mark it as one.
  function priceIn(row, mode) {
    return mode === 'dkk' ? row.price_dkk : row.price;
  }
  function currencyLabel(row, mode) {
    return mode === 'dkk' ? 'DKK' : row.currency;
  }
  // True when this row's figure is a conversion rather than a quoted price.
  function isConverted(row, mode) {
    return mode === 'dkk' && row.currency !== 'DKK';
  }

  // ── Markets ───────────────────────────────────────────────────────────
  // One registry, so a flag or an exchange name is never spelled out twice.
  // bench names the index a company from that market is measured against.
  const MARKETS = {
    DK: { label: 'Danmark', flag: '🇩🇰', exchange: 'Nasdaq København', bench: 'OMXC25' },
    SE: { label: 'Sverige', flag: '🇸🇪', exchange: 'Nasdaq Stockholm', bench: 'OMXS30' },
    NO: { label: 'Norge',   flag: '🇳🇴', exchange: 'Oslo Børs',        bench: 'OSEAX'  },
    FI: { label: 'Finland', flag: '🇫🇮', exchange: 'Nasdaq Helsinki',  bench: 'OMXH25' },
    IS: { label: 'Island',  flag: '🇮🇸', exchange: 'Nasdaq Iceland',   bench: null     },
  // Only funds list here — the UCITS venues Danish brokers sell from.
  DE: { label: 'Tyskland', flag: '🇩🇪', exchange: 'Deutsche Börse Xetra', bench: null },
  NL: { label: 'Holland',  flag: '🇳🇱', exchange: 'Euronext Amsterdam',   bench: null },
    US: { label: 'USA',     flag: '🇺🇸', exchange: 'Nasdaq / NYSE',    bench: 'SP500'  },
  };
  const marketOf = (code) => MARKETS[code] || { label: code || '–', flag: '', exchange: '', bench: null };
  const flagOf = (code) => marketOf(code).flag;

  const INDEX_LABELS = {
    SP500: 'S&P 500', NDX: 'Nasdaq-100', SP400: 'S&P 400', SP600: 'S&P 600', 'DK-LARGE': 'København',
  };
  const indexLabel = (code) => INDEX_LABELS[code] || code;

  // ── Derived fields ────────────────────────────────────────────────────
  function decorate(stock) {
    const spark = stock.spark || [];
    const first = spark.length ? spark[0] : null;
    return Object.assign({}, stock, {
      // Where the price sits in the 52-week band, 0–1. Currency-independent,
      // since both bounds and the price share one currency.
      week52pos: (stock.week52_low != null && stock.week52_high != null && stock.week52_high > stock.week52_low)
        ? Math.min(1, Math.max(0, (stock.price - stock.week52_low) / (stock.week52_high - stock.week52_low)))
        : null,
      // Move across the sparkline window, so that column sorts by what its
      // line actually shows.
      change30d: (first && stock.price != null) ? ((stock.price - first) / first) * 100 : null,
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────
  // Pages sit at the root and under /aktie/, so paths are resolved against the
  // document rather than written relative.
  function dataUrl(name) {
    return new URL('data/' + name, global.location.origin + '/').href;
  }

  async function loadList() {
    const res = await fetch(dataUrl('aktier.json'), { cache: 'no-cache', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    return {
      rows: (body.stocks || []).map(decorate),
      updatedAt: body.updated_at,
      markets: body.markets || [],
      fx: body.fx || null,
      failed: body.failed || [],
    };
  }

  // One file per symbol, so a detail page downloads only the company it shows.
  async function loadHistory(symbol) {
    const res = await fetch(dataUrl('historik/' + encodeURIComponent(symbol) + '.json'),
      { cache: 'no-cache', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!Array.isArray(body.dates) || !Array.isArray(body.closes)) throw new Error('ugyldig historik');
    return { dates: body.dates, closes: body.closes, range: body.range, monthly: body.monthly || null };
  }

  async function loadJson(name) {
    const res = await fetch(dataUrl(name), { cache: 'no-cache', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Key figures for every company, small enough to hold on any page; the bulky
  // per-company detail lives in its own file and is only fetched when shown.
  const loadKeyFigures = () => loadJson('nogletal.json');
  const loadBenchmarks = () => loadJson('indeks.json');
  const loadFundamentals = (symbol) => loadJson('regnskab/' + encodeURIComponent(symbol) + '.json');

  // ── Live kurser ───────────────────────────────────────────────────────
  // The files above are the floor: every page renders from them and needs no
  // network at all once loaded. Where /api/kurser exists — the deployment that
  // has a server behind it — the rows on screen are refreshed from it on a
  // timer. Anywhere else (a static host, the offline copy, a file:// page) the
  // first call fails and the whole mechanism switches itself off for the rest
  // of the visit rather than retrying into a wall.
  let liveDead = false;

  async function liveQuotes(symbols) {
    if (liveDead || !symbols || !symbols.length) return null;
    try {
      const res = await fetch('/api/kurser?symbols=' + encodeURIComponent(symbols.join(',')),
        { headers: { accept: 'application/json' } });
      if (!res.ok) { liveDead = true; return null; }
      const json = await res.json();
      // A static host answers a missing path with its own 404 page, which can
      // arrive as a 200 full of HTML; the flag is what proves this is ours.
      if (!json || json.ok !== true) { liveDead = true; return null; }
      return json;
    } catch (err) {
      liveDead = true;
      return null;
    }
  }

  // Copenhagen, Stockholm, Oslo and Helsinki open at 09:00 Danish time and the
  // American exchanges close at 22:00. Polling runs across the union of those
  // hours on weekdays, with five minutes of margin at each end. Danish time is
  // asked for by name, so summer time needs no arithmetic here.
  function tradingNow(at) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Copenhagen', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at || new Date());
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const day = get('weekday');
    if (day === 'Sat' || day === 'Sun') return false;
    const mins = Number(get('hour')) * 60 + Number(get('minute'));
    return mins >= 8 * 60 + 55 && mins <= 22 * 60 + 5;
  }

  // One timer per page. A tick is skipped while the tab is hidden or the
  // markets are shut, so a page left open overnight costs nothing, and the
  // timer wakes on the way back rather than waiting out the interval.
  function startLive(opts) {
    const every = opts.interval || 60000;
    let timer = null, stopped = false;

    const later = () => { if (!stopped) timer = setTimeout(tick, every); };

    async function tick() {
      if (stopped) return;
      if (document.visibilityState === 'hidden' || !tradingNow()) {
        if (opts.status) opts.status('paused');
        return later();
      }
      const symbols = opts.symbols() || [];
      if (!symbols.length) return later();

      const data = await liveQuotes(symbols);
      if (!data) { stopped = true; if (opts.status) opts.status('off'); return; }
      opts.apply(data);
      if (opts.status) opts.status('live', data);
      later();
    }

    document.addEventListener('visibilitychange', () => {
      if (stopped || document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      tick();
    });

    tick();
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  // ── Derived figures ───────────────────────────────────────────────────
  // The price-to-earnings ratio is computed rather than stored, so it can never
  // disagree with the price printed next to it.
  const peOf = (price, eps) => (price && eps && eps > 0 ? price / eps : null);

  // Return over a window of a close series, as a percentage.
  function moveBetween(closes, fromIndex) {
    const last = closes[closes.length - 1], base = closes[fromIndex];
    return (base && last != null) ? ((last - base) / base) * 100 : null;
  }

  // The point nearest a target date, not the first one after it. A monthly
  // series only has month starts, so "a year ago" would otherwise land up to a
  // month late and a one-year return would be measured over eleven.
  function nearestIndex(dates, iso) {
    if (!dates.length) return -1;
    const after = dates.findIndex((d) => d >= iso);
    if (after === 0) return 0;
    if (after === -1) return -1;                   // target is past the end of the series
    const days = (a, b) => Math.abs(new Date(a) - new Date(b));
    return days(dates[after], iso) <= days(dates[after - 1], iso) ? after : after - 1;
  }

  // How far below its own running peak a series has been, point by point. The
  // shape a price chart cannot show: two stocks at the same price can be at a
  // record and 40% down respectively.
  function drawdownSeries(dates, closes) {
    let peak = -Infinity;
    const out = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] > peak) peak = closes[i];
      out.push(peak > 0 ? ((closes[i] - peak) / peak) * 100 : 0);
    }
    return { dates: dates, values: out };
  }

  // ── Marks ─────────────────────────────────────────────────────────────
  // 2px line, no markers, no axis. Direction colour repeats a sign that is
  // already printed in a neighbouring column, so colour never carries meaning
  // on its own.
  function sparkline(points, direction, w, h) {
    if (!points || points.length < 2) return '';
    w = w || 88; h = h || 26;
    const pad = 2;
    const min = Math.min.apply(null, points), max = Math.max.apply(null, points);
    const span = (max - min) || 1;
    const step = (w - pad * 2) / (points.length - 1);

    const d = points.map((p, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (p - min) / span);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');

    const stroke = direction > 0 ? 'var(--delta-up)' : direction < 0 ? 'var(--delta-down)' : 'var(--text-muted)';
    const label = 'Udvikling over ' + points.length + ' handelsdage: ' + fmtPct(direction);
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" '
      + 'role="img" aria-label="' + esc(label) + '" style="display:block">'
      + '<title>' + esc(label) + '</title>'
      + '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // A position mark, not a polarity one, so it wears neutral ink rather than a
  // delta colour. The bounds appear as numbers alongside it.
  function rangeBar(row, w, h) {
    if (row.week52pos == null) return '<span class="faint">–</span>';
    w = w || 96; h = h || 20;
    const pad = 1, y = h / 2;
    const x = pad + (w - pad * 2) * row.week52pos;
    const title = 'Lav ' + fmtPrice(row.week52_low) + ' · Nu ' + fmtPrice(row.price)
                + ' · Høj ' + fmtPrice(row.week52_high) + ' ' + row.currency;

    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" '
      + 'role="img" aria-label="' + esc(title) + '" style="display:block">'
      + '<title>' + esc(title) + '</title>'
      + '<line x1="' + pad + '" y1="' + y + '" x2="' + (w - pad) + '" y2="' + y + '" '
      + 'stroke="var(--gridline)" stroke-width="4" stroke-linecap="round"/>'
      + '<circle cx="' + x.toFixed(1) + '" cy="' + y + '" r="4.5" '
      + 'fill="var(--text-primary)" stroke="var(--surface-1)" stroke-width="2"/></svg>';
  }

  // ── Links ─────────────────────────────────────────────────────────────
  // Symbols carry dots and dashes; slugs keep URLs readable and are reversed
  // by matching against the loaded list rather than by parsing.
  const slug = (symbol) => String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stockUrl = (symbol) => 'aktie.html?symbol=' + encodeURIComponent(symbol);

  // ── Site header ───────────────────────────────────────────────────────
  // Rendered from one place so the three pages cannot drift apart. Two tiers:
  // the brand row, then the section tabs, with the current page marked by
  // aria-current rather than colour alone.
  const NAV = [
    { key: 'kurser',      href: 'markedskurser.html', label: 'Aktiekurser',
      hint: 'Hele listen med kurser, filtre og sortering for begge markeder.' },
    { key: 'etf',         href: 'etf.html',           label: 'ETF-kurser',
      hint: 'Børshandlede fonde: én handel giver dig hele indekset. Kurser, formue og udvikling.' },
    { key: 'inspiration', href: 'inspiration.html',   label: 'Aktieinspiration',
      hint: 'Temalister beregnet ud fra kursdataene — vindere, mest handlede og 52-ugers yderpunkter.' },
    { key: 'sammenlign',  href: 'sammenlign.html',    label: 'Sammenlign',
      hint: 'Stil op til seks selskaber op mod hinanden: nøgletal, udvikling og kurverne på samme akse.' },
    { key: 'beregner',    href: 'beregner.html',      label: 'Afkastberegner',
      hint: 'Fremskriv en opsparing: startindskud, månedligt beløb, antal år og forventet afkast.' },
  ];

  function renderNav(activeKey) {
    const host = document.getElementById('sitenav');
    if (!host) return;

    const tabs = NAV.map((n) => {
      const on = n.key === activeKey;
      return '<a href="' + n.href + '" class="nav-tab' + (on ? ' is-active' : '') + '"'
        + (on ? ' aria-current="page"' : '')
        + ' data-hint="' + esc(n.hint) + '" data-hint-title="' + esc(n.label) + '">'
        + esc(n.label) + '</a>';
    }).join('');

    // Logoet er Coop Banks eget, hentet som vektor fra coopbank.dk's header og
    // sat til currentColor, så det følger farven omkring sig — rødt på den lyse
    // header, lyst hvis den nogensinde bliver mørk.
    const LOGO = '<svg class="nav-logo" width="149" height="22" role="img" aria-label="Coop Bank" viewBox="0 0 149 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M81.0557 0.708762C81.0557 0.433459 81.2763 0.210873 81.5491 0.210873H89.8799C93.5954 0.210873 95.4764 1.49953 95.4764 4.21742V4.70945C95.4764 5.88681 94.9713 6.82402 94.0599 7.52106C93.7812 7.73194 93.7928 8.14196 94.0773 8.34112C95.2267 9.1436 95.7783 10.2682 95.7783 11.9025V12.4414C95.7783 15.3233 93.6186 16.9634 89.8103 16.9634H81.5491C81.2763 16.9634 81.0557 16.7408 81.0557 16.4655V0.708762ZM89.2762 6.72444C90.4605 6.72444 91.0875 6.25584 91.0875 5.20148V4.96718C91.0875 3.91283 90.5998 3.49109 89.3923 3.49109H86.2167C85.9438 3.49109 85.7232 3.71367 85.7232 3.98898V6.22655C85.7232 6.50185 85.9438 6.72444 86.2167 6.72444H89.2762ZM89.2762 13.4723C90.7159 13.4723 91.25 13.0271 91.25 11.8322V11.5979C91.25 10.4264 90.6927 9.93436 89.3923 9.93436H86.2167C85.9438 9.93436 85.7232 10.1569 85.7232 10.4323V12.9744C85.7232 13.2497 85.9438 13.4723 86.2167 13.4723H89.2762Z" fill="currentColor"/><path d="M102.205 0.210873H107.982C108.191 0.210873 108.376 0.345596 108.446 0.544752L113.903 16.2956C114.013 16.6178 113.775 16.9575 113.439 16.9575H109.665C109.45 16.9575 109.265 16.817 109.195 16.6119L108.394 14.1576C108.33 13.9526 108.138 13.812 107.923 13.812H102.043C101.828 13.812 101.642 13.9526 101.572 14.1576L100.771 16.6119C100.707 16.817 100.516 16.9575 100.301 16.9575H96.7364C96.3939 16.9575 96.1558 16.6178 96.2719 16.2956L101.741 0.544752C101.81 0.345596 101.996 0.210873 102.205 0.210873ZM106.397 10.0749C106.733 10.0749 106.971 9.74107 106.867 9.4189L105.038 3.79568H104.968L103.14 9.4189C103.035 9.74107 103.273 10.0749 103.61 10.0749H106.402H106.397Z" fill="currentColor"/><path d="M115.819 0.210873H120.718C120.898 0.210873 121.067 0.310451 121.154 0.474461L126.356 10.3092H126.379V0.708762C126.379 0.433459 126.599 0.210873 126.872 0.210873H130.414C130.686 0.210873 130.907 0.433459 130.907 0.708762V16.4596C130.907 16.7349 130.686 16.9575 130.414 16.9575H125.816C125.636 16.9575 125.467 16.858 125.38 16.6939L119.9 6.32027H119.853V16.4596C119.853 16.7349 119.633 16.9575 119.36 16.9575H115.819C115.546 16.9575 115.325 16.7349 115.325 16.4596V0.708762C115.325 0.433459 115.546 0.210873 115.819 0.210873Z" fill="currentColor"/><path d="M133.351 0.210873H137.031C137.304 0.210873 137.525 0.433459 137.525 0.708762V5.55293C137.525 6.01568 138.094 6.22655 138.39 5.88096L143.11 0.386598C143.203 0.275305 143.342 0.21673 143.481 0.21673H147.888C148.317 0.21673 148.544 0.732192 148.248 1.05436L143.162 6.619C143.011 6.78302 142.988 7.02903 143.104 7.22233L148.636 16.2136C148.84 16.5475 148.602 16.9751 148.219 16.9751H143.981C143.806 16.9751 143.644 16.8814 143.551 16.7291L140.172 10.8599C140.004 10.5728 139.609 10.526 139.383 10.772L137.647 12.664C137.56 12.7577 137.513 12.8748 137.513 13.0037V16.4831C137.513 16.7584 137.293 16.981 137.02 16.981H133.339C133.066 16.981 132.846 16.7584 132.846 16.4831V0.708762C132.846 0.433459 133.066 0.210873 133.339 0.210873H133.351Z" fill="currentColor"/><path d="M62.6407 0.0878957C58.0022 0.0820382 54.2344 2.03259 52.8586 5.52368C51.4943 2.02674 47.7381 0.0644656 43.0996 0.0586081C38.9777 0.0527506 35.5467 1.59328 33.8632 4.38732C32.1912 1.58156 28.766 0.0293205 24.6441 0.023463C18.7806 0.0117479 14.3046 3.13381 14.2988 8.54616C14.2988 9.91096 14.5833 11.1293 15.1058 12.1895C15.0361 12.2188 14.9722 12.2481 14.9026 12.2774C14.6355 12.3828 14.3453 12.4824 14.026 12.5761C13.2132 12.7987 12.3017 12.9217 11.3845 12.9159C8.7256 12.9159 6.33956 11.2172 6.34537 8.62231C6.34537 5.80484 8.40049 4.12373 11.0594 4.12959C12.0753 4.12959 12.8533 4.19402 13.6544 4.48104C13.6544 4.48104 14.5717 2.46605 16.1159 1.30626C15.8198 1.16568 15.5122 1.03096 15.1812 0.890377C13.7879 0.281194 12.1682 3.28514e-05 10.3453 3.28514e-05C4.48182 -0.0116822 0.0116335 3.11038 2.2596e-05 8.52273C-0.0115883 13.8999 4.45279 17.0396 10.3163 17.0454C11.8663 17.0454 13.5906 16.8228 15.0767 16.407C15.6341 16.2722 16.9345 15.8271 17.8866 15.2706C19.6688 16.4362 22.0026 17.063 24.6151 17.0689C28.7369 17.0747 32.168 15.5342 33.8457 12.7519C35.5177 15.54 38.9429 17.0923 43.0648 17.0981C47.1808 17.104 50.606 15.5693 52.2896 12.7987L52.2722 21.462L58.5827 21.4737V16.5768C59.8135 16.94 61.1661 17.1333 62.6059 17.1333C68.4694 17.145 72.9454 14.0229 72.9512 8.64574C72.957 3.26853 68.51 0.0996108 62.6407 0.0878957ZM24.6209 13.1326C21.7878 13.1326 20.6384 10.9653 20.6384 8.55788C20.6384 6.15043 21.8053 3.95972 24.6325 3.96558C27.4656 3.96558 28.6208 6.13286 28.615 8.56959C28.6092 11.0063 27.4481 13.1326 24.6151 13.1267L24.6209 13.1326ZM43.0764 13.1619C40.2491 13.1619 39.088 10.9946 39.0938 8.58716C39.0938 6.14458 40.2607 3.98901 43.0938 3.99486C45.9269 4.00072 47.0821 6.16215 47.0763 8.59888C47.0763 11.0063 45.9094 13.1619 43.0822 13.156L43.0764 13.1619ZM62.6233 13.197C59.7961 13.197 58.635 11.0298 58.6408 8.62231C58.6408 6.17972 59.8077 4.02415 62.6407 4.03001C65.4738 4.03587 66.6291 6.19729 66.6232 8.63402C66.6174 11.0708 65.4564 13.197 62.6291 13.1912L62.6233 13.197Z" fill="currentColor"/></svg>';

    // Én række. Logo, sub-brand, sektioner og tilbage-link står på samme linje,
    // som på coopbank.dk, hvor navigationen også kun er ét bånd.
    const back = activeKey === 'forside' ? ''
      : '<a href="index.html" class="nav-back">← Til forsiden</a>';

    host.innerHTML =
      '<div class="nav-top"><div class="nav-inner">'
        + '<a href="index.html" class="nav-brand" aria-label="Coop Bank Investering">'
          + LOGO + '<span class="nav-brand-sub">Investering</span></a>'
        + '<nav class="nav-sections" aria-label="Sektioner">' + tabs + '</nav>'
        + back
      + '</div></div>';
  }

  // ── Hint tooltips ─────────────────────────────────────────────────────
  // One delegated listener for every [data-hint] on the page. Keyboard focus
  // opens it too, so the explanation is not mouse-only. The box is positioned
  // in viewport coordinates and clamped so it never leaves the screen.
  function initHints() {
    let box = document.getElementById('kl-hint');
    if (!box) {
      box = document.createElement('div');
      box.id = 'kl-hint';
      box.setAttribute('role', 'tooltip');
      document.body.appendChild(box);
    }

    let current = null;

    function show(el) {
      const text = el.getAttribute('data-hint');
      if (!text) return;
      current = el;
      const title = el.getAttribute('data-hint-title');
      box.innerHTML = (title ? '<strong>' + esc(title) + '</strong>' : '') + esc(text);
      box.classList.add('on');
      place(el);
    }

    function place(el) {
      const r = el.getBoundingClientRect();
      const w = box.offsetWidth, h = box.offsetHeight;
      const margin = 8;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      // Prefer below; flip above when there is not room.
      let top = r.bottom + margin;
      if (top + h > window.innerHeight - margin) top = r.top - h - margin;
      box.style.left = left + 'px';
      box.style.top = Math.max(margin, top) + 'px';
    }

    function hide() { current = null; box.classList.remove('on'); }

    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-hint]');
      if (el && el !== current) show(el);
    });
    document.addEventListener('mouseout', (e) => {
      const el = e.target.closest('[data-hint]');
      if (el && el === current && !el.contains(e.relatedTarget)) hide();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-hint]');
      if (el) show(el);
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', () => { if (current) place(current); }, { passive: true });
    window.addEventListener('resize', hide);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHints);
  else initHints();

  global.KL = {
    initHints, renderNav,
    fmtPrice, fmtPct, fmtDelta, fmtInt, fmtBig, fmtDate, fmtAge, dirClass, esc,
    priceIn, currencyLabel, isConverted,
    decorate, loadList, loadHistory, loadKeyFigures, loadBenchmarks, loadFundamentals,
    liveQuotes, tradingNow, startLive,
    peOf, moveBetween, nearestIndex, drawdownSeries,
    MARKETS, marketOf, flagOf, indexLabel,
    sparkline, rangeBar, slug, stockUrl,
  };
})(window);

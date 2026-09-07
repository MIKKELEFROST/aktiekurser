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
    return { dates: body.dates, closes: body.closes, range: body.range };
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
    { key: 'inspiration', href: 'inspiration.html',   label: 'Aktieinspiration',
      hint: 'Temalister beregnet ud fra kursdataene — vindere, mest handlede og 52-ugers yderpunkter.' },
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

    host.innerHTML =
      '<div class="nav-top"><div class="nav-inner">'
        + '<a href="index.html" class="nav-brand">Coop&nbsp;Bank <span class="nav-brand-sub">Invest</span></a>'
        + '<a href="index.html" class="nav-back">← Til forsiden</a>'
      + '</div></div>'
      + '<div class="nav-bottom"><nav class="nav-inner" aria-label="Sektioner">' + tabs + '</nav></div>';
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
    decorate, loadList, loadHistory,
    sparkline, rangeBar, slug, stockUrl,
  };
})(window);

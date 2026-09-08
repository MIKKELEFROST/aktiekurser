/* Brugergrænsefladen til lagerskat.html. Her ligger felter, graf, tabel og
   tekst — ikke en eneste skatteregel. Hele regnestykket står i
   assets/lagerskat.js og bliver testet for sig i scripts/lagerskat.test.mjs. */
(function () {
  'use strict';

  const K = window.KL;
  const L = window.Lagerskat;
  const $ = (s) => document.querySelector(s);

  K.renderNav('lagerskat');        // ingen fane markeres: siden står uden for navigationen
  K.initHints();

  // ── Dansk formatering ───────────────────────────────────────────────────
  const kr0 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
  const krSigned = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0, signDisplay: 'always' });
  const pct1 = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const kr = (n) => kr0.format(Math.round(n));
  const krPlus = (n) => krSigned.format(Math.round(n));
  const pct = (n) => pct1.format(n) + '\u00a0%';

  /* K.fmtBig runder til hele enheder, så 1,5 mio. og 2,0 mio. begge bliver til
     "2 mio." — på en akse med runde trin giver det to hjælpelinjer med samme
     mærkat. Aksen får derfor sin egen formatering med en decimal hvor der er
     brug for den. */
  const axisNum = (n, decimals) =>
    new Intl.NumberFormat('da-DK', { maximumFractionDigits: decimals }).format(n);
  function axisKr(v) {
    const a = Math.abs(v);
    if (a < 0.5) return '0';
    if (a >= 1e6) return axisNum(v / 1e6, 1) + ' mio.';
    if (a >= 1e3) return axisNum(v / 1e3, a >= 1e4 ? 0 : 1) + ' t.';
    return axisNum(v, 0);
  }

  /* Et beløb der ligger under en halv krone fra nul er nul, når det skal på
     skærmen. Ellers kan en afrundingsfejl komme til at stå som "-0 kr." */
  const zeroish = (n) => Math.abs(n) < 0.5;

  // ── Felterne ────────────────────────────────────────────────────────────
  // `kind` styrer både formateringen i feltet og fejlteksten. `sep` er de
  // kronefelter der bærer tusindtalsseparator og derfor må være tekstfelter:
  // et number-input tømmer sig selv i det øjeblik der står et punktum i det.
  const FIELDS = {
    start:    { kind: 'kr',  min: 0, max: 1e12, def: 500000, sep: true,  label: 'Startkapital' },
    monthly:  { kind: 'kr',  min: 0, max: 1e12, def: 5000,   sep: true,  label: 'Månedlig indbetaling' },
    years:    { kind: 'int', min: 1, max: 50,   def: 10,     sep: false, label: 'Tidshorisont' },
    rate:     { kind: 'pct', min: 0, max: 30,   def: 10,     sep: false, label: 'Årligt afkast' },
    other:    { kind: 'kr',  min: 0, max: 1e12, def: 0,      sep: true,  label: 'Øvrig aktieindkomst' },
    bracket:  { kind: 'kr',  min: 0, max: 1e12, def: 79400,  sep: true,  label: 'Progressionsgrænse' },
    lowRate:  { kind: 'pct', min: 0, max: 100,  def: 27,     sep: false, label: 'Lav sats' },
    highRate: { kind: 'pct', min: 0, max: 100,  def: 42,     sep: false, label: 'Høj sats' },
  };
  const IDS = Object.keys(FIELDS);

  // Enheden står uden afsluttende punktum, fordi beløbet bliver sat ind midt i
  // en sætning der selv slutter — ellers står der "500.000 kr..".
  const unitOf = (kind) => (kind === 'kr' ? ' kr' : kind === 'pct' ? '\u00a0%' : ' år');
  const showFallback = (id, value) =>
    (FIELDS[id].kind === 'kr' ? kr(value) : pct1.format(value)) + unitOf(FIELDS[id].kind);

  const digitsOf = (v) => String(v).replace(/[^\d]/g, '');

  function rawValue(id) {
    const el = $('#' + id);
    return FIELDS[id].sep ? digitsOf(el.value) : el.value.trim().replace(',', '.');
  }

  function setBox(id, value) {
    $('#' + id).value = FIELDS[id].sep ? kr0.format(value) : pct1.format(value);
  }

  /* Når feltet skrives om, flytter hvert ciffer sig til højre for markøren.
     Markøren sættes derfor tilbage efter det samme antal cifre den stod bag,
     ikke ved den samme tegnposition — ellers vandrer den baglæns, når man
     retter midt i et beløb. */
  function reformat(el) {
    const before = (el.value.slice(0, el.selectionStart || 0).match(/\d/g) || []).length;
    const digits = digitsOf(el.value);
    el.value = digits ? kr0.format(Number(digits)) : '';
    if (document.activeElement !== el) return;
    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < before) {
      if (/\d/.test(el.value[pos])) seen++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
  }

  /**
   * Læser alle felter og melder tilbage om hvert enkelt. Et ugyldigt felt
   * stopper ikke beregningen: den kører videre på feltets standardværdi eller
   * på nærmeste tilladte tal, og brugeren får at vide præcis hvad der blev
   * regnet med. Derfor kan der aldrig komme et NaN ud på skærmen.
   *
   * `keepMessages` lader en besked blive stående, selv om feltet er blevet
   * gyldigt. Den bruges når feltet mister fokus og bliver skrevet om til den
   * værdi der faktisk blev regnet med: forsvandt beskeden i samme øjeblik,
   * ville formularen blive kortere midt i det klik brugeren er ved at lave, og
   * klikket ville ramme ved siden af det den var på vej hen til. Beskeden er
   * stadig sand bagefter — den fortæller hvad der blev regnet med — og den
   * ryddes så snart feltet bliver rettet igen.
   *
   * @param {boolean} [keepMessages]
   */
  function readFields(keepMessages) {
    const values = {};
    const problems = [];

    for (const id of IDS) {
      const spec = FIELDS[id];
      const raw = rawValue(id);
      let value, problem = null;

      if (raw === '') {
        value = spec.def;
        problem = spec.label + ' mangler. Der regnes med ' + showFallback(id, value) + '.';
      } else if (!Number.isFinite(Number(raw))) {
        value = spec.def;
        problem = spec.label + ' skal være et tal. Der regnes med ' + showFallback(id, value) + '.';
      } else {
        value = Number(raw);
        if (spec.kind === 'int') value = Math.round(value);
        if (value < spec.min) {
          value = spec.min;
          problem = spec.label + ' kan ikke være mindre end ' + showFallback(id, spec.min)
            + '. Der regnes med ' + showFallback(id, value) + '.';
        } else if (value > spec.max) {
          value = spec.max;
          problem = spec.label + ' kan højst være ' + showFallback(id, spec.max)
            + '. Der regnes med ' + showFallback(id, value) + '.';
        }
      }

      $('#' + id).setAttribute('aria-invalid', problem ? 'true' : 'false');
      const message = $('#' + id + 'Err');
      if (problem) {
        message.textContent = problem;
        message.hidden = false;
        problems.push(id);
      } else if (!keepMessages) {
        message.textContent = '';
        message.hidden = true;
      }
      values[id] = value;
    }

    // Satserne må ikke bytte plads: en lav sats over den høje ville gøre
    // progressionen omvendt, og så betyder resten af siden ikke det den siger.
    if (values.lowRate > values.highRate) {
      const message = $('#lowRateErr');
      message.textContent = 'Den lave sats kan ikke være højere end den høje. Der regnes med '
        + pct(values.highRate) + ' begge steder.';
      message.hidden = false;
      problems.push('lowRate');
      values.lowRate = values.highRate;
      $('#lowRate').setAttribute('aria-invalid', 'true');
    }

    /* Ligger fejlen i et af de foldede felter, foldes de ud. Ellers ville
       beskeden stå gemt bag en lukket <details>, og resultatet ville se ud til
       at være regnet på noget andet end det der står i felterne. */
    const advanced = $('#form details');
    if (!advanced.open && problems.some((id) => advanced.contains($('#' + id)))) advanced.open = true;

    return { values: values, problems: problems };
  }

  const toAssumptions = (v) => ({
    start: v.start, monthly: v.monthly, years: v.years,
    annualReturn: v.rate / 100,
    bracket: v.bracket, otherIncome: v.other,
    lowRate: v.lowRate / 100, highRate: v.highRate / 100,
  });

  // ── Grafernes geometri ──────────────────────────────────────────────────
  /* viewBox'en følger elementets faktiske bredde i stedet for at være låst til
     900 enheder. Ellers presses tegningen sammen på en telefon — 900 enheder
     ind i 330 px er en skalering på 0,37, og så bliver en 11-punkts aksetekst
     til fire px, som ingen kan læse. Med viewBox ≈ elementbredden er skalaen
     omkring 1, og skriften står i den størrelse den er sat til.

     Begge grafer får samme venstre- og højremargen, så årene i forskelsstriben
     står lodret under de samme år i kurven ovenover. */
  function geometry(el, tall) {
    const width = Math.round(el.getBoundingClientRect().width) || 900;
    const W = Math.min(900, Math.max(360, width));
    const narrow = W < 520;
    const pad = { L: narrow ? 52 : 76, R: narrow ? 58 : 64, T: 14, B: narrow ? 26 : 28 };
    const H = tall ? (narrow ? 250 : 300) : (narrow ? 120 : 130);
    const g = Object.assign({ W: W, H: H, narrow: narrow, fs: narrow ? 10 : 11 }, pad);
    g.iw = g.W - g.L - g.R;
    g.ih = g.H - g.T - g.B;
    return g;
  }

  let series = [];                 // rækkerne graferne står på lige nu
  let shiftYears = new Set();      // de år hvor fordelen skifter fra den ene til den anden
  let g = geometry(document.createElement('div'), true);   // sat rigtigt af drawChart
  let xAt = () => 0;               // år → x
  let yAt = () => 0;               // kroner → y

  /* Hvilke år skifter fordelen? Et uafgjort år har ingen vinder at skifte fra,
     så det springes over — nøjagtig samme regel som findShifts bruger, og det
     er med vilje ét sted: ellers kunne grafen og tabellen ende med at markere
     hver sine år. */
  function shiftYearsOf(rows) {
    const out = new Set();
    let previous = null;
    for (const row of rows) {
      if (row.year === 0 || row.leader === 'lige') continue;
      if (previous && previous !== row.leader) out.add(row.year);
      previous = row.leader;
    }
    return out;
  }

  /* Runde trin op til det første der ligger på eller over toppen, så den
     øverste hjælpelinje altid er et tal kurven faktisk når op under. */
  function niceTicks(max) {
    const raw = (max || 1) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = ([1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) || 10) * mag;
    const top = Math.ceil((max || 1) / step) * step;
    const out = [];
    for (let v = 0; v <= top + step * 0.001; v += step) out.push(v);
    return out;
  }

  const line = (rows, get, x, y) => rows.map((r, i) =>
    (i ? 'L ' : 'M ') + x(i).toFixed(1) + ' ' + y(get(r)).toFixed(1)).join(' ');

  function drawChart(rows) {
    const svg = document.getElementById('chart');
    series = rows;
    shiftYears = shiftYearsOf(rows);
    g = geometry(svg, true);
    svg.setAttribute('viewBox', '0 0 ' + g.W + ' ' + g.H);

    const max = Math.max(1, ...rows.map((r) => Math.max(r.etfValue, r.stockNet)));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const x = (i) => g.L + (rows.length < 2 ? g.iw : (i / (rows.length - 1)) * g.iw);
    const y = (v) => g.T + g.ih - (v / top) * g.ih;
    xAt = x; yAt = y;

    /* Et svagt bånd bag hvert år viser hvem der fører netop det år, og en
       stiplet lodret streg markerer selve skiftet. Tinten er holdt lav med
       vilje: den skal kunne anes bag hjælpelinjerne, ikke overdøve kurverne.
       Uafgjorte år får ingen flade, for der er ingen at vise. */
    let bands = '', marks = '';
    for (let i = 1; i < rows.length; i++) {
      const fill = rows[i].leader === 'etf' ? 'var(--serie-etf-soft)'
        : rows[i].leader === 'aktier' ? 'var(--serie-aktier-soft)' : null;
      if (fill) {
        bands += '<rect x="' + x(i - 1).toFixed(1) + '" y="' + g.T
          + '" width="' + (x(i) - x(i - 1)).toFixed(1) + '" height="' + g.ih
          + '" fill="' + fill + '"/>';
      }
      if (shiftYears.has(rows[i].year)) {
        marks += '<line x1="' + x(i - 1).toFixed(1) + '" x2="' + x(i - 1).toFixed(1)
          + '" y1="' + g.T + '" y2="' + (g.T + g.ih) + '" stroke="var(--text-muted)" '
          + 'stroke-width="1" stroke-dasharray="2 3" opacity="0.75"/>';
      }
    }

    const grid = ticks.map((t) =>
      '<line x1="' + g.L + '" x2="' + (g.W - g.R) + '" y1="' + y(t).toFixed(1)
      + '" y2="' + y(t).toFixed(1) + '" stroke="var(--gridline)" stroke-width="1"/>'
      + '<text x="' + (g.L - 8) + '" y="' + (y(t) + 4).toFixed(1) + '" text-anchor="end" '
      + 'font-size="' + g.fs + '" fill="var(--text-muted)">' + axisKr(t) + '</text>').join('');

    const every = Math.max(1, Math.ceil((rows.length - 1) / (g.narrow ? 5 : 8)));
    const xLabels = rows.filter((r, i) => i % every === 0 || i === rows.length - 1).map((r) =>
      '<text x="' + x(r.year).toFixed(1) + '" y="' + (g.H - 8) + '" text-anchor="middle" '
      + 'font-size="' + g.fs + '" fill="var(--text-muted)">'
      + (r.year === 0 ? 'Nu'
         : (!g.narrow || r.year === rows[rows.length - 1].year ? 'År ' : '') + r.year) + '</text>').join('');

    /* Direkte mærkater ved linjernes ende, så identiteten ikke kun ligger i
       farven. Teksten står i sin egen tekstfarve; det er stregstumpen ved siden
       af der bærer serien — fuldt optrukket for ETF'en, stiplet for aktierne,
       præcis som i legenden. Ligger de to endepunkter oven i hinanden, skubbes
       de fra hinanden, så mærkaterne aldrig lapper over. */
    const last = rows[rows.length - 1];
    const lx = x(rows.length - 1);
    let etfY = y(last.etfValue), stockY = y(last.stockNet);
    if (Math.abs(etfY - stockY) < 14) {
      const mid = (etfY + stockY) / 2;
      const order = etfY <= stockY ? 1 : -1;
      etfY = mid - 7 * order; stockY = mid + 7 * order;
    }
    const clampY = (v) => Math.min(Math.max(v, g.T + 5), g.T + g.ih);
    etfY = clampY(etfY); stockY = clampY(stockY);
    const tag = (ty, label, dash, color) =>
      '<line x1="' + (lx + 6) + '" x2="' + (lx + 18) + '" y1="' + ty.toFixed(1) + '" y2="' + ty.toFixed(1)
      + '" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round"' + dash + '/>'
      + '<text x="' + (lx + 22) + '" y="' + (ty + 3.5).toFixed(1) + '" font-size="' + g.fs
      + '" font-weight="700" fill="var(--text-secondary)">' + label + '</text>';

    svg.innerHTML =
      bands + grid + marks
      // En usynlig plade under mærkerne, så hele feltet reagerer på musen —
      // rod-SVG'et får kun begivenheder der hvor der faktisk er malet.
      + '<rect x="' + g.L + '" y="' + g.T + '" width="' + g.iw + '" height="' + g.ih + '" fill="transparent"/>'
      + '<path d="' + line(rows, (r) => r.etfValue, x, y) + '" fill="none" stroke="var(--serie-etf)" '
        + 'stroke-width="2" stroke-linejoin="round"/>'
      + '<path d="' + line(rows, (r) => r.stockNet, x, y) + '" fill="none" stroke="var(--serie-aktier)" '
        + 'stroke-width="2" stroke-linejoin="round" stroke-dasharray="7 4"/>'
      + tag(etfY, 'ETF', '', 'var(--serie-etf)')
      + tag(stockY, 'Aktier', ' stroke-dasharray="5 3"', 'var(--serie-aktier)')
      + xLabels
      + '<g class="crosshair" id="cross" style="opacity:0">'
        + '<line y1="' + g.T + '" y2="' + (g.T + g.ih) + '" stroke="var(--text-muted)" '
          + 'stroke-width="1" stroke-dasharray="3 3"/>'
        // 2 px ring i fladens egen farve, så prikkerne kan skelnes hvor kurverne krydser
        + '<circle id="crossEtf" r="4.5" fill="var(--serie-etf)" stroke="var(--surface-1)" stroke-width="2"/>'
        + '<circle id="crossStock" r="4.5" fill="var(--serie-aktier)" stroke="var(--surface-1)" stroke-width="2"/>'
      + '</g>';
  }

  function drawDiff(rows) {
    const svg = document.getElementById('diff');
    const d = geometry(svg, false);
    // Samme vandrette inddeling som kurven ovenover, så årene står lodret over
    // hinanden selv om striben er lavere.
    d.L = g.L; d.R = g.R; d.iw = d.W - d.L - d.R;
    svg.setAttribute('viewBox', '0 0 ' + d.W + ' ' + d.H);

    const years = rows.slice(1);
    const spanX = (i) => d.L + (rows.length < 2 ? d.iw : (i / (rows.length - 1)) * d.iw);
    const values = years.map((r) => r.difference);
    const up = Math.max(0, ...values);
    const down = Math.max(0, ...values.map((v) => -v));
    const total = up + down;

    // Nullinjen ligger hvor de to yderpunkter kræver det. Er alt på samme side,
    // klemmes den mod kanten, så hele højden går til den side der bruges.
    const zeroY = total === 0 ? d.T + d.ih / 2 : d.T + (up / total) * d.ih;
    const scale = total === 0 ? 0 : d.ih / total;
    const width = years.length ? Math.max(2, Math.min(20, (spanX(1) - spanX(0)) * 0.62)) : 2;

    const bars = years.map((r, i) => {
      const cx = spanX(i + 1);
      const h = Math.abs(r.difference) * scale;
      if (h < 0.4) return '';   // en forskel på nul har ingen søjle at tegne
      const yTop = r.difference > 0 ? zeroY - h : zeroY;
      const fill = r.difference > 0 ? 'var(--serie-aktier)' : 'var(--serie-etf)';
      const who = r.difference > 0 ? 'aktierne' : 'ETF’en';
      return '<rect x="' + (cx - width / 2).toFixed(1) + '" y="' + yTop.toFixed(1)
        + '" width="' + width.toFixed(1) + '" height="' + Math.max(h, 1).toFixed(1)
        + '" rx="2" fill="' + fill + '">'
        + '<title>År ' + r.year + ': ' + who + ' fører med ' + kr(Math.abs(r.difference)) + ' kr.</title>'
        + '</rect>';
    }).join('');

    /* Nullinjen kan ligge helt oppe eller helt nede, når næsten hele forskellen
       vender samme vej. Så falder yderpunktets mærkat oven i nullinjens eget
       "0" — derfor skrives den kun, når der er plads mellem de to. */
    const label = (text, ty, anchor, x, weight) =>
      '<text x="' + x + '" y="' + ty.toFixed(1) + '" text-anchor="' + anchor + '" font-size="'
      + (d.fs - 1) + '"' + (weight ? ' font-weight="700"' : '') + ' fill="var(--text-'
      + (weight ? 'secondary' : 'muted') + ')">' + text + '</text>';
    const edge = (value, ty, sign) =>
      value <= 0 || Math.abs(ty - zeroY) < 12 ? '' : label(sign + axisKr(value), ty, 'end', d.L - 8, false);

    // Siden navngives kun hvis den faktisk bruges, og den holdes fri af nullinjen.
    const side = (text, ty) => label(text, Math.min(Math.max(ty, d.T + 9), d.H - 5), 'start',
      d.W - d.R + width / 2 + 5, true);

    svg.innerHTML =
      bars
      + '<line x1="' + d.L + '" x2="' + (d.W - d.R) + '" y1="' + zeroY.toFixed(1) + '" y2="' + zeroY.toFixed(1)
        + '" stroke="var(--hairline)" stroke-width="1"/>'
      + label('0', zeroY + 4, 'end', d.L - 8, false)
      + edge(up, d.T + 9, '+')
      + edge(down, d.T + d.ih + 2, '−')
      + (up > 0 ? side('Aktier', zeroY - 6) : '')
      + (down > 0 ? side('ETF', zeroY + 14) : '')
      + (up + down === 0
        ? '<text x="' + (d.L + d.iw / 2) + '" y="' + (zeroY - 8).toFixed(1) + '" text-anchor="middle" '
          + 'font-size="' + d.fs + '" fill="var(--text-muted)">Ingen forskel i nogen af årene</text>'
        : '');
  }

  // ── Krydsmarkør og forklaringsboks ──────────────────────────────────────
  let hovered = -1;

  function showIndex(i) {
    if (!series.length) return;
    hovered = Math.min(Math.max(i, 0), series.length - 1);
    const r = series[hovered];
    const svg = document.getElementById('chart'), cross = svg.querySelector('#cross');
    if (!cross) return;
    const px = xAt(hovered);

    cross.style.opacity = '1';
    cross.querySelector('line').setAttribute('x1', String(px));
    cross.querySelector('line').setAttribute('x2', String(px));
    cross.querySelector('#crossEtf').setAttribute('cx', String(px));
    cross.querySelector('#crossEtf').setAttribute('cy', String(yAt(r.etfValue)));
    cross.querySelector('#crossStock').setAttribute('cx', String(px));
    cross.querySelector('#crossStock').setAttribute('cy', String(yAt(r.stockNet)));

    const lead = r.leader === 'lige' ? 'Beløbene er ens'
      : (r.leader === 'aktier' ? 'Aktierne fører med ' : 'ETF’en fører med ')
        + kr(Math.abs(r.difference)) + ' kr.';

    const tip = document.getElementById('tooltip');
    tip.innerHTML =
      '<strong>' + (r.year === 0 ? 'Ved start' : 'Efter ' + r.year + ' år') + '</strong>'
      + '<div class="tt-row"><span class="dot dot-etf"></span>ETF<span class="tt-val">' + kr(r.etfValue) + ' kr.</span></div>'
      + '<div class="tt-row"><span class="dot dot-aktier"></span>Aktier<span class="tt-val">' + kr(r.stockNet) + ' kr.</span></div>'
      + '<div class="tt-row faint" style="margin-top:3px">' + lead + '</div>';
    tip.style.opacity = '1';

    const box = svg.getBoundingClientRect();
    const left = box.width * (px / g.W);
    const pointerY = Math.min(yAt(r.etfValue), yAt(r.stockNet));
    tip.style.left = Math.min(Math.max(left - tip.offsetWidth / 2, 0),
      Math.max(0, box.width - tip.offsetWidth)) + 'px';
    tip.style.top = Math.max(box.height * (pointerY / g.H) - tip.offsetHeight - 12, 0) + 'px';
  }

  function hidePoint() {
    hovered = -1;
    const cross = document.getElementById('chart').querySelector('#cross');
    if (cross) cross.style.opacity = '0';
    document.getElementById('tooltip').style.opacity = '0';
  }

  // Skærmpunkter til viewBox-enheder gennem SVG'ets egen matrix: tegningen er
  // skaleret ind i elementet, så elementets bredde ikke er målestokken.
  function indexFromEvent(evt) {
    const svg = document.getElementById('chart'), ctm = svg.getScreenCTM();
    if (!ctm || !series.length) return -1;
    const p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    const local = p.matrixTransform(ctm.inverse());
    return Math.round(((local.x - g.L) / g.iw) * (series.length - 1));
  }

  const chart = document.getElementById('chart');
  // pointermove dækker mus, finger og pen med én begivenhed.
  chart.addEventListener('pointermove', (e) => {
    const i = indexFromEvent(e);
    if (i >= 0) showIndex(i);
  });
  chart.addEventListener('pointerleave', hidePoint);
  // Grafen kan få tastaturfokus, så aflæsningen ikke er forbeholdt en mus.
  chart.addEventListener('focus', () => showIndex(hovered < 0 ? series.length - 1 : hovered));
  chart.addEventListener('blur', hidePoint);
  chart.addEventListener('keydown', (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 };
    if (e.key in steps) {
      showIndex((hovered < 0 ? series.length - 1 : hovered) + steps[e.key]);
      e.preventDefault();
    } else if (e.key === 'Home') { showIndex(0); e.preventDefault(); }
    else if (e.key === 'End') { showIndex(series.length - 1); e.preventDefault(); }
    else if (e.key === 'Escape') hidePoint();
  });

  // ── Hvornår skifter fordelen? ───────────────────────────────────────────
  const NAME = { etf: 'ETF', aktier: 'Aktier', lige: 'Ingen af dem' };

  function renderShifts(assumptions) {
    const report = L.findShifts(assumptions, L.LIMITS.years.max);
    const parts = [];

    if (!report.shifts.length) {
      parts.push('<p class="text-sm font-bold" style="color:var(--text-primary)">'
        + 'Ingen ændring i fordelen inden for ' + report.horizon + ' år.</p>');
      if (!report.anyDecisive) {
        parts.push('<p class="text-sm muted mt-1">De to beløb er ens i alle '
          + report.horizon + ' år — med de her forudsætninger giver beskatningen ingen forskel.</p>');
      } else {
        const winner = report.segments.filter((s) => s.leader !== 'lige').pop();
        parts.push('<p class="text-sm muted mt-1">' + NAME[winner.leader]
          + ' giver mest fra og med år ' + winner.from + ' og hele vejen til år ' + report.horizon + '.</p>');
      }
    } else {
      if (report.shifts.length > 1) {
        parts.push('<p class="text-sm muted">Fordelen skifter ' + report.shifts.length
          + ' gange inden for ' + report.horizon + ' år.</p>');
      }
      parts.push('<ul class="text-sm mt-1 space-y-1" style="color:var(--text-primary)">'
        + report.shifts.map((s) =>
          '<li><strong>' + NAME[s.from] + ' giver mest ved udgangen af år ' + s.lastYear + '. '
          + NAME[s.to] + ' giver mest ved udgangen af år ' + s.firstYear + '.</strong></li>').join('')
        + '</ul>');
    }

    parts.push('<div class="timeline mt-3">' + report.segments.map((s) => {
      const dot = s.leader === 'lige'
        ? '<span class="dot" style="background:var(--text-muted)"></span>'
        : '<span class="dot dot-' + s.leader + '"></span>';
      const span = s.from === s.to ? 'År ' + s.from : 'År ' + s.from + '–' + s.to;
      const who = s.leader === 'lige' ? 'ens' : NAME[s.leader];
      return '<span class="span-chip">' + dot + span + ': ' + who + '</span>';
    }).join('') + '</div>');

    if (report.anyTie) {
      const list = report.tieYears;
      const years = list.length === 1 ? 'år ' + list[0]
        : list.length === report.horizon ? 'alle ' + report.horizon + ' år'
        : 'år ' + list.slice(0, 6).join(', ') + (list.length > 6 ? ' m.fl.' : '');
      parts.push('<p class="text-xs faint mt-3">Identiske resultater forekommer: de to beløb er ens i '
        + years + '. Efter ét år er de altid ens, fordi ETF’ens første lagerskat er nøjagtig den skat, '
        + 'et salg ville udløse på samme tidspunkt.</p>');
    }

    $('#shiftBody').innerHTML = parts.join('');
  }

  // ── Alt sættes på skærmen ───────────────────────────────────────────────
  function render(keepMessages) {
    const { values } = readFields(keepMessages);
    const assumptions = toAssumptions(values);
    const rows = L.project(assumptions).rows;
    const f = rows[rows.length - 1];

    $('#hYears').textContent = String(values.years);
    $('#etfNet').textContent = kr(f.etfValue);
    $('#stockNet').textContent = kr(f.stockNet);
    $('#deposits').textContent = kr(f.deposits);
    $('#etfProfit').textContent = krPlus(f.etfValue - f.deposits);
    $('#stockProfit').textContent = krPlus(f.stockNet - f.deposits);
    $('#etfTax').textContent = kr(f.etfTaxTotal);
    $('#stockTax').textContent = kr(f.stockTax);
    const taxGap = f.etfTaxTotal - f.stockTax;
    $('#taxGap').textContent = zeroish(taxGap) ? '0' : kr(Math.abs(taxGap));
    $('#taxGapWho').textContent = zeroish(taxGap)
      ? 'De to betaler det samme i skat.'
      : (taxGap < 0 ? 'ETF’en' : 'Aktierne') + ' betaler mindst i skat i alt.';

    // Dommen. Forskellen står i kroner, og vinderen står med ord, så tallet
    // aldrig skal aflæses på sit fortegn alene.
    const gap = Math.abs(f.difference);
    if (f.leader === 'lige') {
      $('#verdict').textContent = 'De to ender præcis det samme sted.';
      $('#verdictNote').textContent = 'Med de her forudsætninger gør det ingen forskel, om skatten '
        + 'betales år for år eller først ved salget.';
    } else {
      const winner = f.leader === 'aktier' ? 'Aktierne' : 'ETF’en';
      $('#verdict').textContent = winner + ' giver ' + kr(gap) + ' kr. mere.';
      $('#verdictNote').textContent = f.leader === 'aktier'
        ? 'Efter ' + values.years + ' år er den udskudte skat nået at forrente sig nok til at opveje, '
          + 'at hele gevinsten beskattes på én gang og kun får én års progressionsgrænse.'
        : 'Efter ' + values.years + ' år vejer det tungere, at ETF’en bruger progressionsgrænsen '
          + 'hvert eneste år, end at aktierne får lov at udskyde skatten.';
    }

    drawChart(rows);
    drawDiff(rows);
    hidePoint();

    $('#chartDesc').textContent = 'Efter ' + values.years + ' år står ETF’en på ' + kr(f.etfValue)
      + ' kr. og aktierne på ' + kr(f.stockNet) + ' kr. efter al skat. Hele forløbet står i tabellen '
      + '"Udviklingen år for år" nedenfor.';

    $('#tbody').innerHTML = rows.slice(1).map((r) => {
      const shifted = shiftYears.has(r.year);
      const diff = zeroish(r.difference) ? '0' : krPlus(r.difference);
      return '<tr' + (shifted ? ' class="is-shift"' : '') + '>'
        + '<td>' + r.year + (shifted ? ' <span class="faint" title="Fordelen skifter her">•</span>' : '') + '</td>'
        + '<td>' + kr(r.deposits) + '</td>'
        + '<td>' + kr(r.etfValue) + '</td>'
        + '<td>' + kr(r.stockNet) + '</td>'
        + '<td>' + diff + '</td>'
        + '<td class="faint">' + kr(r.etfTax) + '</td>'
      + '</tr>';
    }).join('');

    renderShifts(assumptions);
    syncBracketPills(values);
    writeUrl(values);
  }

  // ── Felter, skydere og forvalg ──────────────────────────────────────────
  for (const id of IDS) {
    const box = $('#' + id), slider = $('#' + id + 'R');
    box.addEventListener('input', () => {
      if (FIELDS[id].sep) reformat(box);
      const raw = rawValue(id);
      if (slider && raw !== '' && Number.isFinite(Number(raw))) slider.value = raw;
      render();
    });
    // Ved fokustab skrives feltet om til den værdi der faktisk blev regnet med,
    // så det der står i feltet og det der står i resultatet er det samme.
    box.addEventListener('blur', () => {
      const value = readFields(true).values[id];
      setBox(id, value);
      if (slider) slider.value = String(value);
      render(true);
    });
    if (slider) slider.addEventListener('input', () => { setBox(id, Number(slider.value)); render(); });
  }

  function syncBracketPills(values) {
    const bracket = values.bracket;
    let hit = false;
    document.querySelectorAll('[data-bracket]').forEach((b) => {
      const on = Number(b.dataset.bracket) === bracket;
      if (on) hit = true;
      b.setAttribute('aria-pressed', String(on));
    });
    const married = bracket === L.BRACKET_PRESETS.married;
    // Procenterne står i løbende tekst og skal ikke have .num: de tabulære
    // cifre gør det hårde mellemrum foran tegnet bredere end et almindeligt,
    // så der ser ud til at stå to.
    $('#bracketNote').textContent = hit
      ? kr0.format(bracket) + ' kr. om året til ' + pct(values.lowRate)
        + '. Beløbet derover beskattes med ' + pct(values.highRate) + '.'
        + (married ? ' Grænsen gælder ægtefællerne under ét.' : '')
      : 'Egen grænse: ' + kr0.format(bracket) + ' kr. om året.';
    // Ved ægtefælleforvalget er "øvrig aktieindkomst" ægtefællernes samlede.
    $('#otherScope').textContent = married
      ? 'Ægtefællernes samlede øvrige aktieindkomst pr. år.'
      : 'Din egen øvrige aktieindkomst pr. år.';
  }

  document.querySelectorAll('[data-bracket]').forEach((b) => b.addEventListener('click', () => {
    setBox('bracket', Number(b.dataset.bracket));
    render();
  }));

  $('#reset').addEventListener('click', () => {
    // Nulstilling rydder også beskederne: der er ikke længere noget at melde om.
    document.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; el.hidden = true; });
    for (const id of IDS) {
      setBox(id, FIELDS[id].def);
      const slider = $('#' + id + 'R');
      if (slider) slider.value = String(FIELDS[id].def);
    }
    render();
  });

  // ── Adressen bærer beregningen ──────────────────────────────────────────
  // Alt regnes i browseren, så en beregning kan deles ved at dele adressen.
  // Siden står uden for navigationen, så linket er i forvejen den eneste vej ind.
  function writeUrl(values) {
    const q = new URLSearchParams();
    for (const id of IDS) if (values[id] !== FIELDS[id].def) q.set(id, String(values[id]));
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
  }

  function readUrl() {
    const q = new URLSearchParams(location.search);
    for (const id of IDS) {
      const v = Number(q.get(id));
      if (q.has(id) && Number.isFinite(v)) {
        const spec = FIELDS[id];
        const clamped = Math.min(Math.max(v, spec.min), spec.max);
        setBox(id, spec.kind === 'int' ? Math.round(clamped) : clamped);
        const slider = $('#' + id + 'R');
        if (slider) slider.value = String(clamped);
      }
    }
  }

  let resizeTimer = 0;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    // viewBox'en er valgt ud fra elementets bredde, så den skal vælges igen når
    // bredden ændrer sig. Højden alene — en telefon der viser adresselinjen —
    // ændrer ingenting, og skal derfor ikke koste en gentegning.
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { drawChart(series); drawDiff(series); hidePoint(); }, 120);
  });

  readUrl();
  render();
})();

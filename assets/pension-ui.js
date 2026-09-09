/* Brugerfladen til pension.html. Alt regnestykket ligger i assets/pension.js;
   her læses felter, tegnes en graf og skrives tal på skærmen. Adskillelsen er
   ikke pynt: motoren testes af scripts/pension.test.mjs uden en browser, og
   den kan kun testes uden browser, hvis den ikke rører DOM'en. */
(function () {
  'use strict';

  const K = window.KL;
  const P = window.Pension;
  const $ = (s) => document.querySelector(s);

  // ── Felter ──────────────────────────────────────────────────────────────
  // Beløb skrives med tusindtalspunktum, procenter og aldre som almindelige
  // tal. Listen siger hvilken slags hvert felt er, så oplæsning og formatering
  // ikke skal gætte.
  const FIELDS = {
    ageYears:      { kind: 'int' },
    ageMonths:     { kind: 'int' },
    startDate:     { kind: 'date' },
    endAge:        { kind: 'int' },
    depot:         { kind: 'money' },
    basis:         { kind: 'money' },
    monthly:       { kind: 'money' },
    monthlyGrowth: { kind: 'pct' },
    returnSaving:  { kind: 'pct' },
    returnRetired: { kind: 'pct' },
    sameReturn:    { kind: 'bool' },
    costs:         { kind: 'pct' },
    spend:         { kind: 'money' },
    minResidual:   { kind: 'money' },
    inflationOn:   { kind: 'bool' },
    inflation:     { kind: 'pct' },
    indexThreshold:{ kind: 'bool' },
    lowRate:       { kind: 'pct' },
    highRate:      { kind: 'pct' },
    threshold:     { kind: 'money' },
    carriedLoss:   { kind: 'money' },
  };

  const da0 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
  const kr = (n) => (Number.isFinite(n) ? da0.format(Math.round(n)) : '–');

  // "1.234.567" og "1 234 567" og "1234567,5" skal alle blive til et tal.
  function parseNumber(text) {
    const t = String(text == null ? '' : text)
      .replace(/\s| |\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }

  function readFields() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [id, spec] of Object.entries(FIELDS)) {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!el) continue;
      if (spec.kind === 'bool') out[id] = el.checked;
      else if (spec.kind === 'date') out[id] = el.value;
      else if (spec.kind === 'pct') out[id] = parseNumber(el.value) / 100;
      else out[id] = parseNumber(el.value);
    }
    return P.normalize(out);
  }

  // Beløbsfelter sættes pænt op igen, når man forlader dem — men først da, så
  // et punktum ikke bliver sat ind midt i det man er ved at skrive.
  function reformatMoney(el) {
    const n = parseNumber(el.value);
    el.value = da0.format(n);
  }

  // ── Grafen ──────────────────────────────────────────────────────────────
  const G = { W: 920, H: 300, L: 66, R: 16, T: 14, B: 34 };
  G.iw = G.W - G.L - G.R;
  G.ih = G.H - G.T - G.B;

  // Aksens tal skal være runde, ikke bare delelige. 5.847.213 bliver til 6 mio.
  function niceTop(max) {
    if (!(max > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (max <= step * mag) return step * mag;
    }
    return 10 * mag;
  }

  const axisKr = (v) => {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' mio.';
    if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + '.000';
    return String(Math.round(v));
  };

  function drawChart(sim, real) {
    const months = sim.months;
    if (months.length < 2) return '';
    const val = (r) => (real ? r.close / r.deflator : r.close);
    const top = niceTop(Math.max.apply(null, months.map(val)));
    const x = (i) => G.L + (G.iw * i) / (months.length - 1);
    const y = (v) => G.T + G.ih * (1 - v / top);

    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = top * f;
      return '<line x1="' + G.L + '" y1="' + y(v).toFixed(1) + '" x2="' + (G.W - G.R)
        + '" y2="' + y(v).toFixed(1) + '" stroke="var(--gridline)" stroke-width="1"/>'
        + '<text x="' + (G.L - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" '
        + 'font-size="11" fill="var(--text-muted)">' + axisKr(v) + '</text>';
    }).join('');

    // Kurven deles ved pensionsstart: to flader, to streger, én sammenhængende
    // linje. Punktet hvor de mødes, hører til begge, så der ikke opstår et hul.
    const cut = Math.max(0, Math.min(months.length - 1, sim.retireMonth - 1));
    const path = (from, to) => months.slice(from, to + 1)
      .map((r, n) => (n ? 'L' : 'M') + x(from + n).toFixed(1) + ' ' + y(val(r)).toFixed(1)).join(' ');
    const area = (from, to) => path(from, to)
      + ' L' + x(to).toFixed(1) + ' ' + y(0).toFixed(1)
      + ' L' + x(from).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';

    const hasSaving = sim.retireMonth > 0;
    const shapes = (hasSaving
        ? '<path d="' + area(0, cut) + '" fill="var(--fase-op-soft)"/>'
          + '<path d="' + path(0, cut) + '" fill="none" stroke="var(--fase-op)" stroke-width="2"/>'
        : '')
      + '<path d="' + area(cut, months.length - 1) + '" fill="var(--fase-pen-soft)"/>'
      + '<path d="' + path(cut, months.length - 1) + '" fill="none" stroke="var(--fase-pen)" stroke-width="2"/>';

    // Pensionsstart markeret med en lodret linje og en etiket, så skiftet kan
    // ses uden at farverne skal aflæses.
    const cx = x(cut);
    const marker = '<line x1="' + cx.toFixed(1) + '" y1="' + G.T + '" x2="' + cx.toFixed(1)
      + '" y2="' + (G.T + G.ih) + '" stroke="var(--fase-pen)" stroke-width="1.5" stroke-dasharray="4 3"/>'
      + '<circle cx="' + cx.toFixed(1) + '" cy="' + y(val(months[cut])).toFixed(1)
      + '" r="4.5" fill="var(--fase-pen)" stroke="var(--surface-1)" stroke-width="2"/>'
      + '<text x="' + (cx + (cut > months.length * 0.7 ? -8 : 8)).toFixed(1) + '" y="' + (G.T + 13)
      + '" text-anchor="' + (cut > months.length * 0.7 ? 'end' : 'start') + '" font-size="11" '
      + 'font-weight="700" fill="var(--fase-pen)">Pension</text>';

    // Aldre langs bunden, cirka hvert tiende år.
    const first = months[0].ageMonths, last = months[months.length - 1].ageMonths;
    const span = last - first;
    const stepYears = span > 480 ? 10 : span > 240 ? 5 : span > 96 ? 2 : 1;
    const ticks = [];
    for (let i = 0; i < months.length; i++) {
      const age = months[i].ageMonths;
      if (age % (stepYears * 12) === 0) ticks.push({ i: i, age: age / 12 });
    }
    const xLabels = ticks.map((t, n) =>
      '<text x="' + x(t.i).toFixed(1) + '" y="' + (G.H - 10) + '" text-anchor="'
      + (n === 0 ? 'start' : n === ticks.length - 1 ? 'end' : 'middle')
      + '" font-size="11" fill="var(--text-muted)">' + t.age + ' år</text>').join('');

    return '<svg viewBox="0 0 ' + G.W + ' ' + G.H + '" width="100%" height="' + G.H + '" role="img" '
      + 'aria-label="Depotets værdi fra ' + Math.round(first / 12) + ' til ' + Math.round(last / 12)
      + ' år, med pensionsstart markeret" style="display:block">'
      + grid + shapes + marker + xLabels + '</svg>'
      + '<div class="flex flex-wrap gap-4 mt-2 text-xs" style="display:flex;gap:16px">'
      + (hasSaving ? '<span><span class="swatch" style="background:var(--fase-op)"></span> Opsparing</span>' : '')
      + '<span><span class="swatch" style="background:var(--fase-pen)"></span> Pension</span></div>';
  }

  // ── Tabellen ────────────────────────────────────────────────────────────
  function drawTable(sim, real) {
    const rows = P.byYear(sim.months);
    const v = (n, d) => kr(real ? n / d : n);
    const head = '<thead><tr>'
      + ['År', 'Alder', 'Primo', 'Indbetalt', 'Afkast', 'Bruttosalg', 'Skat', 'Forbrug', 'Ultimo']
        .map((h) => '<th>' + h + '</th>').join('')
      + '</tr></thead>';
    const body = '<tbody>' + rows.map((r) => {
      const age = Math.floor(r.ageMonths / 12) + ' år';
      return '<tr' + (r.retired ? ' class="pen"' : '') + '>'
        + '<td>' + r.year + '</td><td>' + age + '</td>'
        + '<td>' + v(r.open, r.deflator) + '</td>'
        + '<td>' + (r.contribution ? v(r.contribution, r.deflator) : '–') + '</td>'
        + '<td>' + v(r.growth, r.deflator) + '</td>'
        + '<td>' + (r.gross ? v(r.gross, r.deflator) : '–') + '</td>'
        + '<td>' + (r.tax ? v(r.tax, r.deflator) : '–') + '</td>'
        + '<td>' + (r.net ? v(r.net, r.deflator) : '–') + '</td>'
        + '<td>' + v(r.close, r.deflator) + '</td></tr>';
    }).join('') + '</tbody>';
    return head + body;
  }

  // ── Resultatet ──────────────────────────────────────────────────────────
  const ageText = (m) => Math.floor(m / 12) + ' år' + (m % 12 ? ' og ' + (m % 12) + ' md.' : '');
  const spanText = (m) => {
    if (m === 0) return 'med det samme';
    const y = Math.floor(m / 12), r = m % 12;
    return 'om ' + (y ? y + (y === 1 ? ' år' : ' år') : '') + (y && r ? ' og ' : '')
      + (r ? r + ' md.' : '');
  };

  const state = { real: false, sim: null, inputs: null };

  function renderResult(it, found) {
    const box = $('#result');
    if (!found.found || !found.sim) {
      box.innerHTML = '<div class="fail">'
        + '<h2 class="text-lg font-extrabold tracking-tight" style="color:var(--delta-down)">'
        + 'Med de valgte forudsætninger kan målet ikke nås inden slutalderen.</h2>'
        + '<p class="text-sm muted mt-2" style="max-width:74ch">Der er ingen måned mellem i dag og '
        + it.endAge + ' år, hvorfra depotet kan betale ' + kr(it.spend)
        + ' kr. om måneden efter skat resten af vejen. Prøv et højere afkast, en større '
        + 'indbetaling, et lavere forbrug eller en senere slutalder.</p></div>';
      $('#chartCard').hidden = true;
      $('#tableCard').hidden = true;
      return;
    }

    const sim = found.sim;
    const m = sim.retireMonth;
    const retireAgeMonths = it.ageYears * 12 + it.ageMonths + m;
    const firstMonth = sim.months[m];
    const pensionMonths = sim.months.length - m;
    const infl = it.inflationOn;
    const deflFinal = Math.pow(1 + it.inflation, P.horizonMonths(it) / 12);

    const card = (k, v, n) => '<div class="cardlet"><div class="cardlet-k">' + K.esc(k) + '</div>'
      + '<div class="cardlet-v">' + v + '</div>'
      + (n ? '<div class="cardlet-n">' + n + '</div>' : '') + '</div>';

    box.innerHTML =
      '<p class="text-xs font-bold uppercase faint" style="letter-spacing:.05em">Tidligste beregnede pensionsalder</p>'
      + '<div class="headline mt-1"><span class="headline-age">' + ageText(retireAgeMonths) + '</span>'
      + '<span class="text-sm muted">' + spanText(m) + '</span></div>'
      + '<div class="cards mt-4">'
      + card('Depot ved pensionsstart', kr(sim.atRetirement) + ' kr.',
          infl ? kr(sim.atRetirement / firstMonth.deflator) + ' kr. i dagens penge' : '')
      + card('Egne penge i alt', kr(sim.contributed) + ' kr.', 'startkapital og indbetalinger')
      + card('Første måneds forbrug', kr(firstMonth.net) + ' kr.',
          infl ? kr(it.spend) + ' kr. i dagens penge' : 'efter skat')
      + card('Første bruttosalg', kr(firstMonth.gross) + ' kr.',
          'heraf ' + kr(firstMonth.tax) + ' kr. i skat')
      + card('Restformue ved ' + it.endAge + ' år', kr(sim.finalNet) + ' kr.',
          (sim.finalTax > 0.5 ? 'efter ' + kr(sim.finalTax) + ' kr. i salgsskat' : 'efter skat')
          + (infl ? ' · ' + kr(sim.finalNet / deflFinal) + ' kr. i dagens penge' : ''))
      + '</div>'
      + '<p class="text-xs muted mt-4" style="max-width:78ch">Fra den måned og frem sælges der hver '
      + 'måned aktier nok til både forbruget og skatten af salget. Resten bliver stående og '
      + 'forrentes videre. Det er den tidligste måned, hvorfra <em>alle</em> resterende måneder '
      + 'kan betales.</p>'
      // Er der kun få måneder tilbage til slutalderen, skal der også kun betales få.
      // Så er tallet rigtigt og alligevel misvisende, hvis man ikke får det at vide.
      + (pensionMonths < 120
          ? '<p class="text-xs mt-2" style="max-width:78ch;color:var(--delta-down)">'
            + 'Bemærk: der er kun ' + (pensionMonths / 12).toLocaleString('da-DK',
                { maximumFractionDigits: 1 }) + ' år fra den alder til de ' + it.endAge
            + ' år, pengene skal holde til. Depotet skal altså kun bære forbruget i den korte '
            + 'periode, og tallet siger derfor mere om, hvor lidt der er tilbage at betale, end '
            + 'om at kunne leve af sin formue. Sæt slutalderen højere, eller forbruget lavere, '
            + 'for et svar der er værd at bruge.</p>'
          : '');

    $('#chartCard').hidden = false;
    $('#tableCard').hidden = false;
    $('#unitToggle').hidden = !infl;
    if (!infl) state.real = false;
    paintViews();
  }

  function paintViews() {
    if (!state.sim) return;
    $('#chartHost').innerHTML = drawChart(state.sim, state.real);
    $('#yearTable').innerHTML = drawTable(state.sim, state.real);
    $('#chartNote').textContent = state.real
      ? 'Beløbene er omregnet til dagens købekraft. Kurven falder derfor hurtigere end den gør i kroner.'
      : (state.inputs && state.inputs.inflationOn
          ? 'Beløbene er i løbende kroner. Skift til dagens kroner for at se købekraften.'
          : 'Beløbene er nominelle. Inflation er slået fra.');
    document.querySelectorAll('#unitToggle button').forEach((b) =>
      b.setAttribute('aria-pressed', String((b.getAttribute('data-unit') === 'real') === state.real)));
  }

  // ── Kør ─────────────────────────────────────────────────────────────────
  let timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 120); }

  function run() {
    const it = readFields();
    state.inputs = it;
    $('#retiredRow').hidden = it.sameReturn;
    $('#inflationBox').hidden = !it.inflationOn;

    // Anskaffelsessummen kan ikke være større end depotet: så ville der være
    // et tab, man ikke har haft.
    const note = $('#basisNote');
    if (it.basis > it.depot) {
      note.textContent = 'Anskaffelsessummen er større end depotet. Så har du et urealiseret tab, '
        + 'som modellen ikke modregner — den beskatter kun gevinster.';
      note.hidden = false;
    } else if (it.basis < it.depot) {
      note.textContent = 'Urealiseret gevinst: ' + kr(it.depot - it.basis) + ' kr.';
      note.hidden = false;
    } else { note.hidden = true; }

    const found = P.findEarliest(it);
    state.sim = found.sim;
    renderResult(it, found);
    $('#reverseCard').hidden = false;
    K.initHints();
  }

  // ── Den omvendte vej ────────────────────────────────────────────────────
  function solveReverse() {
    const it = readFields();
    const target = Math.round(parseNumber(/** @type {HTMLInputElement} */ ($('#targetAge')).value));
    const out = $('#reverseOut');
    const nowMonths = it.ageYears * 12 + it.ageMonths;
    const retireMonth = target * 12 - nowMonths;

    if (retireMonth < 0) {
      out.innerHTML = '<p class="text-sm" style="color:var(--delta-down)">Du er allerede ældre end '
        + target + ' år.</p>';
      return;
    }
    if (target >= it.endAge) {
      out.innerHTML = '<p class="text-sm" style="color:var(--delta-down)">Stopalderen skal ligge før '
        + 'slutalderen på ' + it.endAge + ' år.</p>';
      return;
    }

    const svar = P.solveContribution(it, retireMonth);
    if (!svar.found) {
      out.innerHTML = '<p class="text-sm" style="color:var(--delta-down)">Det kan ikke lade sig gøre '
        + 'med de øvrige forudsætninger, uanset hvor meget der indbetales.</p>';
      return;
    }
    const stiger = it.monthlyGrowth !== 0;
    const sim = /** @type {any} */ (svar.sim);
    const last = sim.months[Math.max(0, retireMonth - 1)];
    out.innerHTML = '<div class="cards">'
      + '<div class="cardlet"><div class="cardlet-k">Nødvendig indbetaling</div>'
      + '<div class="cardlet-v">' + kr(svar.monthly) + ' kr./md.</div>'
      + '<div class="cardlet-n">' + (stiger
          ? 'til at begynde med, og derefter ' + (it.monthlyGrowth * 100).toLocaleString('da-DK',
              { maximumFractionDigits: 2 }) + ' % mere om året'
          : 'det samme beløb hver måned') + '</div></div>'
      + '<div class="cardlet"><div class="cardlet-k">Mod det du sparer op nu</div>'
      + '<div class="cardlet-v">' + (svar.monthly > it.monthly ? '+' : '')
      + kr(svar.monthly - it.monthly) + ' kr./md.</div>'
      + '<div class="cardlet-n">i forhold til ' + kr(it.monthly) + ' kr.</div></div>'
      + '<div class="cardlet"><div class="cardlet-k">Depot som ' + target + '-årig</div>'
      + '<div class="cardlet-v">' + kr(last ? last.close : it.depot) + ' kr.</div>'
      + '<div class="cardlet-n">ved pensionsstart</div></div>'
      + '</div>';
  }

  // ── Bindinger ───────────────────────────────────────────────────────────
  function wire() {
    for (const [id, spec] of Object.entries(FIELDS)) {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!el) continue;
      el.addEventListener('input', schedule);
      el.addEventListener('change', schedule);
      if (spec.kind === 'money') el.addEventListener('blur', () => { reformatMoney(el); schedule(); });
    }
    document.querySelectorAll('#unitToggle button').forEach((b) => b.addEventListener('click', () => {
      state.real = b.getAttribute('data-unit') === 'real';
      paintViews();
    }));
    $('#solveBtn').addEventListener('click', solveReverse);
    $('#targetAge').addEventListener('keydown', (e) => {
      if (/** @type {KeyboardEvent} */ (e).key === 'Enter') { e.preventDefault(); solveReverse(); }
    });
    $('#reset').addEventListener('click', () => { fill(P.DEFAULTS); run(); $('#reverseOut').innerHTML = ''; });
  }

  /** Skriv et sæt værdier ud i felterne. @param {any} v */
  function fill(v) {
    for (const [id, spec] of Object.entries(FIELDS)) {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      if (!el || !(id in v)) continue;
      if (spec.kind === 'bool') el.checked = !!v[id];
      else if (spec.kind === 'date') el.value = v[id] || todayIso();
      else if (spec.kind === 'pct') el.value = String(Number((v[id] * 100).toFixed(4)));
      else if (spec.kind === 'money') el.value = da0.format(v[id]);
      else el.value = String(v[id]);
    }
  }

  const todayIso = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
  };

  K.renderNav('');
  fill(Object.assign({}, P.DEFAULTS, { startDate: todayIso() }));
  wire();
  run();
})();

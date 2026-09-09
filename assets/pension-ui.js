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

  // Standarden matcher feltet i pension.html. Den står her, så nulstilningen
  // og markuppet ikke kan glide fra hinanden i tavshed.
  const DEFAULT_RETIRE_AGE = 50;

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
  // Spørgsmålet siden svarer på er: hvad skal jeg lægge til side hver måned,
  // hvis jeg vil stoppe som X-årig og har det her i dag? Den indbetaling
  // brugeren allerede laver, indgår kun til sammenligning og til det ene
  // sekundære svar nederst.
  const ageText = (m) => Math.floor(m / 12) + ' år' + (m % 12 ? ' og ' + (m % 12) + ' md.' : '');
  // "som 50-årig" på hele år, "som 50 år og 3 md." når der er måneder med.
  const asAged = (m) => (m % 12 ? Math.floor(m / 12) + ' år og ' + (m % 12) + ' md.'
                                : Math.floor(m / 12) + '-årig');

  const state = { real: false, sim: null, inputs: null };

  const card = (k, v, n) => '<div class="cardlet"><div class="cardlet-k">' + K.esc(k) + '</div>'
    + '<div class="cardlet-v">' + v + '</div>'
    + (n ? '<div class="cardlet-n">' + n + '</div>' : '') + '</div>';

  const fejl = (h, p) => '<div class="fail">'
    + '<h2 class="text-lg font-extrabold tracking-tight" style="color:var(--delta-down)">'
    + K.esc(h) + '</h2><p class="text-sm muted mt-2" style="max-width:74ch">' + p + '</p></div>';

  function skjulAlt() {
    $('#chartCard').hidden = true;
    $('#tableCard').hidden = true;
    $('#sensCard').hidden = true;
    $('#earliestCard').hidden = true;
  }

  /**
   * Hovedsvaret: den nødvendige månedlige indbetaling.
   * @param {any} it
   * @param {number} retireMonth
   */
  function renderMain(it, retireMonth) {
    const box = $('#result');
    const svar = P.solveContribution(it, retireMonth);

    if (!svar.found || !svar.sim) {
      box.innerHTML = fejl('Det kan ikke lade sig gøre — uanset hvor meget du lægger til side.',
        'Selv med en meget stor månedlig indbetaling kan depotet ikke bære ' + kr(it.spend)
        + ' kr. om måneden efter skat fra du er ' + Math.round((it.ageYears * 12 + it.ageMonths
          + retireMonth) / 12) + ' til du er ' + it.endAge + ' år. '
        + 'Prøv et højere afkast, et lavere forbrug, en senere stopalder eller en lavere slutalder.');
      skjulAlt();
      return null;
    }

    const sim = svar.sim;
    state.sim = sim;
    const retireAgeMonths = it.ageYears * 12 + it.ageMonths + retireMonth;
    const firstMonth = sim.months[retireMonth];
    const pensionMonths = sim.months.length - retireMonth;
    const infl = it.inflationOn;
    const deflFinal = Math.pow(1 + it.inflation, P.horizonMonths(it) / 12);
    const diff = svar.monthly - it.monthly;
    const stiger = it.monthlyGrowth !== 0;

    box.innerHTML =
      '<p class="text-xs font-bold uppercase faint" style="letter-spacing:.05em">'
      + 'Det skal du lægge til side hver måned</p>'
      + '<div class="headline mt-1"><span class="headline-age">' + kr(svar.monthly) + ' kr.</span>'
      + '<span class="text-sm muted">for at stoppe som ' + asAged(retireAgeMonths)
      + ' med ' + kr(it.spend) + ' kr. om måneden' + (infl ? ' i dagens penge' : '') + '</span></div>'
      + (stiger
          ? '<p class="text-xs muted mt-2">Det er startbeløbet. Du har valgt, at indbetalingen '
            + 'stiger ' + (it.monthlyGrowth * 100).toLocaleString('da-DK', { maximumFractionDigits: 2 })
            + ' % på hver årsdag, og det er regnet med.</p>'
          : '')
      + (it.minResidual > 0 ? ''
          : '<p class="text-xs muted mt-2" style="max-width:78ch">Beløbet er det mindste, der '
            + 'lige akkurat rækker: derfor er depotet stort set brugt op som ' + it.endAge
            + '-årig. Vil du have noget tilbage, så sæt et beløb i '
            + '<strong style="color:var(--text-primary)">«Skal være tilbage til sidst»</strong>.</p>')
      + '<div class="cards mt-4">'
      + card(diff > 0.5 ? 'Så meget mangler du' : diff < -0.5 ? 'Så meget har du til overs' : 'Du er lige på',
          kr(Math.abs(diff)) + ' kr.',
          'du lægger ' + kr(it.monthly) + ' kr. til side i dag')
      + card('Depot når du stopper', kr(sim.atRetirement) + ' kr.',
          infl && firstMonth ? kr(sim.atRetirement / firstMonth.deflator) + ' kr. i dagens penge' : '')
      + card('Egne penge i alt', kr(sim.contributed) + ' kr.', 'startkapital og indbetalinger')
      + (firstMonth
          ? card('Første måneds salg', kr(firstMonth.gross) + ' kr.',
              'heraf ' + kr(firstMonth.tax) + ' kr. i skat, så ' + kr(firstMonth.net) + ' kr. er dine')
          : '')
      + card('Tilbage som ' + it.endAge + '-årig', kr(sim.finalNet) + ' kr.',
          (sim.finalTax > 0.5 ? 'efter ' + kr(sim.finalTax) + ' kr. i salgsskat' : 'efter skat')
          + (infl ? ' · ' + kr(sim.finalNet / deflFinal) + ' kr. i dagens penge' : ''))
      + '</div>'
      + (pensionMonths < 120
          ? '<p class="text-xs mt-3" style="max-width:78ch;color:var(--delta-down)">'
            + 'Bemærk: der er kun ' + (pensionMonths / 12).toLocaleString('da-DK',
                { maximumFractionDigits: 1 }) + ' år fra du stopper til de ' + it.endAge
            + ' år, pengene skal holde til. Depotet skal altså kun bære forbruget i den korte '
            + 'periode, og beløbet er derfor lavere, end det ville være med en realistisk levetid. '
            + 'Sæt slutalderen højere.</p>'
          : '');

    $('#chartCard').hidden = false;
    $('#tableCard').hidden = false;
    $('#unitToggle').hidden = !infl;
    if (!infl) state.real = false;
    paintViews();
    return svar;
  }

  /**
   * Hvad afkastet gør ved svaret. Det er den forudsætning ingen kender, og
   * den svaret er mest følsomt over for, så den får sin egen tabel.
   * @param {any} it
   * @param {number} retireMonth
   * @param {number} valgt Den nødvendige indbetaling ved brugerens eget afkast.
   */
  function renderSensitivity(it, retireMonth, valgt) {
    const egen = Math.round(it.returnSaving * 1000) / 10;      // fx 7 for 7 %
    const kandidater = [3, 4, 5, 6, 7, 8, 9, 10];
    if (kandidater.indexOf(egen) === -1) kandidater.push(egen);
    kandidater.sort((a, b) => a - b);

    const rækker = kandidater.map((pct) => {
      const r = pct / 100;
      // Kun opsparingsafkastet varieres, medmindre brugeren har bedt om samme
      // afkast i begge perioder — så følger pensionsafkastet med, ligesom
      // afkrydsningsfeltet siger.
      const v = P.normalize(Object.assign({}, it, {
        returnSaving: r,
        returnRetired: it.sameReturn ? r : it.returnRetired,
      }));
      const s = P.solveContribution(v, retireMonth);
      return { pct: pct, monthly: s.found ? s.monthly : null, egen: pct === egen };
    });

    const head = '<thead><tr><th>Årligt afkast</th><th>Nødvendig indbetaling</th>'
      + '<th>Mod dit afkast</th></tr></thead>';
    const body = '<tbody>' + rækker.map((r) => {
      const d = (r.monthly != null && valgt != null) ? r.monthly - valgt : null;
      return '<tr' + (r.egen ? ' style="font-weight:800;background:var(--surface-2)"' : '') + '>'
        + '<td>' + r.pct.toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' %'
        + (r.egen ? ' <span class="faint" style="font-weight:400">← dit valg</span>' : '') + '</td>'
        + '<td>' + (r.monthly == null ? 'kan ikke nås' : kr(r.monthly) + ' kr./md.') + '</td>'
        + '<td>' + (d == null || r.egen ? '–' : (d > 0 ? '+' : '') + kr(d) + ' kr.') + '</td></tr>';
    }).join('') + '</tbody>';

    $('#sensTable').innerHTML = head + body;
    $('#sensCard').hidden = false;
  }

  /**
   * Det sekundære svar: bliver du ved med præcis det, du lægger til side i
   * dag, hvornår kan du så tidligst stoppe?
   * @param {any} it
   * @param {number} retireMonth
   */
  function renderEarliest(it, retireMonth) {
    const out = $('#earliestOut');
    const found = P.findEarliest(it);
    if (!found.found || !found.sim) {
      out.innerHTML = '<p class="text-sm muted">Med ' + kr(it.monthly) + ' kr. om måneden rækker '
        + 'depotet ikke til ' + kr(it.spend) + ' kr. i forbrug fra nogen alder inden de '
        + it.endAge + ' år.</p>';
      $('#earliestCard').hidden = false;
      return;
    }
    const m = found.sim.retireMonth;
    const alder = it.ageYears * 12 + it.ageMonths + m;
    const forskel = alder - (it.ageYears * 12 + it.ageMonths + retireMonth);
    out.innerHTML = '<div class="cards">'
      + card('Tidligste beregnede stopalder', ageText(alder),
          'med ' + kr(it.monthly) + ' kr. om måneden')
      + card('I forhold til dit mål',
          forskel === 0 ? 'præcis på' : (forskel > 0 ? forskel + ' md. senere' : (-forskel) + ' md. tidligere'),
          'du sigter mod ' + Math.floor((it.ageYears * 12 + it.ageMonths + retireMonth) / 12) + ' år')
      + card('Depot når du stopper', kr(found.sim.atRetirement) + ' kr.', 'ved den alder')
      + '</div>';
    $('#earliestCard').hidden = false;
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
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 160); }

  function run() {
    const it = readFields();
    state.inputs = it;
    $('#retiredRow').hidden = it.sameReturn;
    $('#inflationBox').hidden = !it.inflationOn;

    // Anskaffelsessummen sammenholdt med depotet siger, hvor stor en
    // urealiseret gevinst der ligger og venter på at blive beskattet.
    const note = $('#basisNote');
    if (it.basis > it.depot) {
      note.textContent = 'Anskaffelsessummen er større end depotet. Så har du et urealiseret tab, '
        + 'som modellen ikke modregner — den beskatter kun gevinster.';
      note.hidden = false;
    } else if (it.basis < it.depot) {
      note.textContent = 'Urealiseret gevinst: ' + kr(it.depot - it.basis) + ' kr.';
      note.hidden = false;
    } else { note.hidden = true; }

    const nowMonths = it.ageYears * 12 + it.ageMonths;
    const retireEl = /** @type {HTMLInputElement} */ ($('#retireAge'));
    const retireAge = Math.round(parseNumber(retireEl.value));
    const retireMonth = retireAge * 12 - nowMonths;

    if (retireMonth < 0) {
      $('#result').innerHTML = fejl('Du er allerede ældre end ' + retireAge + ' år.',
        'Sæt stopalderen til noget, der ligger efter din alder i dag.');
      skjulAlt();
      return;
    }
    if (retireAge >= it.endAge) {
      $('#result').innerHTML = fejl('Stopalderen skal ligge før slutalderen.',
        'Du vil stoppe som ' + retireAge + '-årig, men pengene skal kun holde til ' + it.endAge
        + ' år. Sæt slutalderen højere — den er den alder, du regner med at leve til.');
      skjulAlt();
      return;
    }

    const svar = renderMain(it, retireMonth);
    if (svar) {
      renderSensitivity(it, retireMonth, svar.monthly);
      renderEarliest(it, retireMonth);
    }
    K.initHints();
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
    // Stopalderen står ikke i FIELDS: den er ikke en forudsætning modellen
    // regner med, men det spørgsmål den bliver stillet. Den bindes for sig.
    const retire = $('#retireAge');
    retire.addEventListener('input', schedule);
    retire.addEventListener('change', schedule);

    $('#reset').addEventListener('click', () => {
      fill(P.DEFAULTS);
      /** @type {HTMLInputElement} */ ($('#retireAge')).value = String(DEFAULT_RETIRE_AGE);
      run();
    });
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

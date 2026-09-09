/* Hvornår kan man holde op med at arbejde? Hele regnestykket, uden en eneste
   reference til DOM'en. Modulet indlæses både af pension.html og af
   scripts/pension.test.mjs, så det der vises på skærmen er nøjagtig det der
   bliver testet.

   Typerne står som JSDoc frem for i en .ts-fil, fordi sitet er statisk og
   kører uden byggetrin: browseren henter denne fil som den er.
   `npx -p typescript tsc --noEmit` læser dem alligevel gennem tsconfig.json's
   checkJs, så de holder på præcis de typer en .ts-fil ville give.

   Filen er en almindelig global som assets/kursliste.js, ikke et ES-modul, så
   siden også virker åbnet direkte fra disken — et modul ville browseren afvise
   over file://.

   ── Hvad modellen er ──────────────────────────────────────────────────────
   Et helt almindeligt privat aktiedepot, simuleret måned for måned. Under
   opsparingen indbetales der og depotet forrentes. Under pensionen sælges der
   aktier nok til at dække både forbruget og skatten af det, resten bliver
   stående og forrentes videre.

   Der er ingen 4 %-regel her. Den er en tommelfingerregel om historiske
   amerikanske porteføljer, ikke en skattemodel, og den kan ikke svare på det
   spørgsmål siden stiller: hvor meget skal der sælges *brutto*, når salget
   selv udløser en skat der skal betales af salget.

   ── Hvad modellen ikke er ────────────────────────────────────────────────
   Aktier uden udbytte, realisationsbeskattet, uden salg under opsparingen.
   Lagerbeskattede ETF'er, aktiesparekonto og pensionsdepoter følger andre
   regler og kan ikke regnes her.

   Depotet behandles som én samlet beholdning med forholdsmæssige salg. I
   virkeligheden opgøres gevinst pr. aktie, og hvilke aktier man vælger at
   sælge kan ændre skatten betydeligt. Forenklingen er nævnt på siden. */
(function (global) {
  'use strict';

  /**
   * @typedef {Object} Inputs
   * @property {number} ageYears        Nuværende alder, hele år.
   * @property {number} ageMonths       Måneder oven i alderen, 0–11.
   * @property {string} startDate       Beregningens startdato, ISO (ÅÅÅÅ-MM-DD).
   * @property {number} endAge          Alderen pengene skal holde til.
   * @property {number} depot           Nuværende depotværdi i kroner.
   * @property {number} basis           Skattemæssig anskaffelsessum for depotet.
   * @property {number} monthly         Månedlig indbetaling af beskattede penge.
   * @property {number} monthlyGrowth   Årlig stigning i indbetalingen, decimal.
   * @property {number} returnSaving    Nominelt årligt afkast under opsparing, decimal.
   * @property {number} returnRetired   Nominelt årligt afkast under pension, decimal.
   * @property {boolean} sameReturn     Brug opsparingsafkastet i begge perioder.
   * @property {number} costs           Årlige investeringsomkostninger, decimal.
   * @property {number} spend           Ønsket månedligt forbrug efter skat.
   * @property {number} minResidual     Ønsket minimumsrestformue efter skat ved slutalderen.
   * @property {boolean} inflationOn    Medregn inflation.
   * @property {number} inflation       Årlig inflation, decimal.
   * @property {boolean} indexThreshold Lad skattegrænsen følge inflationen.
   * @property {number} lowRate         Lav aktieskattesats, decimal.
   * @property {number} highRate        Høj aktieskattesats, decimal.
   * @property {number} threshold       Årlig progressionsgrænse i kroner.
   * @property {number} carriedLoss     Fremført aktietab til modregning, kroner.
   */

  /**
   * @typedef {Object} MonthRow
   * @property {number} index        Månedsnummer fra beregningens start, 0-baseret.
   * @property {number} year         Kalenderår.
   * @property {number} month        Kalendermåned, 0–11.
   * @property {number} ageMonths    Alder i måneder ved månedens slutning.
   * @property {boolean} retired     Er måneden en pensionsmåned?
   * @property {number} open         Depotet ved månedens begyndelse.
   * @property {number} growth       Afkast efter omkostninger, før skat.
   * @property {number} contribution Indbetaling i måneden.
   * @property {number} gross        Bruttosalg i måneden.
   * @property {number} tax          Skattereservation af månedens salg.
   * @property {number} net          Nettoforbrug udbetalt i måneden.
   * @property {number} close        Depotet ved månedens slutning.
   * @property {number} basis        Resterende anskaffelsessum ved månedens slutning.
   * @property {number} deflator     Divider et nominelt beløb med denne for dagens kroner.
   */

  /**
   * @typedef {Object} Simulation
   * @property {boolean} ok            Kunne alle udbetalinger og restformuekravet dækkes?
   * @property {string} reason         Tom hvis ok, ellers hvorfor scenariet slog fejl.
   * @property {number} failedAtMonth  Månedsnummer hvor pengene slap op, ellers -1.
   * @property {MonthRow[]} months     Én række pr. simuleret måned.
   * @property {number} retireMonth    Måneder fra start til pensionsstart.
   * @property {number} atRetirement   Depotværdi ved pensionsstart.
   * @property {number} contributed    Egne penge i alt, inklusive startkapital.
   * @property {number} finalValue     Depotværdi ved slutalderen.
   * @property {number} finalNet       Restformue efter skat ved fuld realisation.
   * @property {number} finalTax       Skatten af at realisere resten på én gang.
   * @property {number} residualTarget Restformuekravet i nominelle kroner ved slutalderen.
   */

  const DEFAULTS = /** @type {Inputs} */ ({
    ageYears: 27,
    ageMonths: 6,
    startDate: '',            // tom betyder "den 1. i indeværende måned"
    endAge: 80,
    depot: 300000,
    basis: 300000,
    monthly: 10000,
    monthlyGrowth: 0,
    returnSaving: 0.07,
    returnRetired: 0.07,
    sameReturn: true,
    costs: 0,
    spend: 25000,
    minResidual: 0,
    inflationOn: false,
    inflation: 0.02,
    indexThreshold: false,
    lowRate: 0.27,
    highRate: 0.42,
    threshold: 79400,
    carriedLoss: 0,
  });

  // 2026-satserne for en ugift uden anden aktieindkomst. Kontrolleret mod
  // Skattestyrelsens egne tal: 27 % under grænsen, 42 % over, grænsen 79.400 kr.
  // Grænsen er personlig. Er man gift, kan ægtefællens uudnyttede grænse bruges,
  // men det er en beslutning brugeren selv må tage — feltet fordobles ikke af
  // sig selv, fordi det kun er rigtigt når ægtefællen ikke selv har aktieindkomst.
  const TAX_PRESET_2026 = { lowRate: 0.27, highRate: 0.42, threshold: 79400 };

  const LIMITS = {
    ageYears: { min: 0, max: 100 },
    endAge: { min: 1, max: 120 },
    rate: { min: -0.5, max: 0.5 },
    costs: { min: 0, max: 0.1 },
    inflation: { min: -0.1, max: 0.2 },
    taxRate: { min: 0, max: 1 },
  };

  /** @param {number} n @param {number} lo @param {number} hi @returns {number} */
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  /** @param {unknown} v @param {number} fallback @returns {number} */
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

  /**
   * Nominelt årligt afkast og årlige omkostninger til én månedlig vækstfaktor.
   * Omkostningerne trækkes inde i det årlige tal og ikke som et separat
   * månedligt fradrag, så 7 % afkast og 0,5 % omkostning giver præcis det
   * samme som 6,465 % afkast uden omkostning — hvilket er hvad de er.
   * @param {number} annualReturn
   * @param {number} annualCosts
   * @returns {number}
   */
  function monthlyFactor(annualReturn, annualCosts) {
    const yearly = (1 + annualReturn) * (1 - annualCosts);
    // En negativ årsfaktor har ingen tolvte rod. Den kan kun opstå hvis nogen
    // taster afkast under −100 %, og så er nul det ærlige svar.
    if (yearly <= 0) return 0;
    return Math.pow(yearly, 1 / 12);
  }

  /**
   * Skat af årets positive nettogevinst efter al tabsmodregning.
   * Et tab giver nul, ikke en negativ skat: modellen udbetaler ikke penge.
   * @param {number} gain
   * @param {number} threshold
   * @param {number} lowRate
   * @param {number} highRate
   * @returns {number}
   */
  function shareTax(gain, threshold, lowRate, highRate) {
    if (!(gain > 0)) return 0;
    const under = Math.min(gain, Math.max(0, threshold));
    const over = Math.max(gain - Math.max(0, threshold), 0);
    return lowRate * under + highRate * over;
  }

  /**
   * Læs brugerens felter, ret det urimelige, og udfyld det tomme.
   * @param {Partial<Inputs>} raw
   * @returns {Inputs}
   */
  function normalize(raw) {
    const it = /** @type {Inputs} */ (Object.assign({}, DEFAULTS, raw || {}));
    it.ageYears = clamp(Math.floor(num(it.ageYears, DEFAULTS.ageYears)), LIMITS.ageYears.min, LIMITS.ageYears.max);
    it.ageMonths = clamp(Math.floor(num(it.ageMonths, 0)), 0, 11);
    it.endAge = clamp(Math.floor(num(it.endAge, DEFAULTS.endAge)), LIMITS.endAge.min, LIMITS.endAge.max);
    it.depot = Math.max(0, num(it.depot, 0));
    it.basis = Math.max(0, num(it.basis, 0));
    it.monthly = Math.max(0, num(it.monthly, 0));
    it.monthlyGrowth = clamp(num(it.monthlyGrowth, 0), -1, 1);
    it.returnSaving = clamp(num(it.returnSaving, 0), LIMITS.rate.min, LIMITS.rate.max);
    it.returnRetired = it.sameReturn ? it.returnSaving
      : clamp(num(it.returnRetired, 0), LIMITS.rate.min, LIMITS.rate.max);
    it.costs = clamp(num(it.costs, 0), LIMITS.costs.min, LIMITS.costs.max);
    it.spend = Math.max(0, num(it.spend, 0));
    it.minResidual = Math.max(0, num(it.minResidual, 0));
    it.inflation = it.inflationOn ? clamp(num(it.inflation, 0), LIMITS.inflation.min, LIMITS.inflation.max) : 0;
    it.lowRate = clamp(num(it.lowRate, 0), LIMITS.taxRate.min, LIMITS.taxRate.max);
    it.highRate = clamp(num(it.highRate, 0), LIMITS.taxRate.min, LIMITS.taxRate.max);
    it.threshold = Math.max(0, num(it.threshold, 0));
    it.carriedLoss = Math.max(0, num(it.carriedLoss, 0));
    if (!it.startDate) {
      const now = new Date();
      it.startDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    }
    return it;
  }

  /**
   * Beregningens startdato som år og måned. En ugyldig dato falder tilbage på
   * i dag frem for at forplante en NaN gennem hele simuleringen.
   * @param {string} iso
   * @returns {{ year: number, month: number }}
   */
  function startOf(iso) {
    const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    if (!m) { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; }
    return { year: Number(m[1]), month: Number(m[2]) - 1 };
  }

  /** Antal måneder fra nu til slutalderen. @param {Inputs} it @returns {number} */
  const horizonMonths = (it) => it.endAge * 12 - (it.ageYears * 12 + it.ageMonths);

  /**
   * Hvad skal der sælges brutto, for at der bliver `want` kroner tilbage efter
   * skatten af netop dette salg?
   *
   * Sammenhængen er stykkevis lineær og strengt voksende — hældningen er
   * 1 − sats × gevinstandel, altså mindst 0,58 — så bisektion konvergerer
   * altid. En lukket løsning findes, men den skal deles op i tre tilfælde
   * efter hvor grænsen ligger, og den fejl der kan gemme sig i det tredje
   * tilfælde er dyrere end de tres iterationer her.
   *
   * Funktionen rører ikke tilstanden. Den svarer kun på spørgsmålet.
   *
   * @param {number} want          Ønsket beløb i hånden.
   * @param {number} value         Depotværdi før salget.
   * @param {number} basis         Anskaffelsessum før salget.
   * @param {number} yearRealised  Årets realiserede gevinst indtil nu, kan være negativ.
   * @param {number} lossPool      Fremført tab til rådighed ved årets begyndelse.
   * @param {number} threshold     Årets progressionsgrænse.
   * @param {number} lowRate
   * @param {number} highRate
   * @returns {{ ok: boolean, gross: number, tax: number, gain: number, soldBasis: number }}
   */
  function solveGross(want, value, basis, yearRealised, lossPool, threshold, lowRate, highRate) {
    const miss = { ok: false, gross: 0, tax: 0, gain: 0, soldBasis: 0 };
    if (!(want > 0)) return { ok: true, gross: 0, tax: 0, gain: 0, soldBasis: 0 };
    if (!(value > 0)) return miss;

    const share = Math.min(1, Math.max(0, basis / value));   // anskaffelsesandel
    const taxableNow = Math.max(0, yearRealised - lossPool);
    const taxBefore = shareTax(taxableNow, threshold, lowRate, highRate);

    // Månedens skattereservation er stigningen i årets samlede beregnede skat,
    // ikke en skat af måneden isoleret. Det er forskellen på at bruge
    // progressionsgrænsen én gang om året og at bruge den tolv gange.
    /** @param {number} gross @returns {number} */
    const reservationFor = (gross) => {
      const gain = gross * (1 - share);
      const taxable = Math.max(0, yearRealised + gain - lossPool);
      return shareTax(taxable, threshold, lowRate, highRate) - taxBefore;
    };
    /** @param {number} gross @returns {number} */
    const netOf = (gross) => gross - reservationFor(gross);

    // En brøkdel af en øre er ikke en manglende krone. Uden sløret her ville
    // et depot på præcis tolv måneders forbrug blive afvist i den tolvte,
    // fordi de elleve foregående salg tilsammen lå en milliardtedel for højt.
    const SLACK = 1e-6;
    if (netOf(value) < want - SLACK) return miss;             // hele depotet rækker ikke

    let lo = 0, hi = value;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (netOf(mid) < want) lo = mid; else hi = mid;
      if (hi - lo < 1e-9) break;
    }

    // Bisektionen indeslutter, men returnerer sin øvre grænse og rammer derfor
    // altid en anelse for højt. Hældningen er kendt — én minus den marginale
    // skattesats gange gevinstandelen — så et par Newton-skridt fører det
    // sidste stykke ned på maskinens præcision. Det er ikke pedanteri: fejlen
    // er ensrettet, den lægger sig sammen måned for måned, og den kan skubbe
    // den beregnede pensionsalder en måned.
    let gross = hi;
    for (let i = 0; i < 4; i++) {
      const gain = gross * (1 - share);
      const taxable = yearRealised + gain - lossPool;
      const marginal = taxable <= 0 ? 0
        : (taxable >= threshold ? highRate : lowRate) * (1 - share);
      const slope = 1 - marginal;
      if (!(slope > 0)) break;
      const next = gross - (netOf(gross) - want) / slope;
      if (!Number.isFinite(next)) break;
      gross = Math.min(value, Math.max(0, next));
    }
    // Salget kan aldrig overstige depotet, uanset hvad afrundingen mener.
    gross = Math.min(value, Math.max(0, gross));

    const soldBasis = gross * share;
    return { ok: true, gross: gross, tax: reservationFor(gross), gain: gross - soldBasis, soldBasis: soldBasis };
  }

  /**
   * Kør hele forløbet fra i dag til slutalderen med pensionsstart efter
   * `retireMonth` måneder.
   *
   * Rækkefølgen i hver måned er fast: forrent først, indbetal eller hæv
   * bagefter. Indbetalinger og hævninger sker ved månedens slutning, og en
   * måned er enten en opsparingsmåned eller en pensionsmåned — aldrig begge.
   *
   * @param {Inputs} it
   * @param {number} retireMonth
   * @param {{ monthly?: number }} [override] Bruges af solveContribution.
   * @returns {Simulation}
   */
  function simulate(it, retireMonth, override) {
    const monthlyIn = override && typeof override.monthly === 'number' ? override.monthly : it.monthly;
    const total = horizonMonths(it);
    const start = startOf(it.startDate);
    const growSaving = monthlyFactor(it.returnSaving, it.costs);
    const growRetired = monthlyFactor(it.returnRetired, it.costs);
    const infl = it.inflationOn ? it.inflation : 0;

    let value = it.depot;
    let basis = it.basis;
    let contributed = it.depot;        // egne penge: startkapitalen tæller med
    let atRetirement = retireMonth === 0 ? it.depot : 0;

    // Skattens år. lossPool er hvad der kan modregnes i indeværende års
    // gevinst; den gøres først op ved årsskiftet.
    let lossPool = it.carriedLoss;
    let yearRealised = 0;
    let calYear = start.year;

    /** @type {MonthRow[]} */
    const months = [];
    let failedAt = -1;
    let reason = '';

    for (let m = 0; m < total; m++) {
      const absMonth = start.month + m;
      const year = start.year + Math.floor(absMonth / 12);
      const month = ((absMonth % 12) + 12) % 12;

      // Årsskifte: årets gevinsttæller nulstilles, men et resterende fremført
      // tab følger med over i det nye år. Et tab må ikke blive til kontanter.
      if (year !== calYear) {
        if (yearRealised > 0) lossPool = Math.max(0, lossPool - yearRealised);
        else lossPool = lossPool - yearRealised;      // yearRealised < 0 lægger til
        yearRealised = 0;
        calYear = year;
      }

      const retired = m >= retireMonth;
      const open = value;

      // 1. Afkast og omkostninger.
      value *= retired ? growRetired : growSaving;
      const growth = value - open;

      let contribution = 0, gross = 0, tax = 0, net = 0;

      if (!retired) {
        // 2. Indbetalingen forøger både depotet og anskaffelsessummen: det er
        //    beskattede penge, der ikke skal beskattes igen ved salg.
        contribution = monthlyIn * Math.pow(1 + it.monthlyGrowth, Math.floor(m / 12));
        value += contribution;
        basis += contribution;
        contributed += contribution;
        if (m + 1 === retireMonth) atRetirement = value;
      } else {
        // 3. Hævning. Forbruget er indtastet i dagens købekraft og reguleres
        //    fra beregningens start — også i årene før pension, hvor det ikke
        //    hæves, men hvor prisen alligevel er steget.
        const elapsed = m + 1;                        // måneder siden start ved månedens slutning
        const deflate = Math.pow(1 + infl, elapsed / 12);
        const want = it.spend * deflate;
        const thr = it.indexThreshold
          ? it.threshold * Math.pow(1 + infl, year - start.year)
          : it.threshold;

        const sale = solveGross(want, value, basis, yearRealised, lossPool, thr, it.lowRate, it.highRate);
        if (!sale.ok) {
          failedAt = m;
          reason = 'Depotet kan ikke dække måneden ' + (month + 1) + '/' + year + '.';
          break;
        }
        gross = sale.gross; tax = sale.tax; net = want;
        value -= gross;
        basis -= sale.soldBasis;
        yearRealised += sale.gain;
        if (basis < 0) basis = 0;
        if (value < 0) value = 0;
      }

      months.push({
        index: m, year: year, month: month,
        ageMonths: it.ageYears * 12 + it.ageMonths + m + 1,
        retired: retired,
        open: open, growth: growth, contribution: contribution,
        gross: gross, tax: tax, net: net,
        close: value, basis: basis,
        deflator: Math.pow(1 + infl, (m + 1) / 12),
      });
    }

    // Restformuen gøres op efter den skat det ville koste at realisere resten.
    // Kun den *ekstra* skat tæller: årets allerede realiserede gevinst er
    // reserveret undervejs, og progressionsgrænsen er delvist brugt.
    const finalYear = start.year + Math.floor((start.month + Math.max(0, total - 1)) / 12);
    const finalThr = it.indexThreshold
      ? it.threshold * Math.pow(1 + infl, finalYear - start.year)
      : it.threshold;
    const restGain = Math.max(0, value - basis);
    const taxNow = shareTax(Math.max(0, yearRealised - lossPool), finalThr, it.lowRate, it.highRate);
    const taxAll = shareTax(Math.max(0, yearRealised + restGain - lossPool), finalThr, it.lowRate, it.highRate);
    const finalTax = Math.max(0, taxAll - taxNow);
    const finalNet = value - finalTax;

    const residualTarget = it.minResidual * Math.pow(1 + infl, total / 12);

    let ok = failedAt === -1;
    if (ok && residualTarget > 0 && finalNet + 1e-6 < residualTarget) {
      ok = false;
      reason = 'Restformuen ved slutalderen bliver mindre end kravet.';
    }

    return {
      ok: ok, reason: reason, failedAtMonth: failedAt,
      months: months, retireMonth: retireMonth,
      atRetirement: atRetirement,
      contributed: contributed,
      finalValue: value, finalNet: finalNet, finalTax: finalTax,
      residualTarget: residualTarget,
    };
  }

  /**
   * Den tidligste pensionsalder der holder hele vejen.
   *
   * Kandidaterne prøves én måned ad gangen fra i dag og frem, og den første
   * der klarer sig, er svaret. Der bliver ikke gættet på, at en senere
   * pensionsalder altid er lettere end en tidligere: med forskellige afkast
   * før og efter pension, en indbetaling der stiger, og en progressionsgrænse
   * der reguleres, er det ikke garanteret. En fuld søgning koster ingenting,
   * fordi de kandidater der fejler, fejler tidligt og stopper der.
   *
   * @param {Inputs} it
   * @returns {{ found: boolean, sim: Simulation | null, tried: number }}
   */
  function findEarliest(it) {
    const total = horizonMonths(it);
    if (total <= 1) return { found: false, sim: null, tried: 0 };
    // Mindst én pensionsmåned: at "gå på pension" i samme måned som man fylder
    // slutalderen er ikke et svar på spørgsmålet.
    for (let k = 0; k < total; k++) {
      const sim = simulate(it, k);
      if (sim.ok) return { found: true, sim: sim, tried: k + 1 };
    }
    return { found: false, sim: null, tried: total };
  }

  /**
   * Hvad skal den månedlige indbetaling være, for at pensionen kan begynde
   * præcis efter `retireMonth` måneder? Den valgte årlige stigning gælder
   * stadig — det er startindbetalingen der løses for.
   *
   * Mere indbetaling kan ikke gøre scenariet dårligere, så grænsen findes ved
   * først at fordoble opad til noget der virker, og derefter halvere ind.
   *
   * @param {Inputs} it
   * @param {number} retireMonth
   * @returns {{ found: boolean, monthly: number, sim: Simulation | null }}
   */
  function solveContribution(it, retireMonth) {
    if (simulate(it, retireMonth, { monthly: 0 }).ok) {
      return { found: true, monthly: 0, sim: simulate(it, retireMonth, { monthly: 0 }) };
    }
    let hi = Math.max(1000, it.spend);
    let guard = 0;
    while (!simulate(it, retireMonth, { monthly: hi }).ok) {
      hi *= 2;
      if (++guard > 40) return { found: false, monthly: 0, sim: null };
    }
    let lo = 0;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (simulate(it, retireMonth, { monthly: mid }).ok) hi = mid; else lo = mid;
      if (hi - lo < 0.005) break;
    }
    return { found: true, monthly: hi, sim: simulate(it, retireMonth, { monthly: hi }) };
  }

  /**
   * Månedsrækkerne lagt sammen pr. kalenderår, som tabellen på siden viser dem.
   * @param {MonthRow[]} months
   * @returns {Array<{year:number, ageMonths:number, open:number, contribution:number,
   *   growth:number, gross:number, tax:number, net:number, close:number, deflator:number,
   *   retired:boolean, months:number}>}
   */
  function byYear(months) {
    /** @type {Array<any>} */
    const out = [];
    for (const r of months) {
      let row = out[out.length - 1];
      if (!row || row.year !== r.year) {
        row = { year: r.year, ageMonths: r.ageMonths, open: r.open, contribution: 0,
                growth: 0, gross: 0, tax: 0, net: 0, close: r.close,
                deflator: r.deflator, retired: r.retired, months: 0 };
        out.push(row);
      }
      row.contribution += r.contribution;
      row.growth += r.growth;
      row.gross += r.gross;
      row.tax += r.tax;
      row.net += r.net;
      row.close = r.close;
      row.deflator = r.deflator;
      row.ageMonths = r.ageMonths;
      row.retired = row.retired || r.retired;
      row.months += 1;
    }
    return out;
  }

  // Modellen lægges på det globale objekt, ligesom assets/kursliste.js gør.
  // Castet er der, fordi typeof globalThis ikke har plads til nye navne.
  /** @type {Record<string, unknown>} */ (global).Pension = {
    DEFAULTS, TAX_PRESET_2026, LIMITS,
    monthlyFactor, shareTax, normalize, startOf, horizonMonths,
    solveGross, simulate, findEarliest, solveContribution, byYear,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

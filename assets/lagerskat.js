/* Lagerbeskatning mod realisationsbeskatning — hele regnestykket, uden en
   eneste reference til DOM'en. Modulet indlæses både af lagerskat.html og af
   scripts/lagerskat.test.mjs, så det der vises på skærmen er nøjagtig det der
   bliver testet.

   Typerne står som JSDoc frem for i en .ts-fil, fordi sitet er statisk og
   kører uden byggetrin: browseren henter denne fil som den er.
   `npx -p typescript tsc --noEmit` læser dem alligevel gennem tsconfig.json's
   checkJs, så de holder på præcis de typer en .ts-fil ville give.

   Filen er en almindelig global som assets/kursliste.js, ikke et ES-modul, så
   siden også virker åbnet direkte fra disken — et modul ville browseren afvise
   over file://.

   Modellen er beskrevet i sin helhed under "Forudsætninger og beregning" på
   siden. Det korte af det lange: samme afkast, samme indbetalinger, to
   beskatningsformer. */
(function (global) {
  'use strict';

  /**
   * @typedef {Object} Assumptions
   * @property {number} start            Startkapital i kroner, ikke-negativ.
   * @property {number} monthly          Månedlig indbetaling i kroner, ikke-negativ.
   * @property {number} years            Hele år, 1–50.
   * @property {number} annualReturn     Årligt afkast før investors skat, som decimal (0,10 = 10 %).
   * @property {number} bracket          Skatteprogressionsgrænsen i kroner.
   * @property {number} otherIncome      Øvrig positiv aktieindkomst pr. år i kroner.
   * @property {number} lowRate          Sats under grænsen, som decimal (0,27).
   * @property {number} highRate         Sats over grænsen, som decimal (0,42).
   */

  /**
   * @typedef {Object} YearRow
   * @property {number} year                  0 = starttidspunktet, ellers hele år.
   * @property {number} deposits              Egne penge i alt: startkapital + indbetalinger til dato.
   * @property {number} depositsThisYear      Indbetalinger i netop dette år.
   * @property {number} etfValue              ETF-depotet efter årets lagerskat. Det er også nettobeløbet.
   * @property {number} etfGain               Årets gevinst i ETF'en, opgjort før årets skat.
   * @property {number} etfTax                Årets lagerskat.
   * @property {number} etfTaxTotal           Lagerskat betalt til og med dette år.
   * @property {number} stockValue            Aktiedepotet før salgsskat — der er ingen løbende skat.
   * @property {number} stockGain             Gevinst ved et fuldt salg netop nu.
   * @property {number} stockTax              Salgsskatten af den gevinst. Hypotetisk indtil slutåret.
   * @property {number} stockNet              Aktier efter salg og al skat.
   * @property {number} difference            stockNet − etfValue. Positiv = aktier giver mest.
   * @property {'aktier'|'etf'|'lige'} leader Hvem der fører ved udgangen af året.
   */

  /**
   * @typedef {Object} Projection
   * @property {YearRow[]} rows        Én række per år, inklusive år 0.
   * @property {YearRow} final         Rækken for slutåret. Ved 0 år er det år 0.
   * @property {Assumptions} input     De rensede forudsætninger beregningen faktisk brugte.
   */

  /** 2026-satser og -grænse. De holdes konstante gennem hele beregningen. */
  const DEFAULTS = Object.freeze({
    start: 500000,
    monthly: 5000,
    years: 10,
    annualReturn: 0.10,
    bracket: 79400,
    otherIncome: 0,
    lowRate: 0.27,
    highRate: 0.42,
  });

  /** Progressionsgrænsen for én person og for samlevende ægtefæller under ét. */
  const BRACKET_PRESETS = Object.freeze({ single: 79400, married: 158800 });

  /** Grænserne modellen holder sig indenfor. */
  const LIMITS = Object.freeze({
    years: { min: 1, max: 50 },
    annualReturn: { min: 0, max: 0.30 },
  });

  /* To beløb der ligger tættere på hinanden end en halv øre er det samme beløb.
     Grænsen ligger langt over den flydende regnings egen støj (under 1e-6 kr på
     beløb i millionklassen) og langt under noget der kan ses på skærmen, så den
     fanger afrundingsfejl uden at skjule en reel forskel. */
  const TIE = 0.005;

  /** @type {(n: unknown, fallback?: number) => number} */
  const finite = (n, fallback = 0) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);
  /** @type {(n: number, lo: number, hi: number) => number} */
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  /**
   * Månedsrenten der akkumuleret over tolv måneder giver præcis det årlige
   * afkast. Ikke afkast/12 — det ville ramme ved siden af med renters rente.
   * @param {number} annualReturn
   * @returns {number}
   */
  function monthlyRate(annualReturn) {
    return Math.pow(1 + finite(annualReturn), 1 / 12) - 1;
  }

  /**
   * Den plads der er tilbage under den lave sats, når anden aktieindkomst har
   * taget sin del af grænsen først.
   * @param {number} bracket
   * @param {number} otherIncome
   * @returns {number}
   */
  function lowBracketRoom(bracket, otherIncome) {
    return Math.max(0, finite(bracket) - finite(otherIncome));
  }

  /**
   * Aktieindkomstskat af en gevinst: lav sats op til den ledige grænse, høj sats
   * derover. Et tab beskattes ikke — modellen fremfører hverken tab eller
   * refunderer skat.
   * @param {number} gain
   * @param {number} room
   * @param {number} lowRate
   * @param {number} highRate
   * @returns {number}
   */
  function shareTax(gain, room, lowRate, highRate) {
    const g = finite(gain);
    if (g <= 0) return 0;
    const r = Math.max(0, finite(room));
    return Math.min(g, r) * finite(lowRate) + Math.max(0, g - r) * finite(highRate);
  }

  /**
   * Renser og klamper det brugeren har indtastet, så beregningen aldrig ser et
   * NaN eller et negativt afkast.
   * @param {Partial<Assumptions>} raw
   * @returns {Assumptions}
   */
  function normalize(raw) {
    const a = raw || {};
    return {
      start: Math.max(0, finite(a.start, DEFAULTS.start)),
      monthly: Math.max(0, finite(a.monthly, DEFAULTS.monthly)),
      years: clamp(Math.round(finite(a.years, DEFAULTS.years)), LIMITS.years.min, LIMITS.years.max),
      annualReturn: clamp(finite(a.annualReturn, DEFAULTS.annualReturn),
        LIMITS.annualReturn.min, LIMITS.annualReturn.max),
      bracket: Math.max(0, finite(a.bracket, DEFAULTS.bracket)),
      otherIncome: Math.max(0, finite(a.otherIncome, DEFAULTS.otherIncome)),
      lowRate: clamp(finite(a.lowRate, DEFAULTS.lowRate), 0, 1),
      highRate: clamp(finite(a.highRate, DEFAULTS.highRate), 0, 1),
    };
  }

  /** @param {number} difference @returns {'aktier'|'etf'|'lige'} */
  function leaderOf(difference) {
    if (difference > TIE) return 'aktier';
    if (difference < -TIE) return 'etf';
    return 'lige';
  }

  /**
   * Kører begge forløb side om side med samme indbetalinger og samme afkast.
   *
   * ETF'en gøres op ved hvert årsskifte: årets gevinst er værdien før skat minus
   * årets begyndelsesværdi minus årets egne indbetalinger, og skatten trækkes
   * ud af depotet, så den også koster det afkast pengene ellers ville have givet.
   *
   * Aktierne rører ingen skat undervejs. Hver årsrække viser i stedet et
   * hypotetisk fuldt salg netop det år — den skat trækkes aldrig fra det depot
   * der føres videre, ellers ville udskydelsen forsvinde fra modellen.
   *
   * @param {Partial<Assumptions>} raw
   * @returns {Projection}
   */
  function project(raw) {
    const input = normalize(raw);
    const r = monthlyRate(input.annualReturn);
    const room = lowBracketRoom(input.bracket, input.otherIncome);

    let etf = input.start;         // efter alle hidtidige års lagerskat
    let stock = input.start;       // urørt af skat frem til salg
    let deposits = input.start;    // egne penge i alt
    let etfTaxTotal = 0;

    /** @type {YearRow[]} */
    const rows = [{
      year: 0,
      deposits: deposits,
      depositsThisYear: 0,
      etfValue: etf,
      etfGain: 0,
      etfTax: 0,
      etfTaxTotal: 0,
      stockValue: stock,
      stockGain: 0,
      stockTax: 0,
      stockNet: stock,
      difference: 0,
      leader: 'lige',
    }];

    for (let y = 1; y <= input.years; y++) {
      const etfOpening = etf;
      let depositsThisYear = 0;

      for (let m = 0; m < 12; m++) {
        etf = etf * (1 + r) + input.monthly;
        stock = stock * (1 + r) + input.monthly;
        depositsThisYear += input.monthly;
      }
      deposits += depositsThisYear;

      const etfGain = etf - etfOpening - depositsThisYear;
      const etfTax = shareTax(etfGain, room, input.lowRate, input.highRate);
      etf -= etfTax;
      etfTaxTotal += etfTax;

      // Anskaffelsessummen er de egne penge. Aktierne har ingen udbytter og er
      // aldrig delvist solgt, så der er ikke andet at trække fra.
      const stockGain = stock - deposits;
      const stockTax = shareTax(stockGain, room, input.lowRate, input.highRate);
      const stockNet = stock - stockTax;
      const difference = stockNet - etf;

      rows.push({
        year: y,
        deposits: deposits,
        depositsThisYear: depositsThisYear,
        etfValue: etf,
        etfGain: etfGain,
        etfTax: etfTax,
        etfTaxTotal: etfTaxTotal,
        stockValue: stock,
        stockGain: stockGain,
        stockTax: stockTax,
        stockNet: stockNet,
        difference: difference,
        leader: leaderOf(difference),
      });
    }

    return { rows: rows, final: rows[rows.length - 1], input: input };
  }

  /**
   * @typedef {Object} Shift
   * @property {number} lastYear         Sidste år hvor den forrige investering førte.
   * @property {number} firstYear        Første år hvor den nye fører.
   * @property {'aktier'|'etf'} from
   * @property {'aktier'|'etf'} to
   */

  /**
   * @typedef {Object} Segment
   * @property {number} from                   Første år i strækket.
   * @property {number} to                     Sidste år i strækket.
   * @property {'aktier'|'etf'|'lige'} leader
   */

  /**
   * @typedef {Object} ShiftReport
   * @property {number} horizon            Antal år der blev undersøgt.
   * @property {Shift[]} shifts            Hvert sted fordelen skifter fra den ene til den anden.
   * @property {Segment[]} segments        Hele forløbet delt op i sammenhængende stræk.
   * @property {number[]} tieYears         De år hvor de to beløb er ens.
   * @property {boolean} anyTie
   * @property {boolean} anyDecisive       Om nogen af årene overhovedet har en vinder.
   */

  /**
   * Kører de samme forudsætninger ud over hele horisonten og finder hvert eneste
   * sted fordelen skifter. Modellen antager ikke at der kun findes ét
   * skæringspunkt, og den opfinder ikke en dato inde i et år: skiftet meldes som
   * det sidste år den ene fører og det første år den anden gør.
   *
   * Et år hvor beløbene er ens har ingen vinder, så det tæller ikke som et skift.
   * De år står for sig i `tieYears` og i `segments`; ligger de mellem to stræk,
   * springer skiftet hen over dem, og årene imellem kan aflæses på afstanden
   * mellem `lastYear` og `firstYear`.
   *
   * @param {Partial<Assumptions>} raw
   * @param {number} [horizon]
   * @returns {ShiftReport}
   */
  function findShifts(raw, horizon = LIMITS.years.max) {
    const span = clamp(Math.round(finite(horizon, LIMITS.years.max)),
      LIMITS.years.min, LIMITS.years.max);
    const rows = project(Object.assign({}, raw, { years: span })).rows.slice(1);

    /** @type {Segment[]} */
    const segments = [];
    for (const row of rows) {
      const last = segments[segments.length - 1];
      if (last && last.leader === row.leader) last.to = row.year;
      else segments.push({ from: row.year, to: row.year, leader: row.leader });
    }

    /** @type {Shift[]} */
    const shifts = [];
    /** @type {YearRow|null} */
    let previous = null;
    for (const row of rows) {
      if (row.leader === 'lige') continue;
      if (previous && previous.leader !== row.leader) {
        shifts.push({
          lastYear: previous.year,
          firstYear: row.year,
          from: /** @type {'aktier'|'etf'} */ (previous.leader),
          to: /** @type {'aktier'|'etf'} */ (row.leader),
        });
      }
      previous = row;
    }

    const tieYears = rows.filter((row) => row.leader === 'lige').map((row) => row.year);

    return {
      horizon: span,
      shifts: shifts,
      segments: segments,
      tieYears: tieYears,
      anyTie: tieYears.length > 0,
      anyDecisive: previous !== null,
    };
  }

  // Modellen lægges på det globale objekt, ligesom assets/kursliste.js gør.
  // Castet er der, fordi typeof globalThis ikke har plads til nye navne.
  /** @type {Record<string, unknown>} */ (global).Lagerskat = {
    DEFAULTS, BRACKET_PRESETS, LIMITS,
    monthlyRate, lowBracketRoom, shareTax, normalize, leaderOf, project, findShifts,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

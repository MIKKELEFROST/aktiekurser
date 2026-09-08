/* Beregningstest for lagerskat-modellen.
 *
 *   node --test scripts/lagerskat.test.mjs
 *
 * Kontroltallene øverst er facit for modellen. De er opgivet med ni decimaler
 * og skal rammes inden for 1 kr, men står med fuld præcision, fordi en model
 * der rammer på kronen i dag og på tieren i morgen har ændret sig uden at
 * nogen opdagede det.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// assets/lagerskat.js er en almindelig global som resten af sitets JavaScript,
// ikke et ES-modul, så testen indlæser den på samme måde som browseren gør:
// kør filen, og læs det globale den satte. Indirekte eval kører i denne fils
// eget realm, så de objekter der kommer ud er ganske almindelige arrays og
// objekter, som assert.deepEqual kan sammenligne.
(0, eval)(readFileSync(fileURLToPath(new URL('../assets/lagerskat.js', import.meta.url)), 'utf8'));

const {
  DEFAULTS, BRACKET_PRESETS, LIMITS,
  project, findShifts, monthlyRate, lowBracketRoom, shareTax, normalize, leaderOf,
} = globalThis.Lagerskat;

const KRONE = 1;
const closeTo = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ${actual} afveg mere end ${tolerance} fra ${expected}`);

test('standardværdierne rammer kontroltallene efter 10 år', () => {
  const f = project(DEFAULTS).final;
  closeTo(f.deposits, 1100000, KRONE, 'samlede indbetalinger');
  closeTo(f.etfValue, 1826097.447360159, KRONE, 'ETF efter al skat');
  closeTo(f.stockValue, 2296190.513620172, KRONE, 'aktier før salgsskat');
  closeTo(f.stockTax, 490490.015720472, KRONE, 'aktiernes salgsskat');
  closeTo(f.stockNet, 1805700.497899700, KRONE, 'aktier efter salgsskat');
  closeTo(-f.difference, 20396.949460459, KRONE, 'ETF-fordel');
  closeTo(f.etfTaxTotal, 333337.257733455, KRONE, 'samlet ETF-skat');
});

test('efter 12 år har aktierne overhalet', () => {
  const f = project({ ...DEFAULTS, years: 12 }).final;
  closeTo(f.etfValue, 2195284.553676170, KRONE, 'ETF efter al skat');
  closeTo(f.stockNet, 2212148.370427323, KRONE, 'aktier efter salgsskat');
  closeTo(f.difference, 16863.816751153, KRONE, 'aktiefordel');
  assert.equal(f.leader, 'aktier');
});

test('øvrig aktieindkomst på 79.400 kr spiser hele den lave sats', () => {
  const f = project({ ...DEFAULTS, otherIncome: 79400 }).final;
  closeTo(f.etfValue, 1682599.248908685, KRONE, 'ETF efter al skat');
  closeTo(f.stockNet, 1793790.497899700, KRONE, 'aktier efter salgsskat');
  // Hele gevinsten ligger nu over grænsen, så begge er beskattet med 42 %.
  closeTo(f.stockTax, f.stockGain * 0.42, 1e-6, 'salgsskat ved fuld sats');
});

test('et tomt forløb giver nul hele vejen', () => {
  const f = project({ ...DEFAULTS, start: 0, monthly: 0 }).final;
  for (const key of ['deposits', 'etfValue', 'etfTaxTotal', 'stockValue', 'stockTax', 'stockNet', 'difference']) {
    assert.equal(f[key], 0, `${key} skulle være nul`);
  }
  assert.equal(f.leader, 'lige');
});

test('uden afkast er der ingen skat, og begge ender på det indbetalte', () => {
  const p = project({ ...DEFAULTS, annualReturn: 0, years: 30 });
  for (const row of p.rows) {
    assert.equal(row.etfTax, 0, `år ${row.year} havde lagerskat uden afkast`);
    assert.equal(row.stockTax, 0, `år ${row.year} havde salgsskat uden afkast`);
    closeTo(row.etfValue, row.deposits, 1e-9, `ETF i år ${row.year}`);
    closeTo(row.stockNet, row.deposits, 1e-9, `aktier i år ${row.year}`);
  }
  closeTo(p.final.deposits, 500000 + 30 * 12 * 5000, 1e-9, 'indbetalinger');
});

test('efter ét år er de to nettobeløb identiske', () => {
  for (const annualReturn of [0, 0.03, 0.10, 0.30]) {
    for (const otherIncome of [0, 40000, 200000]) {
      const f = project({ ...DEFAULTS, years: 1, annualReturn, otherIncome }).final;
      closeTo(f.difference, 0, 1e-9, `forskel ved ${annualReturn} / ${otherIncome}`);
      assert.equal(f.leader, 'lige');
      // Ikke bare ens: ETF'ens lagerskat i år 1 er den samme skat som et salg
      // ville udløse, fordi der endnu ikke er beskattet noget.
      closeTo(f.etfTax, f.stockTax, 1e-9, 'år 1: lagerskat mod salgsskat');
    }
  }
});

test('skatten er korrekt under, på og over progressionsgrænsen', () => {
  const room = lowBracketRoom(79400, 0);
  assert.equal(room, 79400);
  closeTo(shareTax(50000, room, 0.27, 0.42), 50000 * 0.27, 1e-9, 'under grænsen');
  closeTo(shareTax(79400, room, 0.27, 0.42), 79400 * 0.27, 1e-9, 'præcis på grænsen');
  closeTo(shareTax(100000, room, 0.27, 0.42),
    79400 * 0.27 + 20600 * 0.42, 1e-9, 'over grænsen');
  // Ét øre over grænsen må kun koste den høje sats af det ene øre.
  closeTo(shareTax(79400.01, room, 0.27, 0.42),
    79400 * 0.27 + 0.01 * 0.42, 1e-9, 'lige over grænsen');
  assert.equal(shareTax(0, room, 0.27, 0.42), 0, 'ingen gevinst, ingen skat');
  assert.equal(shareTax(-50000, room, 0.27, 0.42), 0, 'et tab udløser ikke negativ skat');
});

test('øvrig aktieindkomst æder den lave sats nedefra', () => {
  assert.equal(lowBracketRoom(79400, 30000), 49400);
  assert.equal(lowBracketRoom(79400, 79400), 0);
  assert.equal(lowBracketRoom(79400, 120000), 0, 'grænsen kan ikke blive negativ');
  // 30.000 kr øvrig indkomst flytter 30.000 kr af gevinsten op på høj sats.
  const fuld = shareTax(200000, lowBracketRoom(79400, 0), 0.27, 0.42);
  const delvis = shareTax(200000, lowBracketRoom(79400, 30000), 0.27, 0.42);
  closeTo(delvis - fuld, 30000 * (0.42 - 0.27), 1e-9, 'merskat af 30.000 kr');
});

test('ægtefælleforvalget fordobler grænsen og sænker skatten', () => {
  const single = project({ ...DEFAULTS, bracket: BRACKET_PRESETS.single }).final;
  const married = project({ ...DEFAULTS, bracket: BRACKET_PRESETS.married }).final;
  assert.equal(BRACKET_PRESETS.married, 2 * BRACKET_PRESETS.single);
  assert.ok(married.etfTaxTotal < single.etfTaxTotal, 'ægtefæller betaler mindre lagerskat');
  assert.ok(married.etfValue > single.etfValue, 'og står tilbage med mere');
  // Aktiernes salgsskat bruger ét års grænse, så den ekstra plads er præcis
  // 79.400 kr flyttet fra 42 % til 27 %.
  closeTo(single.stockTax - married.stockTax,
    BRACKET_PRESETS.single * (0.42 - 0.27), 1e-6, 'sparet salgsskat');
});

test('øvrig aktieindkomst indgår aldrig i selve investeringsresultatet', () => {
  const uden = project(DEFAULTS).final;
  const med = project({ ...DEFAULTS, otherIncome: 40000 }).final;
  // Aktiedepotet før skat kender ikke til anden indkomst — kun skatten gør.
  closeTo(med.stockValue, uden.stockValue, 1e-9, 'depotværdi før salgsskat');
  closeTo(med.stockTax - uden.stockTax, 40000 * (0.42 - 0.27), 1e-6, 'merskat ved salg');
  closeTo(med.stockNet, uden.stockNet - 40000 * (0.42 - 0.27), 1e-6, 'nettobeløb');
});

test('lagerskatten trækkes af depotet, år for år', () => {
  const rows = project(DEFAULTS).rows;
  let running = 0;
  for (const row of rows.slice(1)) {
    running += row.etfTax;
    closeTo(row.etfTaxTotal, running, 1e-9, `samlet skat efter år ${row.year}`);
    // Årets gevinst er værdien før skat minus begyndelsesværdi og årets egne
    // penge — regnet forfra ud fra den foregående række.
    const previous = rows[row.year - 1];
    const preTax = row.etfValue + row.etfTax;
    closeTo(row.etfGain, preTax - previous.etfValue - row.depositsThisYear,
      1e-6, `årets gevinst i år ${row.year}`);
  }
});

test('den hypotetiske salgsskat rører aldrig aktiedepotet', () => {
  const rows = project(DEFAULTS).rows;
  const r = monthlyRate(DEFAULTS.annualReturn);
  for (const row of rows.slice(1)) {
    let expected = rows[row.year - 1].stockValue;
    for (let m = 0; m < 12; m++) expected = expected * (1 + r) + DEFAULTS.monthly;
    closeTo(row.stockValue, expected, 1e-6,
      `aktiedepotet i år ${row.year} er vokset ubeskåret`);
    closeTo(row.stockGain, row.stockValue - row.deposits, 1e-9, `gevinst i år ${row.year}`);
  }
});

test('månedsrenten er geometrisk, ikke årsafkastet delt med tolv', () => {
  const r = monthlyRate(0.10);
  closeTo(Math.pow(1 + r, 12) - 1, 0.10, 1e-12, 'tolv måneder giver året');
  assert.notEqual(r, 0.10 / 12);
  assert.equal(monthlyRate(0), 0);
});

test('fordelen skifter fra ETF til aktier mellem år 11 og 12', () => {
  const report = findShifts(DEFAULTS);
  assert.equal(report.horizon, 50);
  assert.deepEqual(report.shifts,
    [{ lastYear: 11, firstYear: 12, from: 'etf', to: 'aktier' }]);
  assert.deepEqual(report.tieYears, [1], 'kun år 1 er uafgjort');
  assert.deepEqual(report.segments, [
    { from: 1, to: 1, leader: 'lige' },
    { from: 2, to: 11, leader: 'etf' },
    { from: 12, to: 50, leader: 'aktier' },
  ]);
});

test('uden afkast er hvert eneste år uafgjort, og der er intet skift', () => {
  const report = findShifts({ ...DEFAULTS, annualReturn: 0 });
  assert.deepEqual(report.shifts, []);
  assert.equal(report.anyDecisive, false);
  assert.equal(report.tieYears.length, 50);
});

test('flere skift meldes hver for sig', () => {
  // Uden løbende indbetalinger og med en stor progressionsgrænse kan ETF'ens
  // årlige lave sats vinde igen senere, efter at aktiernes ene års grænse har
  // ført først. Modellen antager ikke ét skæringspunkt, så begge skal med.
  const many = { ...DEFAULTS, monthly: 0, start: 100000, annualReturn: 0.05, bracket: 20000 };
  const report = findShifts(many);
  assert.ok(report.shifts.length >= 2,
    `forventede mindst to skift, fandt ${report.shifts.length}`);
  for (let i = 1; i < report.shifts.length; i++) {
    assert.ok(report.shifts[i].firstYear > report.shifts[i - 1].firstYear, 'skiftene står i rækkefølge');
    assert.equal(report.shifts[i].from, report.shifts[i - 1].to, 'skiftene hænger sammen');
  }
  // Hvert meldt skift skal svare til et faktisk skifte i tabellen.
  const rows = project({ ...many, years: 50 }).rows;
  for (const shift of report.shifts) {
    assert.equal(rows[shift.lastYear].leader, shift.from);
    assert.equal(rows[shift.firstYear].leader, shift.to);
  }
});

test('ugyldige og tomme felter falder tilbage uden NaN', () => {
  const junk = normalize({
    start: NaN, monthly: undefined, years: 0, annualReturn: 4,
    bracket: -1, otherIncome: NaN, lowRate: NaN, highRate: 9,
  });
  assert.equal(junk.start, DEFAULTS.start);
  assert.equal(junk.monthly, DEFAULTS.monthly);
  assert.equal(junk.years, LIMITS.years.min, 'nul år klemmes op til ét');
  assert.equal(junk.annualReturn, LIMITS.annualReturn.max, '400 % klemmes ned til 30 %');
  assert.equal(junk.bracket, 0, 'en negativ grænse bliver nul');
  assert.equal(junk.otherIncome, DEFAULTS.otherIncome);
  assert.equal(junk.lowRate, DEFAULTS.lowRate);
  assert.equal(junk.highRate, 1, 'en sats over 100 % klemmes ned');

  for (const bad of [{}, { years: 51 }, { years: -3 }, { start: -1, monthly: -1 },
    { annualReturn: -0.5 }, { annualReturn: Infinity }, { bracket: NaN, otherIncome: Infinity }]) {
    const p = project(bad);
    assert.ok(p.rows.length >= 2, 'der er altid mindst ét år');
    for (const row of p.rows) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value), `${key} i år ${row.year} var ${value}`);
        }
      }
      assert.ok(row.etfValue >= 0 && row.stockNet >= 0, 'ingen negative depoter');
    }
  }
});

test('negativt afkast afvises frem for at blive modelleret forsimplet', () => {
  assert.equal(project({ ...DEFAULTS, annualReturn: -0.20 }).input.annualReturn, 0,
    'et negativt afkast klemmes til nul i stedet for at give skatterefusion');
});

test('år 0 er startkapitalen, uberørt af begge skatteformer', () => {
  const first = project(DEFAULTS).rows[0];
  assert.equal(first.year, 0);
  assert.equal(first.etfValue, DEFAULTS.start);
  assert.equal(first.stockNet, DEFAULTS.start);
  assert.equal(first.difference, 0);
});

test('leaderOf tåler afrundingsstøj omkring nul', () => {
  assert.equal(leaderOf(0), 'lige');
  assert.equal(leaderOf(1e-9), 'lige');
  assert.equal(leaderOf(-1e-9), 'lige');
  assert.equal(leaderOf(1), 'aktier');
  assert.equal(leaderOf(-1), 'etf');
});

test('længere horisont ændrer ikke de tidligere år', () => {
  const ti = project({ ...DEFAULTS, years: 10 }).rows;
  const halvtreds = project({ ...DEFAULTS, years: 50 }).rows;
  for (let y = 0; y <= 10; y++) {
    closeTo(halvtreds[y].etfValue, ti[y].etfValue, 1e-9, `ETF i år ${y}`);
    closeTo(halvtreds[y].stockNet, ti[y].stockNet, 1e-9, `aktier i år ${y}`);
  }
});

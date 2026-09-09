/* Beregningstest for pensionsmodellen.
 *
 *   node --test scripts/pension.test.mjs
 *
 * De to kontroltal øverst er regnet i hånden, ikke aflæst af motoren. Det er
 * hele pointen: en test der spørger koden hvad koden mener, beviser kun at
 * koden er sig selv lig. Resten af filen er de kontroller specifikationens
 * afsnit 10 beder om, og de er skrevet så de fejler hvis reglen forsvinder —
 * ikke bare hvis tallet flytter sig.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// assets/pension.js er en almindelig global som resten af sitets JavaScript,
// ikke et ES-modul, så testen indlæser den som browseren gør: kør filen, og
// læs det globale den satte.
(0, eval)(readFileSync(fileURLToPath(new URL('../assets/pension.js', import.meta.url)), 'utf8'));

const {
  DEFAULTS, normalize, simulate, findEarliest, solveContribution,
  shareTax, monthlyFactor, horizonMonths, byYear,
} = globalThis.Pension;

const ØRE = 0.01;
const KRONE = 1;
const closeTo = (actual, expected, tol, label) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `${label}: ${actual} afveg mere end ${tol} fra ${expected}`);

/** Et sæt input hvor kun det nævnte afviger fra standarden. */
const cfg = (over) => normalize(Object.assign({}, DEFAULTS, over));

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);

// ── 1. Nul afkast, nul skat, nul inflation ───────────────────────────────
// Et depot på 300.000 der hæver 25.000 om måneden uden afkast og uden skat
// holder præcis tolv måneder. Ikke elleve, ikke tretten.
test('uden afkast, skat og inflation er det almindelig nedbringelse', () => {
  const it = cfg({
    ageYears: 79, ageMonths: 0, endAge: 80, startDate: '2026-01-01',
    depot: 300000, basis: 300000, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true, costs: 0,
    spend: 25000, inflationOn: false,
  });
  assert.equal(horizonMonths(it), 12);

  const sim = simulate(it, 0);
  assert.ok(sim.ok, 'tolv måneder skal kunne betales: ' + sim.reason);
  assert.equal(sim.months.length, 12);
  closeTo(sum(sim.months, 'net'), 300000, ØRE, 'udbetalt i alt');
  closeTo(sum(sim.months, 'tax'), 0, ØRE, 'skat i alt');
  closeTo(sim.finalValue, 0, ØRE, 'depot ved slutalderen');

  // Og en måned mere kan ikke betales.
  const tretten = simulate(cfg({
    ageYears: 78, ageMonths: 11, endAge: 80, startDate: '2026-01-01',
    depot: 300000, basis: 300000, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true, costs: 0,
    spend: 25000, inflationOn: false,
  }), 0);
  assert.equal(tretten.ok, false, 'den trettende måned må ikke kunne betales');
  assert.equal(tretten.failedAtMonth, 12);
});

// ── 2. Salg uden gevinst udløser ingen aktieskat ─────────────────────────
test('et depot uden urealiseret gevinst betaler ingen aktieskat', () => {
  const sim = simulate(cfg({
    ageYears: 79, ageMonths: 0, endAge: 80, startDate: '2026-01-01',
    depot: 500000, basis: 500000, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 25000, inflationOn: false,
  }), 0);
  assert.ok(sim.ok);
  closeTo(sum(sim.months, 'tax'), 0, ØRE, 'skat i alt');
  for (const r of sim.months) closeTo(r.gross, r.net, ØRE, 'brutto = netto uden gevinst');
});

// ── 3. Anskaffelsessummen reduceres forholdsmæssigt ──────────────────────
// Et forholdsmæssigt salg lader forholdet mellem anskaffelsessum og værdi stå
// uændret. Går forholdet, er anskaffelsessummen skrevet ned med noget andet
// end sin egen andel.
test('et forholdsmæssigt salg bevarer anskaffelsesandelen', () => {
  const sim = simulate(cfg({
    ageYears: 60, ageMonths: 0, endAge: 70, startDate: '2026-01-01',
    depot: 4000000, basis: 1500000, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 20000, inflationOn: false,
  }), 0);
  assert.ok(sim.ok, sim.reason);
  const start = 1500000 / 4000000;
  for (const r of sim.months) {
    closeTo(r.basis / r.close, start, 1e-9, 'anskaffelsesandel i måned ' + r.index);
  }
});

// ── 4. Progressionsgrænsen bruges én gang pr. kalenderår ─────────────────
// Kontroltal regnet i hånden. Anskaffelsessummen er nul, så hver krone solgt
// er en krone gevinst. Tolv måneder á 10.000 kr. netto er 120.000 kr. i alt.
//
//   Over grænsen:  skat(G) = 0,27·79.400 + 0,42·(G − 79.400) = 0,42G − 11.910
//   G − skat(G) = 120.000  ⇒  0,58G = 108.090  ⇒  G = 186.362,068965517…
//   skat = 0,42·186.362,068965517 − 11.910 = 66.362,068965517…
//
// Brugtes grænsen forfra hver måned, ville hver måneds gevinst ligge under den,
// alt ville koste 27 %, og bruttosalget ville blive 164.383,56. Testen skiller
// de to fra hinanden.
test('progressionsgrænsen gælder året, ikke måneden', () => {
  const it = cfg({
    ageYears: 79, ageMonths: 0, endAge: 80, startDate: '2026-01-01',
    depot: 1000000, basis: 0, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 10000, inflationOn: false,
    lowRate: 0.27, highRate: 0.42, threshold: 79400,
  });
  const sim = simulate(it, 0);
  assert.ok(sim.ok, sim.reason);
  closeTo(sum(sim.months, 'gross'), 186362.068965517, ØRE, 'bruttosalg på året');
  closeTo(sum(sim.months, 'tax'), 66362.068965517, ØRE, 'skat på året');
  closeTo(sum(sim.months, 'net'), 120000, ØRE, 'udbetalt netto');

  // Den første måned skal koste 27 %, den sidste 42 %: grænsen bruges op undervejs.
  closeTo(sim.months[0].tax / sim.months[0].gross, 0.27, 1e-9, 'første måneds sats');
  const last = sim.months[11];
  closeTo(last.tax / last.gross, 0.42, 1e-9, 'sidste måneds sats');
});

// ── 5. Et nyt kalenderår giver grænsen tilbage ───────────────────────────
test('grænsen kommer igen ved årsskiftet', () => {
  const et = cfg({
    ageYears: 78, ageMonths: 0, endAge: 80, startDate: '2026-01-01',
    depot: 2000000, basis: 0, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 10000, inflationOn: false,
  });
  const sim = simulate(et, 0);
  assert.ok(sim.ok, sim.reason);
  const y2026 = sim.months.filter((r) => r.year === 2026);
  const y2027 = sim.months.filter((r) => r.year === 2027);
  assert.equal(y2026.length, 12);
  assert.equal(y2027.length, 12);
  // To identiske år skal koste det samme. Blev grænsen ikke nulstillet, ville
  // andet år udelukkende blive beskattet med 42 % og koste mere.
  closeTo(sum(y2027, 'tax'), sum(y2026, 'tax'), ØRE, 'to ens år koster det samme');
  closeTo(sim.months[12].tax / sim.months[12].gross, 0.27, 1e-9, 'januar er tilbage på 27 %');
});

// ── 6. Pensionen kan begynde midt i et kalenderår ────────────────────────
test('pension midt i året bruger kun resten af årets grænse', () => {
  // Start i januar, gå på pension efter seks måneder: første pensionsmåned er
  // juli, og året har stadig hele sin grænse, fordi der ikke er solgt før.
  const it = cfg({
    ageYears: 60, ageMonths: 0, endAge: 62, startDate: '2026-01-01',
    depot: 3000000, basis: 0, monthly: 5000,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 15000, inflationOn: false,
  });
  const sim = simulate(it, 6);
  assert.ok(sim.ok, sim.reason);
  assert.equal(sim.months[5].retired, false, 'juni er en opsparingsmåned');
  assert.equal(sim.months[6].retired, true, 'juli er en pensionsmåned');
  assert.equal(sim.months[6].month, 6, 'den syvende måned er juli');
  closeTo(sim.months[5].gross, 0, ØRE, 'der sælges ikke i juni');
  closeTo(sim.months[6].contribution, 0, ØRE, 'der indbetales ikke i juli');
  // Halvt år med seks hævninger: seks gange 15.000 netto.
  const rest2026 = sim.months.filter((r) => r.year === 2026 && r.retired);
  assert.equal(rest2026.length, 6);
  closeTo(sum(rest2026, 'net'), 90000, ØRE, 'andet halvår udbetalt');
});

// ── 7. Depotet forrentes videre efter pensionsstart ──────────────────────
test('resten af depotet forrentes efter pensionsstart', () => {
  const sim = simulate(cfg({
    ageYears: 60, ageMonths: 0, endAge: 70, startDate: '2026-01-01',
    depot: 5000000, basis: 5000000, monthly: 0,
    returnSaving: 0.07, returnRetired: 0.07, sameReturn: true,
    spend: 20000, inflationOn: false,
  }), 0);
  assert.ok(sim.ok, sim.reason);
  for (const r of sim.months) {
    assert.ok(r.growth > 0, 'måned ' + r.index + ' skal have afkast, havde ' + r.growth);
    closeTo(r.growth, r.open * (Math.pow(1.07, 1 / 12) - 1), 1e-6, 'afkast i måned ' + r.index);
  }
});

// ── 8. Ingen indbetalinger efter pensionsstart ───────────────────────────
test('indbetalingerne stopper præcis ved pensionsstart', () => {
  const sim = simulate(cfg({
    ageYears: 40, ageMonths: 0, endAge: 60, startDate: '2026-01-01',
    depot: 2000000, basis: 2000000, monthly: 10000, monthlyGrowth: 0.03,
    spend: 15000, inflationOn: false,
  }), 24);
  assert.ok(sim.ok, sim.reason);
  for (const r of sim.months) {
    if (r.retired) closeTo(r.contribution, 0, ØRE, 'ingen indbetaling i måned ' + r.index);
    else assert.ok(r.contribution > 0, 'indbetaling mangler i måned ' + r.index);
    assert.ok(!(r.contribution > 0 && r.gross > 0), 'måned ' + r.index + ' både indbetaler og hæver');
  }
  // Stigningen falder på årsdagen, ikke ved årsskiftet.
  closeTo(sim.months[11].contribution, 10000, ØRE, 'tolvte måned er stadig grundbeløbet');
  closeTo(sim.months[12].contribution, 10300, ØRE, 'trettende måned er steget 3 %');
  closeTo(sim.months[23].contribution, 10300, ØRE, 'fireogtyvende måned er stadig steget én gang');
});

// ── 9. Inflationen anvendes præcis én gang ───────────────────────────────
test('inflationen rammer forbruget og ikke afkastet', () => {
  const it = cfg({
    ageYears: 60, ageMonths: 0, endAge: 65, startDate: '2026-01-01',
    depot: 5000000, basis: 5000000, monthly: 0,
    returnSaving: 0.07, returnRetired: 0.07, sameReturn: true,
    spend: 25000, inflationOn: true, inflation: 0.02,
  });
  const sim = simulate(it, 0);
  assert.ok(sim.ok, sim.reason);

  // Forbruget vokser med inflationen, målt fra beregningens start.
  for (const r of sim.months) {
    const forventet = 25000 * Math.pow(1.02, (r.index + 1) / 12);
    closeTo(r.net, forventet, 1e-6, 'nettoforbrug i måned ' + r.index);
  }
  // Afkastet er nominelt og uberørt: inflationen må ikke trækkes fra to gange.
  const f = Math.pow(1.07, 1 / 12) - 1;
  for (const r of sim.months) closeTo(r.growth, r.open * f, 1e-6, 'afkast i måned ' + r.index);

  // Og et forbrug omregnet tilbage med deflatoren er præcis det indtastede.
  for (const r of sim.months) closeTo(r.net / r.deflator, 25000, 1e-6, 'i dagens kroner');
});

test('uden inflation er forbruget et fast nominelt beløb', () => {
  const sim = simulate(cfg({
    ageYears: 60, ageMonths: 0, endAge: 65, startDate: '2026-01-01',
    depot: 5000000, basis: 5000000, monthly: 0,
    spend: 25000, inflationOn: false, inflation: 0.02,
  }), 0);
  for (const r of sim.months) {
    closeTo(r.net, 25000, ØRE, 'nettoforbrug i måned ' + r.index);
    closeTo(r.deflator, 1, 1e-12, 'ingen deflator uden inflation');
  }
});

// ── 10. Utilstrækkelige midler er et fejlet scenarie ─────────────────────
test('et depot der ikke rækker, giver et fejlet scenarie', () => {
  const sim = simulate(cfg({
    ageYears: 60, ageMonths: 0, endAge: 90, startDate: '2026-01-01',
    depot: 100000, basis: 100000, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 25000, inflationOn: false,
  }), 0);
  assert.equal(sim.ok, false);
  assert.ok(sim.failedAtMonth >= 0, 'måneden skal navngives');
  assert.ok(sim.reason.length > 0, 'grunden skal siges');
  for (const r of sim.months) assert.ok(r.close >= -1e-9, 'depotet må aldrig blive negativt');
});

// ── 11. Pengestrømmene skal stemme med depotet ───────────────────────────
test('hver måneds bevægelser summer til ændringen i depotet', () => {
  for (const over of [
    { inflationOn: false },
    { inflationOn: true, inflation: 0.025 },
    { monthlyGrowth: 0.02, costs: 0.005 },
    { depot: 900000, basis: 250000, carriedLoss: 40000 },
  ]) {
    const it = cfg(Object.assign({
      ageYears: 45, ageMonths: 3, endAge: 85, startDate: '2026-04-01',
      depot: 1200000, basis: 700000, monthly: 12000, spend: 30000,
    }, over));
    const found = findEarliest(it);
    assert.ok(found.found, 'scenariet skal kunne lade sig gøre: ' + JSON.stringify(over));
    const sim = /** @type {any} */ (found.sim);
    for (const r of sim.months) {
      closeTo(r.close, r.open + r.growth + r.contribution - r.gross, 1e-6,
        'balance i måned ' + r.index + ' ' + JSON.stringify(over));
      closeTo(r.gross, r.net + r.tax, 1e-6,
        'brutto = netto + skat i måned ' + r.index + ' ' + JSON.stringify(over));
    }
    // Og årsrækkerne må ikke tabe noget på vejen til skærmen.
    const years = byYear(sim.months);
    closeTo(sum(years, 'net'), sum(sim.months, 'net'), 1e-6, 'årstabellens netto');
    closeTo(sum(years, 'tax'), sum(sim.months, 'tax'), 1e-6, 'årstabellens skat');
    closeTo(years[years.length - 1].close, sim.finalValue, 1e-6, 'sidste års ultimo');
  }
});

// ── 12. Restformuekravet ─────────────────────────────────────────────────
test('restformuen måles efter skat ved fuld realisation', () => {
  const base = {
    ageYears: 55, ageMonths: 0, endAge: 75, startDate: '2026-01-01',
    depot: 6000000, basis: 2000000, monthly: 0,
    returnSaving: 0.05, returnRetired: 0.05, sameReturn: true,
    spend: 20000, inflationOn: false,
  };
  const uden = simulate(cfg(base), 0);
  assert.ok(uden.ok, uden.reason);
  assert.ok(uden.finalTax > 0, 'der er urealiseret gevinst tilbage, altså en skat');
  closeTo(uden.finalNet, uden.finalValue - uden.finalTax, ØRE, 'restformue efter skat');

  // Et krav lige over det opnåede skal få scenariet til at fejle.
  const forHøjt = simulate(cfg(Object.assign({}, base, { minResidual: uden.finalNet + 10000 })), 0);
  assert.equal(forHøjt.ok, false, 'et krav over det mulige skal fejle');
  assert.equal(forHøjt.failedAtMonth, -1, 'pengene slap ikke op undervejs');

  // Og et krav lige under skal stadig gå igennem.
  const lige̶akkurat = simulate(cfg(Object.assign({}, base, { minResidual: uden.finalNet - 10000 })), 0);
  assert.equal(lige̶akkurat.ok, true, 'et krav under det mulige skal kunne lade sig gøre');
});

// ── 13. Den tidligste pensionsalder er den tidligste ─────────────────────
test('findEarliest returnerer den første måned der holder, og ikke en senere', () => {
  const it = cfg({
    ageYears: 27, ageMonths: 6, endAge: 80, startDate: '2026-01-01',
    depot: 300000, basis: 300000, monthly: 10000, spend: 25000,
  });
  const found = findEarliest(it);
  assert.ok(found.found, 'standardsagen skal kunne lade sig gøre');
  const k = /** @type {any} */ (found.sim).retireMonth;
  assert.ok(k > 0, 'man kan ikke gå på pension med det samme');
  assert.equal(simulate(it, k).ok, true, 'den fundne måned skal holde');
  assert.equal(simulate(it, k - 1).ok, false, 'måneden før må ikke holde');
});

// Bemærk hvad "muligt" betyder her: at gå på pension i den næstsidste måned
// kræver kun én udbetaling, og det kan næsten alle depoter klare. Et scenarie
// er derfor først umuligt, når ikke en eneste måned kan betales — og det er
// den grænse denne test rammer.
test('et umuligt mål giver intet svar frem for et forkert', () => {
  const found = findEarliest(cfg({
    ageYears: 27, ageMonths: 6, endAge: 80, startDate: '2026-01-01',
    depot: 0, basis: 0, monthly: 0, spend: 25000,
  }));
  assert.equal(found.found, false);
  assert.equal(found.sim, null);
});

test('en sen pensionsalder tæller også, når den kun skal dække få måneder', () => {
  // Det er ikke en fejl, men en egenskab ved spørgsmålet: modellen leder efter
  // den første måned hvorfra ALLE resterende måneder kan betales. Er der kun
  // én tilbage, skal der kun én betales. Siden siger det samme med ord.
  const it = cfg({
    ageYears: 27, ageMonths: 6, endAge: 80, startDate: '2026-01-01',
    depot: 0, basis: 0, monthly: 500, spend: 200000,
  });
  const found = findEarliest(it);
  assert.equal(found.found, true);
  const sim = /** @type {any} */ (found.sim);
  assert.ok(sim.months.filter((r) => r.retired).length >= 1);
});

// ── 14. Den omvendte vej: hvad skal der investeres? ──────────────────────
test('solveContribution finder den indbetaling der lige akkurat rækker', () => {
  const it = cfg({
    ageYears: 30, ageMonths: 0, endAge: 85, startDate: '2026-01-01',
    depot: 200000, basis: 200000, monthly: 0, spend: 30000,
  });
  const mål = (50 - 30) * 12;                 // stop som 50-årig
  const svar = solveContribution(it, mål);
  assert.ok(svar.found, 'der skal findes en indbetaling');
  assert.equal(simulate(it, mål, { monthly: svar.monthly }).ok, true, 'beløbet skal holde');
  assert.equal(simulate(it, mål, { monthly: svar.monthly * 0.99 }).ok, false,
    'en procent mindre må ikke holde');
});

test('solveContribution respekterer den årlige stigning', () => {
  const base = {
    ageYears: 30, ageMonths: 0, endAge: 85, startDate: '2026-01-01',
    depot: 200000, basis: 200000, monthly: 0, spend: 30000,
  };
  const mål = 20 * 12;
  const flad = solveContribution(cfg(base), mål);
  const stigende = solveContribution(cfg(Object.assign({}, base, { monthlyGrowth: 0.03 })), mål);
  assert.ok(flad.found && stigende.found);
  assert.ok(stigende.monthly < flad.monthly,
    'en indbetaling der stiger 3 % om året må starte lavere: '
    + stigende.monthly + ' mod ' + flad.monthly);
});

// ── 15. Byggestenene hver for sig ────────────────────────────────────────
test('skattefunktionen knækker på grænsen', () => {
  closeTo(shareTax(0, 79400, 0.27, 0.42), 0, 0, 'ingen gevinst');
  closeTo(shareTax(-5000, 79400, 0.27, 0.42), 0, 0, 'et tab beskattes ikke');
  closeTo(shareTax(79400, 79400, 0.27, 0.42), 21438, ØRE, 'præcis på grænsen');
  closeTo(shareTax(100000, 79400, 0.27, 0.42), 21438 + 0.42 * 20600, ØRE, 'over grænsen');
});

test('vækstfaktoren lægger omkostningen ind i det årlige tal', () => {
  closeTo(Math.pow(monthlyFactor(0.07, 0), 12), 1.07, 1e-12, 'uden omkostning');
  closeTo(Math.pow(monthlyFactor(0.07, 0.005), 12), 1.07 * 0.995, 1e-12, 'med omkostning');
  closeTo(monthlyFactor(0, 0), 1, 1e-12, 'nul afkast er faktor én');
});

test('fremført tab modregnes før skatten, og bliver ikke til kontanter', () => {
  const it = cfg({
    ageYears: 79, ageMonths: 0, endAge: 80, startDate: '2026-01-01',
    depot: 1000000, basis: 0, monthly: 0,
    returnSaving: 0, returnRetired: 0, sameReturn: true,
    spend: 5000, inflationOn: false, carriedLoss: 100000,
  });
  const sim = simulate(it, 0);
  assert.ok(sim.ok, sim.reason);
  // Årets gevinst er 60.000 og tabet 100.000, så der skal ikke betales en krone.
  closeTo(sum(sim.months, 'tax'), 0, ØRE, 'tabet dækker hele årets gevinst');
  closeTo(sum(sim.months, 'gross'), 60000, ØRE, 'brutto er lig netto');
  for (const r of sim.months) assert.ok(r.tax >= 0, 'skatten må aldrig være negativ');
});

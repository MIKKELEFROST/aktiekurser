// Søgeindekset til headeren.
//
//   data/soegning.json  – navn, symbol, marked og størrelsesorden for hvert
//                         papir på siden, aktier og fonde i samme fil
//
// Headeren ligger på alle sider, og søgningen skal kunne svare på et tastetryk.
// Aktielisten er 8,8 MB og fondslisten 1,2 MB — de kan ikke hentes for at finde
// et navn. Denne fil bærer kun det søgningen bruger, og rækkerne er arrays i
// stedet for objekter, fordi feltnavne gentaget seks tusind gange fylder mere
// end værdierne.
//
//   [symbol, navn, marked, art, rang, kurs, ændring, valuta]
//
//   art      'a' aktie, 'e' fond
//   rang     plads efter størrelse i sin egen liste — søger man "novo", skal
//            Novo Nordisk stå før et lille selskab med novo i navnet
//   kurs     seneste kurs fra hentningen. Den er timer gammel, men den står
//            i listen med det samme, så rækkerne ikke blinker tomme mens de
//            friske kurser hentes ovenpå
//   ændring  dagens bevægelse i procent, samme forbehold
//
//   node scripts/build-soegeindeks.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STOCKS = resolve(ROOT, 'data/aktier.json');
const FUNDS = resolve(ROOT, 'data/etf.json');
const OUT = resolve(ROOT, 'data/soegning.json');

async function rows(path, key, kind) {
  let list = [];
  try { list = JSON.parse(await readFile(path, 'utf8'))[key] || []; }
  catch { return []; }
  return list
    .filter((r) => r && r.symbol && r.name)
    // Aktierne rangeres i rank_all, fondene i rank. Uden den ville en søgning
    // på "novo" liste selskaberne alfabetisk, og Novo Nordisk ville ligge
    // under et lille selskab med novo i navnet.
    .map((r) => [String(r.symbol), String(r.name), String(r.market || ''), kind,
                 Number(r.rank_all ?? r.rank) || 0,
                 r.price == null ? null : Number(r.price.toFixed(4)),
                 r.percent_change == null ? null : Number(r.percent_change.toFixed(2)),
                 String(r.currency || '')]);
}

async function main() {
  const stocks = await rows(STOCKS, 'stocks', 'a');
  const funds = await rows(FUNDS, 'etfs', 'e');
  if (!stocks.length && !funds.length) {
    console.error('Hverken aktier eller fonde — kør hentningerne først.');
    process.exit(1);
  }

  // En tom eller halveret fil er en fejl i leddet før, ikke en nyhed om
  // markedet. Den der allerede ligger, er rigtig.
  let existing = 0;
  try { existing = (JSON.parse(await readFile(OUT, 'utf8')).items || []).length; } catch { /* første kørsel */ }
  const items = stocks.concat(funds);
  if (existing && items.length < existing * 0.5) {
    console.error(`Kun ${items.length} papirer mod ${existing} i den nuværende fil — skriver ikke.`);
    process.exit(1);
  }

  const body = JSON.stringify({ updated_at: new Date().toISOString(), items }) + '\n';
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, body);
  console.log(`Skrev ${items.length} papirer (${stocks.length} aktier, ${funds.length} fonde), `
    + `${(body.length / 1024).toFixed(0)} KB`);
}

main().catch((err) => { console.error(err); process.exit(1); });

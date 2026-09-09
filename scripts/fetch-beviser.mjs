// Henter de danske investeringsbeviser fra udstederens eget dataendpoint og
// skriver data/investeringsbeviser.json + data/beviser-historik/<SYM>.json.
//
// Kurserne kommer fra Yahoo som for alle andre fonde og hentes af fetch-etf.mjs.
// Det her er alt det, Yahoo ikke har for en dansk investeringsforening — den
// svarer 404 på fundProfile: fordeling på værdipapirtype, brancher, regioner og
// lande, indre værdi, omkostninger, beskatning og links til prospekt og
// årsrapport. Coop Banks egne produktsider henter det fra
//
//   https://funds.coopbank.dk/FundDetailsJSON?ISIN=…
//
// et kald per afdeling. Det er bankens egne tal om bankens egne afdelinger, og
// det er den kilde siderne her siger, de bruger. Endpointet er ikke
// dokumenteret, så hentningen fejler blødt: kan en afdeling ikke hentes,
// beholder den de tal, der allerede står i filen.
//
//   node scripts/fetch-beviser.mjs
//   node scripts/fetch-beviser.mjs --fra=mappe   læs gemte svar i stedet (til prøvekørsel)

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/investeringsbeviser.json');
const OUT_SERIE = resolve(ROOT, 'data/beviser-historik');
// funds.coopbank.dk sender kun sit eget certifikat og ikke mellemleddet.
// Browsere henter det selv via AIA; Node gør ikke, og så fejler kaldet med
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. Mellemcertifikatet ligger derfor her ved
// siden af og lægges til rodcertifikaterne — det er ikke at slå verifikation
// fra, men at levere det led serveren glemmer. Udløber 21. november 2028;
// skal det skiftes, står adressen i certifikatets eget AIA-felt.
const CERT = resolve(ROOT, 'scripts/certs/globalsign-rsa-ov-ssl-ca-2018.pem');

const argv = process.argv.slice(2);
const FRA = (argv.find((a) => a.startsWith('--fra=')) || '').split('=')[1] || '';

const API = 'https://funds.coopbank.dk/FundDetailsJSON?ISIN=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// De oplysninger udstederens dataendpoint ikke har, men produktsiden har:
// afdelingens korte navn, hvordan Coop Bank selv beskriver den, loftet på
// aktier, og den kategori Morningstar sammenligner den i (den står hos Nordnet).
// Ændres de, ændres de her — resten hentes.
const HAAND = {
  'WEICBS.CO': {
    isin: 'DK0060991495',
    kort: 'Stabil',
    profil: 'Lav risikoprofil',
    aktieloft: 35,
    coopbank_url: 'https://www.coopbank.dk/investeringsbeviser/coop-bank-stabil',
    morningstar_kategori: 'Balanceret - EUR Lav Risiko',
    beskrivelse: 'Afdelingen Stabil investerer i en blanding af aktier og obligationer og går efter en '
      + 'global spredning og en lav risikoprofil. Det vil sige en fordeling, hvor aktier og alternative '
      + "investeringer ikke overstiger 35 % af formuen. Afdelingen investerer fortrinsvis i andele i andre "
      + "investeringsforeninger og deres underafdelinger – f.eks. ETF'er.",
  },
  'WEICBB.CO': {
    isin: 'DK0060991578',
    kort: 'Balanceret',
    profil: 'Mellem risikoprofil',
    aktieloft: 60,
    coopbank_url: 'https://www.coopbank.dk/investeringsbeviser/coop-bank-balanceret',
    morningstar_kategori: 'Balanceret - EUR Moderat',
    beskrivelse: 'Afdelingen Balanceret investerer i en blanding af aktier og obligationer og går efter '
      + 'global spredning og en mellem risikoprofil. Det vil sige en fordeling, hvor aktier og alternative '
      + "investeringer ikke overstiger 60 % af formuen. Afdelingen investerer fortrinsvis i andele i andre "
      + "investeringsforeninger og deres underafdelinger – f.eks. ETF'er.",
  },
  'WEICBV.CO': {
    isin: 'DK0060991651',
    kort: 'Vækst',
    profil: 'Høj risikoprofil',
    aktieloft: 85,
    coopbank_url: 'https://www.coopbank.dk/investeringsbeviser/coop-bank-vaekst',
    morningstar_kategori: 'Balanceret - EUR Høj Risiko',
    beskrivelse: 'Afdelingen Vækst investerer i en blanding af aktier og obligationer og går efter global '
      + 'spredning og en høj risikoprofil. Det vil sige en fordeling, hvor aktier og alternative '
      + "investeringer ikke overstiger 85 % af formuen. Afdelingen investerer fortrinsvis i andele i andre "
      + "investeringsforeninger og deres underafdelinger – f.eks. ETF'er.",
  },
};

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? null : round(Number(n) * 100, 4));
const dag = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

// ── Hentning ─────────────────────────────────────────────────────────────
// Node's fetch går uden om HTTPS_PROXY, og https.request kender den heller
// ikke. Kører sessionen bag en proxy, graves tunnelen derfor selv; gør den
// ikke, forbindes direkte. Begge veje verificerer certifikatet.
let ekstraCert = null;

function tunnel(proxy, host, port) {
  return new Promise((ok, fejl) => {
    const p = new URL(proxy);
    const sock = netConnect({ host: p.hostname, port: Number(p.port || 80) }, () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    sock.once('error', fejl);
    sock.once('data', (chunk) => {
      const linje = chunk.toString('latin1').split('\r\n')[0];
      if (/^HTTP\/1\.[01] 2\d\d/.test(linje)) ok(sock);
      else fejl(new Error('proxy afviste tunnelen: ' + linje));
    });
  });
}

async function hentTekst(url) {
  const u = new URL(url);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const socket = proxy ? await tunnel(proxy, u.hostname, 443) : undefined;

  return new Promise((ok, fejl) => {
    const req = httpsRequest({
      host: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': UA, accept: 'application/json' },
      ca: [...rootCertificates, ekstraCert],
      servername: u.hostname,
      ...(socket ? { socket, agent: false } : {}),
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fejl(new Error('HTTP ' + res.statusCode)); }
      let krop = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { krop += d; });
      res.on('end', () => ok(krop));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fejl);
    req.end();
  });
}

async function hentBevis(symbol) {
  const isin = HAAND[symbol].isin;
  if (FRA) return JSON.parse(await readFile(resolve(FRA, isin + '.json'), 'utf8'));
  return JSON.parse(await hentTekst(API + encodeURIComponent(isin)));
}

// ── Udpakning ────────────────────────────────────────────────────────────
// Listerne kommer som { Item: [...] } med Key og Value, og Key er null for den
// del kilden ikke kan henføre — typisk obligationerne, der ikke har en branche.
// Den del bliver til "ikke opdelt" frem for at forsvinde, så summen holder.
function liste(felt, { minimum = 0, navnloest = 'Ikke opdelt' } = {}) {
  const items = felt && felt.Item ? (Array.isArray(felt.Item) ? felt.Item : [felt.Item]) : [];
  const ud = [];
  let rest = 0;
  for (const it of items) {
    const v = Number(it && it.Value);
    if (!Number.isFinite(v) || v <= 0) continue;
    const navn = it.Key == null || String(it.Key).trim() === '' || /^\d+$/.test(String(it.Key))
      ? null : String(it.Key).trim();
    if (navn == null) { rest += v; continue; }
    if (v < minimum) { rest += v; continue; }
    ud.push([navn, round(v, 2)]);
  }
  ud.sort((a, b) => b[1] - a[1]);
  if (rest > 0.005) ud.push([navnloest, round(rest, 2)]);
  return ud;
}

const somObjekt = (par) => Object.fromEntries(par.map(([k, v]) => [k, v]));

function dokument(felt) {
  const it = felt && felt.Item ? (Array.isArray(felt.Item) ? felt.Item[0] : felt.Item) : null;
  return it && it.Value ? String(it.Value) : null;
}

function udpak(symbol, svar) {
  const f = (svar && svar.Entity && svar.Entity.Fund) || null;
  if (!f) throw new Error('intet Fund-objekt i svaret');
  const h = HAAND[symbol];

  const typer = somObjekt(liste(f.AllocationSecurityType));
  const serie = ((svar.Entity.IndexSeries || {}).Item || [])
    .map((p) => [dag(p.Date), Number(p.Values && p.Values.Value)])
    .filter(([d, v]) => d && Number.isFinite(v));

  return {
    bevis: {
      hentet: new Date().toISOString().slice(0, 10),
      kort: h.kort,
      profil: h.profil,
      navn: f.Name || null,
      isin: f.ISIN || h.isin,
      coopbank_url: h.coopbank_url,
      beskrivelse: h.beskrivelse,
      // Prospektets egen formulering. Den er tørrere end produktsidens og
      // siger noget andet — begge dele står, hver med sit navn.
      beskrivelse_prospekt: f.InvestmentProfileLong || null,
      aktieloft: h.aktieloft,
      kategori: f.Category || null,
      morningstar_kategori: h.morningstar_kategori,
      udbyttepolitik: f.FundType || null,
      beskatning: f.TaxSegment || null,
      valuta: f.ISOCurrency || null,
      risiko: f.Risk_SRI != null ? Number(f.Risk_SRI) : null,
      risiko_skala: 7,
      // Løbende omkostninger som de står i prospektet, plus de indirekte
      // handelsomkostninger, som ikke er med i det tal.
      aarlig_omkostning: pct(f.emtv4_07100_Financial_Instrument_Gross_Ongoing_Costs),
      indirekte_handelsomkostninger: pct(f.Indirekte_Handelsomkostninger),
      indre_vaerdi: round(Number(f.LatestNAV), 4),
      indre_vaerdi_dato: dag(f.LatestNAVDate),
      portefoelje_dato: dag(((f.PortfolioDate || {}).Item || {}).Value),
      fordeling: {
        aktier: typer['Aktier'] ?? null,
        obligationer: typer['Obligationer'] ?? null,
        andet: typer['Andet'] ?? null,
        kontanter: typer['Kontanter'] ?? null,
      },
      regioner: liste(f.AllocationRegion),
      brancher: liste(f.AllocationIndustryCode),
      // 108 lande, hvoraf halvdelen er under en promille. Under en halv procent
      // lægges sammen til én linje, så listen kan læses.
      lande: liste(f.AllocationCountry, { minimum: 0.5, navnloest: 'Øvrige lande' }),
      afkast_udsteder: {
        '1m': pct(f.Performance1m), '3m': pct(f.Performance3m), '6m': pct(f.Performance6m),
        ytd: pct(f.PerformanceYTD), '1y': pct(f.Performance1y), '3y': pct(f.Performance3y),
        siden_start: pct(f.PerformanceSinceLaunch),
      },
      dokumenter: {
        prospekt: dokument(f.Prospectus),
        central_information: dokument(f.PRIIPS) || dokument(f.KIID),
        aarsrapport: dokument(f.AnnualReport),
        vedtaegter: dokument(f.FundRules),
      },
    },
    serie,
  };
}

// ── Skrivning ────────────────────────────────────────────────────────────
async function skrivHvisAendret(sti, vaerdi, pænt) {
  const næste = (pænt ? JSON.stringify(vaerdi, null, 2) : JSON.stringify(vaerdi)) + '\n';
  try { if (await readFile(sti, 'utf8') === næste) return false; } catch { /* findes ikke endnu */ }
  await mkdir(dirname(sti), { recursive: true });
  await writeFile(sti, næste);
  return true;
}

async function main() {
  ekstraCert = await readFile(CERT, 'utf8');

  let gammel = null;
  try { gammel = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* første kørsel */ }

  const beviser = {};
  const fejlede = [];
  let hentede = 0;
  let skrevneSerier = 0;

  for (const symbol of Object.keys(HAAND)) {
    try {
      const { bevis, serie } = udpak(symbol, await hentBevis(symbol));
      beviser[symbol] = bevis;
      hentede++;
      if (serie.length > 1) {
        // Serien er udstederens formueudvikling: hvad 100 kr. lagt ind ved
        // afdelingens start ville stå i. Den ender tæt på indre værdi, fordi
        // en andel også startede i 100 — men de er ikke det samme tal, og
        // filen hedder derfor ikke nav.
        const ændret = await skrivHvisAendret(resolve(OUT_SERIE, symbol + '.json'), {
          symbol, isin: bevis.isin, basis: 100, start: serie[0][0],
          opdateret: serie[serie.length - 1][0],
          dates: serie.map((p) => p[0]), index: serie.map((p) => round(p[1], 4)),
        });
        if (ændret) skrevneSerier++;
      }
      console.log(`  ${symbol.padEnd(11)} ${String(bevis.kort).padEnd(11)} `
        + `indre værdi ${bevis.indre_vaerdi} (${bevis.indre_vaerdi_dato}) · `
        + `${serie.length} punkter fra ${serie.length ? serie[0][0] : '–'}`);
    } catch (err) {
      fejlede.push(symbol + ': ' + err.message);
      // Et bevis der ikke kunne hentes beholder det, der allerede stod. Et
      // tomt felt på siden ville ellers ligne en oplysning der ikke findes.
      const før = gammel && gammel.beviser ? gammel.beviser[symbol] : null;
      if (før) beviser[symbol] = før;
    }
  }

  // Gik ingen af kaldene igennem, er der ikke noget nyt at skrive. Den fil der
  // ligger, er stadig rigtig — og en ny dato øverst i den ville påstå, at den
  // var hentet i dag. Den bliver stående som den er.
  if (!hentede) {
    console.error('Ingen af de tre kald gik igennem:');
    for (const f of fejlede) console.error('  ' + f);
    console.error(Object.keys(beviser).length
      ? 'Den nuværende fil er urørt.' : 'Og der er ikke noget at falde tilbage på.');
    process.exit(1);
  }

  const ud = {
    _om: 'Hentet fra udstederens eget dataendpoint, funds.coopbank.dk, af '
      + 'scripts/fetch-beviser.mjs. Kurser og kurshistorik står ikke her — de kommer fra Yahoo '
      + 'som for alle andre fonde. Navn, profil, aktieloft, beskrivelse og Morningstar-kategori '
      + 'står i scriptet; resten kommer fra kaldet.',
    // Hvornår filen sidst blev skrevet. Hvert bevis bærer sin egen hentedato,
    // fordi en afdeling der ikke kunne hentes, beholder de gamle tal.
    opdateret: new Date().toISOString().slice(0, 10),
    kilder: {
      coopbank: {
        navn: 'Coop Bank',
        url: 'https://www.coopbank.dk/investeringsbeviser',
        endpoint: 'https://funds.coopbank.dk/FundDetailsJSON',
        daekker: 'indre værdi, fordeling, regioner, brancher, lande, omkostninger, '
          + 'beskatning, kategori, risikoindikator og dokumenter',
      },
      nordnet: {
        navn: 'Nordnet',
        url: 'https://www.nordnet.dk',
        daekker: 'Morningstar-kategori',
      },
    },
    faelles: {
      forening: 'Investeringsforeningen Coop Opsparing',
      forvalter: 'Wealth Invest',
      boers: 'Nasdaq København',
      valuta: 'DKK',
      regioner_note: 'Regioner, brancher og lande er opgjort på hele porteføljen, altså både '
        + 'aktier og obligationer. Derfor fylder Danmark meget på landelisten: det er de danske '
        + 'obligationer, ikke danske aktier.',
      risiko_note: 'Alle tre står i kategori 3 af 7 på udstederens egen risikoindikator. '
        + 'Risikotallet skiller dem altså ikke ad — det gør aktieandelen og udsvingene.',
      nav_note: 'Indre værdi er afdelingens egen opgørelse af, hvad en andel er værd. Børskursen, '
        + 'som resten af sitet viser, er hvad den sidst blev handlet til, og de to kan ligge lidt '
        + 'ved siden af hinanden.',
      serie_note: 'Den lange kurve er udstederens formueudvikling: hvad 100 kr. lagt ind ved '
        + 'afdelingens start ville stå i i dag.',
      historik_note: 'Udstederens egen serie går tilbage til afdelingens start i 2018. Vores '
        + 'børskurser fra Yahoo begynder i januar 2024.',
    },
    beviser,
  };

  const ændret = await skrivHvisAendret(OUT, ud, true);
  console.log(`${ændret ? 'Skrev' : 'Uændret'} ${OUT.replace(ROOT + '/', '')}`
    + ` · ${Object.keys(beviser).length} beviser`
    + (skrevneSerier ? ` · ${skrevneSerier} serier skrevet` : ' · serier uændrede')
    + (fejlede.length ? ` · ${fejlede.length} fejlede (beholdt forrige tal)` : ''));
  for (const f of fejlede) console.warn('  ' + f);
}

main().catch((err) => { console.error(err); process.exit(1); });

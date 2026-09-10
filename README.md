# Aktiekurser

Statisk site med kurser på **4.502 selskaber** og **1.731 børshandlede fonde**.
Selskaberne er hele Norden (Danmark, Sverige, Norge, Finland, Island) og de fire
amerikanske S&P- og Nasdaq-indeks. Ingen API-nøgle, ingen backend, ingen hemmeligheder
i repoet.

## Sådan virker det

En GitHub Action henter kurserne server-side og committer dem som JSON. Siderne læser
de filer. Det er hele arkitekturen, og det er grunden til at der ikke er brug for en
nøgle: CORS-reglen findes kun i browseren, og Yahoo Finance svarer gerne på et
almindeligt HTTP-kald fra en server, selvom den ikke sender CORS-headers.

| Fil | Rolle |
|---|---|
| `index.html` | Forsiden: indeksene, indgangene til listerne og værktøjerne |
| `markedskurser.html` | Kurslisten med filtre, sortering, valutaskifter og paginering |
| `aktie.html?symbol=…` | Én side per selskab: graf med valgfrit interval, dagens handel, nøgletal, regnskab |
| `etf.html` | Samme liste for fondene |
| `fond.html?symbol=…` | Én side per fond: graf, beholdninger, omkostning, udbytter |
| `inspiration.html` | Temalister og en mest handlede-tabel |
| `sammenlign.html` | Stiller op til seks selskaber op mod hinanden |
| `investeringsbeviser.html` | Coop Banks tre investeringsbeviser: Stabil, Balance og Vækst |
| `beregner.html` | Afkastberegner |
| `assets/` | Fælles CSS og JS — farvetokens, formatering, grafer, navigation, forklaringsbokse |
| `api/kurser.js` | Serverless-funktion: friske kurser på forespørgsel, uden om CORS |
| `api/intradag.js` | Serverless-funktion: dagens forløb minut for minut |
| `scripts/fetch-stocks.mjs` | Henter univers, valutakurs og kurser |
| `scripts/fetch-etf.mjs` | Henter fondene med beholdninger og periodeafkast |
| `scripts/fetch-arkiv.mjs` | Henter den fulde daglige historik |
| `scripts/build-soegeindeks.mjs` | Bygger søgeindekset til headerens søgefelt |
| `.github/workflows/update-stocks.yml` | Kører scriptet på skema |

## Lagerskat mod realisationsskat

`lagerskat.html` sammenligner, hvad en investor har tilbage efter al skat, når det
samme beløb investeres i en lagerbeskattet ETF frem for i aktier, der først beskattes
ved salg. Alt regnes i browseren.

**Siden står uden for navigationen.** Den er ikke med i `NAV`-listen i
`assets/kursliste.js`, og den bærer `noindex, nofollow`. Der er med vilje ingen
`robots.txt`-regel: den ville udstille stien for enhver, der læste filen.

Den er til gengæld ikke længere skjult. `fond.html` linker til den to steder, fordi en
lagerbeskattet fond er netop det sted, spørgsmålet melder sig. En crawler, der læser
fondssiderne, finder den derfor — `noindex` holder den ude af søgeresultaterne, men
adressen er ikke længere hemmelig. Skal den være det igen, skal de to links i
`fond.html` ud.

| Fil | Rolle |
|---|---|
| `lagerskat.html` | Siden: felter, resultater, graf, tabel og forudsætninger |
| `assets/lagerskat.js` | Modellen. Rene funktioner, ingen DOM. JSDoc-typet, ét globalt navn |
| `assets/lagerskat-ui.js` | Brugerfladen. Ingen skatteregler |
| `scripts/lagerskat.test.mjs` | 21 beregningstest, heriblandt modellens kontroltal på kronen |
| `tsconfig.json` | Typekontrol af modellen via `checkJs` — ikke et byggetrin |

```bash
node --test scripts/lagerskat.test.mjs    # beregningerne
npx -p typescript tsc --noEmit            # typerne i modellen
```

Satserne er 2026-satser og holdes konstante gennem hele beregningen. Modellen
forudsiger ikke fremtidige skatteregler og er ikke skatterådgivning.

## Hvad skal jeg lægge til side hver måned?

`pension.html` svarer på ét spørgsmål: hvad skal der lægges til side hver måned, hvis man
har det her i aktier i dag, er så gammel, vil stoppe der, og vil have så meget til
rådighed hver måned bagefter? Depotet simuleres måned for måned gennem både opsparing og
pension: der forrentes, indbetales, og under pensionen sælges der aktier nok til både
forbruget og skatten af salget.

Siden svarer også på de tilstødende spørgsmål: hvad den nødvendige indbetaling bliver ved
andre afkast, og hvornår man tidligst kunne stoppe, hvis man blev ved med den indbetaling
man har i dag.

Der er ingen 4 %-regel. Den er en tommelfingerregel om historiske porteføljer, ikke en
skattemodel, og den kan ikke svare på hvor meget der skal sælges brutto, når salget selv
udløser den skat der skal betales af salget. Bruttobeløbet findes i stedet numerisk for
hver enkelt måned.

**Siden står bevidst uden for navigationen:** ikke i `NAV`-listen, ingen anden side
linker til den, `noindex, nofollow`, ingen `robots.txt`. Til forskel fra
lagerskatberegneren er den stadig uden indgående links og dermed reelt skjult. Det er
skjulthed, ikke adgangskontrol — kender man adressen, er man inde.

| Fil | Rolle |
|---|---|
| `pension.html` | Siden: felter, resultater, graf, årstabel og forudsætninger |
| `assets/pension.js` | Modellen. Rene funktioner, ingen DOM. JSDoc-typet, ét globalt navn |
| `assets/pension-ui.js` | Brugerfladen. Ingen skatteregler |
| `scripts/pension.test.mjs` | 21 beregningstest, heriblandt to kontroltal regnet i hånden |

```bash
node --test scripts/pension.test.mjs      # beregningerne
```

Modellen antager realisationsbeskattede aktier uden udbytte, og at der ikke sælges under
opsparingen. Lagerbeskattede ETF'er, aktiesparekonto og pensionsdepoter følger andre
regler og kan ikke regnes her. Depotet behandles som én samlet beholdning med
forholdsmæssige salg; i virkeligheden opgøres gevinsten pr. aktie.

## Data

| Fil | Indhold |
|---|---|
| `data/univers.json` | De 4.502 selskaber med sektor og indeksmedlemskab |
| `data/aktier.json` | Én række per selskab: kurs, ændring, volumen, 52-ugers interval, børsværdi (4,4 MB) |
| `data/spark.json` | 30-punkts sparklines, én per selskab (792 KB) |
| `data/stats.json` | Bedste og værste dag, stimer, volatilitet, MA50 og MA200 (1,2 MB) |
| `data/nogletal.json` | P/E, udbytte, margin og de øvrige nøgletal (1,9 MB) |
| `data/indeks.json` | Indeksene selv — niveau og udvikling (133 KB) |
| `data/soegning.json` | Søgeindekset bag headerens søgefelt (432 KB) |
| `data/historik/<SYM>.json` | To års daglige lukkekurser, én fil per selskab (~16 KB) |
| `data/arkiv/<SYM>.json` | Hele den daglige historik tilbage til første handelsdag |
| `data/regnskab/<SYM>.json` | Omsætning, overskud og balance per selskab (~10 KB) |
| `data/etf.json` | Én række per fond — kurs, formue, omkostning, periodeafkast (1,3 MB) |
| `data/etf-historik/<SYM>.json` | Tre års daglige kurser, en månedsserie tilbage til start, og fondens udbytter og split |
| `data/etf-detaljer/<SYM>.json` | Hvad fonden ejer: de ti største poster, sektorer, aktivfordeling, kalenderårsafkast (~4 KB) |

Alt der kun bruges ét sted ligger for sig. Historikken, regnskaberne og fondenes
beholdninger er delt op per symbol, så en detaljeside henter sine 16 KB frem for alle
4.500. Rækken i `etf.json` bærer `has_detail`, så en fond uden beholdninger ikke koster
en 404 — tredive nordiske noteringer, kilden ikke fører stamdata på.

`spark.json` og `stats.json` er skåret ud af `aktier.json` efter samme princip, men
opdelt **per feltgruppe frem for per symbol**. Det er med vilje: `aktier.json` ændrer
sig ved hver eneste kørsel, og 4.500 filer tre gange i døgnet ville blive 13.500 nye
blobs om dagen i git. Feltgruppen giver den samme besparelse i browseren uden den pris.
Sparklines hentes kun af kurslisten og temasiderne; statistikken kun når man slår
avanceret visning til. Målt brotli-komprimeret, som Vercel leverer dem:

| Side | Datavægt før | Datavægt nu |
|---|---|---|
| `aktie.html` | 1.067 KB | 659 KB — og 796 KB hvis man åbner avanceret visning |
| `markedskurser.html` | 831 KB | 663 KB |

**Kilder:** Yahoo Finance (kurser), Wikipedia (indeksernes sammensætning),
ECB via Frankfurter (USD/DKK).

## Styling og hoveder

Tailwind er **bygget på forhånd** til `assets/tailwind.css` (12 KB). Før hentede hver
side `cdn.tailwindcss.com` — 126 KB JavaScript, der oversatte klassenavne til CSS i
browseren efter at siden var tegnet. Den er væk, og dermed også det `eval` den krævede.

```bash
node scripts/byg-css.mjs        # efter ændringer i klassenavne
```

Link-tagget står med vilje **sidst i `<head>`**, efter sidens egen `<style>`-blok, fordi
det var præcis der play-CDN'en indsprøjtede sin CSS. Rykker man det op, skifter
kaskaden, og sidens egne regler taber til Tailwinds.

`vercel.json` sætter sikkerhedshovederne på alt: `Content-Security-Policy`,
`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` og
`Cross-Origin-Opener-Policy`. Alt hentes fra samme oprindelse — der er hverken
tredjepartsscript, indlejret ramme eller eksternt billede — så CSP'en er `'self'` hele
vejen rundt, og `connect-src 'self'` afskærer et indsprøjtet script fra at sende data ud
af sitet. Yahoo kaldes kun fra `api/`-funktionerne og fra scripts, som CSP ikke rører.

Undtagelsen er `script-src 'unsafe-inline'` og `style-src 'unsafe-inline'`. Siderne bærer
deres JavaScript inline, og repoet har med vilje intet byggetrin for HTML. Hashes ville
virke, men skulle regnes om ved hver eneste redigering, og glemte man det, ville hver
side dø i produktionen uden at noget fangede det først. Prisen er, at CSP'en ikke stopper
et indsprøjtet inline-script; den stopper til gengæld eval, fremmede scriptkilder,
udsivning af data, klikkapring og `base`-kapring.

## Kørselsplan

Alle tidspunkter er UTC, så de holder på tværs af sommertid.

| Tidspunkt | Hvad |
|---|---|
| Hverdage 07:30 og 11:30 | Kun kurser — én fil ændres |
| Hverdage 16:30 | Også univers og historik, efter lukketid i København |

En kørsel skriver kun filer der faktisk har ændret sig, så en helligdag hvor intet
flytter sig giver ingen commit.

## Kør lokalt

```bash
node scripts/fetch-stocks.mjs                  # alt
node scripts/fetch-stocks.mjs --quotes-only    # genbrug universet
node scripts/fetch-stocks.mjs --limit=20       # hurtigt tjek — rører ikke listerne
node scripts/fetch-etf.mjs                     # fondene med beholdninger
node scripts/byg-css.mjs                       # byg Tailwind efter klasseændringer
python3 -m http.server 8000                    # server siderne
```

## Hvad der bevidst ikke er med

- **Ingen "populære aktier"-liste.** Popularitet måles på hvor mange kunder der ejer
  en aktie hos en konkret bank. Den slags data findes ikke i kilden. "Mest handlede"
  er det nærmeste ægte mål og hedder derfor det.
- **Ingen børsværdi.** Den indgår ikke i svaret, og et beregnet gæt ville være misvisende.
- **Volumen, ikke omsætning.** Feltet er et stykantal, ikke et beløb.
- **Gennemsnitsvolumen er markeret som beregnet.** Kilden opgiver ikke selv et gennemsnit,
  så det er middelværdien af de seneste 60 handelsdage.

Kurserne er **forsinkede, ikke live**, og siderne siger det fire steder.
De udgør ikke investeringsrådgivning.

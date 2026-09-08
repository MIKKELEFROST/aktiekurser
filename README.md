# Aktiekurser

Statisk site med aktiekurser fra **Nasdaq København**, **S&P 500** og **Nasdaq-100** —
542 selskaber i alt. Ingen API-nøgle, ingen backend, ingen hemmeligheder i repoet.

## Sådan virker det

En GitHub Action henter kurserne server-side og committer dem som JSON. Siderne læser
de filer. Det er hele arkitekturen, og det er grunden til at der ikke er brug for en
nøgle: CORS-reglen findes kun i browseren, og Yahoo Finance svarer gerne på et
almindeligt HTTP-kald fra en server, selvom den ikke sender CORS-headers.

| Fil | Rolle |
|---|---|
| `markedskurser.html` | Kurslisten med filtre, sortering, valutaskifter og paginering |
| `aktie.html?symbol=…` | Én side per selskab: graf med valgfrit interval, dagens handel, 52-ugers interval |
| `inspiration.html` | Temalister og en mest handlede-tabel |
| `assets/` | Fælles CSS og JS — farvetokens, formatering, grafer, navigation, forklaringsbokse |
| `scripts/fetch-stocks.mjs` | Henter univers, valutakurs og kurser |
| `.github/workflows/update-stocks.yml` | Kører scriptet på skema |

## Lagerskat mod realisationsskat

`lagerskat.html` sammenligner, hvad en investor har tilbage efter al skat, når det
samme beløb investeres i en lagerbeskattet ETF frem for i aktier, der først beskattes
ved salg. Alt regnes i browseren.

**Siden står bevidst uden for navigationen.** Den er ikke med i `NAV`-listen i
`assets/kursliste.js`, ingen anden side linker til den, og den bærer `noindex, nofollow`.
Man skal kende adressen for at komme derind. Der er med vilje ingen `robots.txt`-regel:
den ville udstille stien for enhver, der læste filen.

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

## Data

| Fil | Indhold |
|---|---|
| `data/univers.json` | De 542 selskaber med sektor og indeksmedlemskab |
| `data/aktier.json` | Én række per selskab plus en 30-punkts sparkline (~600 KB) |
| `data/historik/<SYM>.json` | To års daglige lukkekurser, én fil per selskab (~16 KB) |

Historikken er delt op per selskab, så en detaljeside henter 16 KB frem for alle 542.

**Kilder:** Yahoo Finance (kurser), Wikipedia (indeksernes sammensætning),
ECB via Frankfurter (USD/DKK).

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
node scripts/fetch-stocks.mjs --limit=20       # hurtigt tjek
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

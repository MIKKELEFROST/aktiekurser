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

## Hvornår kan jeg stoppe med at arbejde?

`pension.html` finder den tidligste måned, hvorfra et privat aktiedepot kan betale et
ønsket forbrug efter skat frem til en valgt slutalder. Depotet simuleres måned for måned
gennem både opsparing og pension: der forrentes, indbetales, og under pensionen sælges
der aktier nok til både forbruget og skatten af salget.

Der er ingen 4 %-regel. Den er en tommelfingerregel om historiske porteføljer, ikke en
skattemodel, og den kan ikke svare på hvor meget der skal sælges brutto, når salget selv
udløser den skat der skal betales af salget. Bruttobeløbet findes i stedet numerisk for
hver enkelt måned.

**Siden står bevidst uden for navigationen**, på samme vilkår som lagerskatberegneren:
ikke i `NAV`-listen, ingen andre sider linker til den, `noindex, nofollow`, ingen
`robots.txt`. Det er skjulthed, ikke adgangskontrol — kender man adressen, er man inde.

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
| `data/univers.json` | De 542 selskaber med sektor og indeksmedlemskab |
| `data/aktier.json` | Én række per selskab plus en 30-punkts sparkline (~600 KB) |
| `data/historik/<SYM>.json` | To års daglige lukkekurser, én fil per selskab (~16 KB) |
| `data/etf.json` | Én række per fond — kurs, formue, omkostning, periodeafkast (~1,3 MB) |
| `data/etf-historik/<SYM>.json` | Tre års daglige kurser, en månedsserie tilbage til start, og fondens udbytter og split |
| `data/etf-detaljer/<SYM>.json` | Hvad fonden ejer: de ti største poster, sektorer, aktivfordeling, kalenderårsafkast (~4 KB) |

Historikken er delt op per selskab, så en detaljeside henter 16 KB frem for alle 542.
Det samme gælder fondene: beholdningerne ligger for sig, fordi fondslisten hentes ved
hvert besøg, og de ti største poster kun skal bruges på én fane på én side. Rækken i
`etf.json` bærer `has_detail`, så en fond uden beholdninger ikke koster en 404 —
tredive nordiske noteringer, kilden ikke fører stamdata på.

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

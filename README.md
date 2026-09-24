# SuomiKartta

Selainpohjainen karttasovellus, joka keskittyy Suomeen. Rakennettu
[Leafletillä](https://leafletjs.com/), TypeScriptillä ja [Vitellä](https://vite.dev/).

## Ominaisuudet

- Kartta keskitetty Suomeen, liikkuminen rajattu Suomen ympäristöön
- Taustakartat Maanmittauslaitokselta (taustakartta, maastokartta, selkokartta,
  ilmakuva) sekä OpenStreetMap, valinta kartan vasemmalla puolella olevasta Karttatasot-paneelista (mobiilissa Tasot-painikkeesta)
- Paikannimi- ja osoitehaku Maanmittauslaitoksen hakupalvelulla
- Ilman MML-välityspalvelinta sovellus käyttää OpenStreetMapia, OpenTopoMapia ja
  Nominatim-hakua
- Tieliikenteen tiedot [Digitraffic](https://www.digitraffic.fi/tieliikenne/)-rajapinnasta
  omina tasoinaan (oletuksena pois päältä): auraus- ja kunnossapitoajoneuvot
  (päivittyy minuutin välein), liikennetiedotteet ja tietyöt (2 min), tiesääasemat,
  LAM-pisteet ja kelikamerat (mittaukset ja kuvat haetaan, kun pisteen avaa)
- Säätiedot [Ilmatieteen laitoksen avoimesta datasta](https://www.ilmatieteenlaitos.fi/avoin-data)
  Sää-ryhmässä (oletuksena pois päältä): säävaroitukset värillisinä alueina (5 min),
  sadetutka läpikuultavana kuvana, jonka aika näkyy kartalla ja josta klikkaus
  näyttää sateen voimakkuuden (5 min), sekä viimeisen tunnin salamat, jotka
  haalistuvat iän mukaan (1 min). Jos Ilmatieteen laitos estää selaimen suorat
  haut, Azure-versio hakee ne välityspalvelimen `/api/fmi`-reitin kautta
- Oman sijainnin näyttäminen (◎-painike)
- Klikkaus kartalla näyttää pisteen koordinaatit (WGS84)
- Mittakaava

## Käyttö

Vaatii Node.js 20+.

```sh
npm install
npm run dev        # kehityspalvelin osoitteessa http://localhost:5173
npm run build      # tyyppitarkistus + tuotantoversio kansioon dist/
npm run preview    # tuotantoversion esikatselu
```

## Julkaisu GitHub Pagesiin

`.github/workflows/deploy.yml` kääntää ja julkaisee sovelluksen automaattisesti
aina, kun `main`-haaraan tulee muutoksia. Kertaluonteinen asetus: repositorion
**Settings → Pages → Build and deployment → Source** -kohtaan valitaan
**GitHub Actions**. Sovellus näkyy osoitteessa
https://paanpe.github.io/SuomiKartta/.

## Maanmittauslaitoksen kartat ja API-avain

MML:n rajapinnat vaativat API-avaimen, jota ei saa laittaa selaimeen ladattavaan
sovellukseen. Siksi MML-kartoilla varustettu versio julkaistaan
[Azure Static Web Appsiin](https://learn.microsoft.com/azure/static-web-apps/)
(ilmainen Free-taso). Siellä sama sivusto sisältää `api/`-kansion funktion, joka
pitää avaimen salaisena asetuksena ja välittää karttaruudut ja haut MML:lle:

```
selain  →  https://<sovellus>.azurestaticapps.net/api/tiles/{taso}/{z}/{y}/{x}  →  MML WMTS
selain  →  https://<sovellus>.azurestaticapps.net/api/search?text=...        →  MML geocoding
```

Funktio palvelee vain saman sivuston sivuja ja `ALLOWED_ORIGINS`-listan osoitteita.
Tämä estää muita sivustoja käyttämästä sitä suoraan, mutta ei ole vahva suojaus.
GitHub Pagesin versio jatkaa ilman MML:ää OpenStreetMapin varassa.

### Käyttöönotto (kerran)

1. **API-avain:** rekisteröidy Maanmittauslaitoksen
   [Oma tili -palveluun](https://omatili.maanmittauslaitos.fi/) ja luo API-avain.
2. **Static Web App:** luo Azure-portaalissa *Static Web App*, suunnitelmaksi
   *Free*. Valitse julkaisulähteeksi *Other* (julkaisu tehdään tämän repositorion
   omalla työnkululla).
3. **Asetukset:** Static Web Appin *Settings → Environment variables* -kohtaan
   `MML_API_KEY` = API-avain.
4. **Julkaisu GitHubista:** kopioi Static Web Appin *Overview → Manage deployment
   token* -kohdasta tunnus ja lisää se repositorion salaisuudeksi
   `AZURE_STATIC_WEB_APPS_API_TOKEN` (*Settings → Secrets and variables → Actions*).
   Aja sitten *Deploy to Azure Static Web Apps* -työnkulku Actions-välilehdeltä.
   Jatkossa se ajetaan aina, kun `main`-haara muuttuu.

### Paikallinen kehitys

Tarvitaan [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```sh
cd api
cp local.settings.example.json local.settings.json   # lisää oma API-avain
npm install
npm start                                            # http://localhost:7071/api

# toisessa terminaalissa repositorion juuressa
echo "VITE_MML_PROXY_URL=http://localhost:7071/api" > .env.local
# ja api/local.settings.json: ALLOWED_ORIGINS=http://localhost:5173
npm run dev
```

## Rakenne

```
index.html                  sivun runko (yläpalkki, hakukenttä, karttaelementti)
src/main.ts                 käynnistys
src/config.ts               MML-välityspalvelimen osoite (VITE_MML_PROXY_URL)
src/map.ts                  kartan luonti, taustakartat, sijaintipainike
src/search.ts               paikkahaku (MML tai Nominatim)
src/digitraffic.ts          Digitraffic-tieliikennetasot
src/fmi.ts                  Ilmatieteen laitoksen säätasot
src/style.css               tyylit
api/src/functions/mml.js    MML-välityspalvelin (Static Web Appin funktio)
api/src/functions/fmi.js    Ilmatieteen laitoksen varareitti, jos suora haku estyy
public/staticwebapp.config.json  Static Web Appin asetukset
```

## Huomioita

Maanmittauslaitoksen aineistot ovat
[CC BY 4.0 -lisenssillä](https://www.maanmittauslaitos.fi/avoindata-lisenssi-cc40).
OpenStreetMapin karttaruutu- ja Nominatim-palveluilla on
[käyttöehdot](https://operations.osmfoundation.org/policies/), jotka sopivat vain
kehitykseen ja pieneen käyttöön.
Digitrafficin liikennetiedot ovat Fintrafficin avointa dataa
(CC BY 4.0), eikä niiden käyttö vaadi avainta.
Ilmatieteen laitoksen säätiedot ovat avointa dataa (CC BY 4.0), eikä
niiden käyttö vaadi avainta.

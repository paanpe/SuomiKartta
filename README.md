# SuomiKartta

Selainpohjainen karttasovellus, joka keskittyy Suomeen. Rakennettu
[Leafletillä](https://leafletjs.com/), TypeScriptillä ja [Vitellä](https://vite.dev/).

## Ominaisuudet

- Kartta keskitetty Suomeen, liikkuminen rajattu Suomen ympäristöön
- Taustakartat Maanmittauslaitokselta (taustakartta, maastokartta, selkokartta,
  ilmakuva) sekä OpenStreetMap, valinta oikeasta yläkulmasta
- Paikannimi- ja osoitehaku Maanmittauslaitoksen hakupalvelulla
- Ilman MML-välityspalvelinta sovellus käyttää OpenStreetMapia, OpenTopoMapia ja
  Nominatim-hakua
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

MML:n rajapinnat vaativat API-avaimen. GitHub Pages jakaa vain staattisia
tiedostoja, joten avainta ei laiteta sovellukseen. Sen sijaan `api/`-kansiossa on
Azure Function, joka pitää avaimen salaisena asetuksena ja välittää karttaruudut
ja haut MML:lle:

```
selain  →  https://<sovellus>.azurewebsites.net/api/tiles/{taso}/{z}/{y}/{x}  →  MML WMTS
selain  →  https://<sovellus>.azurewebsites.net/api/search?text=...        →  MML geocoding
```

Välityspalvelin palvelee vain sivuja, joiden osoite on `ALLOWED_ORIGINS`-listassa.
Tämä estää muita sivustoja käyttämästä sitä suoraan, mutta ei ole vahva suojaus.

### Käyttöönotto (kerran)

1. **API-avain:** rekisteröidy Maanmittauslaitoksen
   [Oma tili -palveluun](https://omatili.maanmittauslaitos.fi/) ja luo API-avain.
2. **Function App:** luo Azure-portaalissa Function App: ajoympäristö Node.js 22,
   hosting-suunnitelma *Consumption*. Suunnitelman ilmaisosuus riittää pieneen
   käyttöön.
3. **Asetukset:** Function Appin *Settings → Environment variables* -kohtaan:
   - `MML_API_KEY` = API-avain
   - `ALLOWED_ORIGINS` = `https://paanpe.github.io`

   Älä ota käyttöön Azuren omaa CORS-asetusta, koska funktio hoitaa CORS-otsakkeet itse.
4. **Julkaisu GitHubista:** salli *Configuration → General settings* -kohdassa
   *SCM Basic Auth Publishing Credentials*, lataa Function Appin
   *publish profile* ja lisää se repositorion salaisuudeksi
   (*Settings → Secrets and variables → Actions*):
   - salaisuus `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` = publish profile -tiedoston sisältö
   - muuttuja `AZURE_FUNCTIONAPP_NAME` = Function Appin nimi

   Aja sitten *Deploy MML proxy to Azure Functions* -työnkulku Actions-välilehdeltä.
   Jatkossa se ajetaan aina, kun `api/`-kansio muuttuu `main`-haarassa.
5. **Sovellus käyttöön:** lisää repositorion muuttuja
   `MML_PROXY_URL` = `https://<sovellus>.azurewebsites.net/api` ja aja
   *Deploy to GitHub Pages* uudelleen.

### Paikallinen kehitys

Tarvitaan [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```sh
cd api
cp local.settings.example.json local.settings.json   # lisää oma API-avain
npm install
npm start                                            # http://localhost:7071/api

# toisessa terminaalissa repositorion juuressa
echo "VITE_MML_PROXY_URL=http://localhost:7071/api" > .env.local
npm run dev
```

## Rakenne

```
index.html                  sivun runko (yläpalkki, hakukenttä, karttaelementti)
src/main.ts                 käynnistys
src/config.ts               MML-välityspalvelimen osoite (VITE_MML_PROXY_URL)
src/map.ts                  kartan luonti, taustakartat, sijaintipainike
src/search.ts               paikkahaku (MML tai Nominatim)
src/style.css               tyylit
api/src/functions/mml.js    Azure Function: MML-välityspalvelin
```

## Huomioita

Maanmittauslaitoksen aineistot ovat
[CC BY 4.0 -lisenssillä](https://www.maanmittauslaitos.fi/avoindata-lisenssi-cc40).
OpenStreetMapin karttaruutu- ja Nominatim-palveluilla on
[käyttöehdot](https://operations.osmfoundation.org/policies/), jotka sopivat vain
kehitykseen ja pieneen käyttöön.

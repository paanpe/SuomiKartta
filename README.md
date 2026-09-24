# SuomiKartta

Selainpohjainen karttasovellus, joka keskittyy Suomeen. Rakennettu
[Leafletillä](https://leafletjs.com/), TypeScriptillä ja [Vitellä](https://vite.dev/).

## Ominaisuudet

- Kartta keskitetty Suomeen, liikkuminen rajattu Suomen ympäristöön
- Taustakartat: OpenStreetMap ja OpenTopoMap (maastokartta), valinta oikeasta yläkulmasta
- Paikkahaku (OpenStreetMapin Nominatim-palvelu, rajattu Suomeen)
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

## Rakenne

```
index.html        sivun runko (yläpalkki, hakukenttä, karttaelementti)
src/main.ts       käynnistys
src/map.ts        kartan luonti, taustakartat, sijaintipainike
src/search.ts     paikkahaku Nominatimilla
src/style.css     tyylit
```

## Huomioita

OpenStreetMapin karttaruutu- ja Nominatim-palveluilla on
[käyttöehdot](https://operations.osmfoundation.org/policies/), jotka sopivat
kehitykseen ja pieneen käyttöön. Laajempaan käyttöön kannattaa vaihtaa omaan tai
kaupalliseen palveluun, esim. Maanmittauslaitoksen avoimiin rajapintoihin
(vaatii API-avaimen).

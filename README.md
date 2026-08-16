# Railnav

Streckennummer und Kilometer eingeben — Position auf der Karte sehen und in Google Maps öffnen.

Eine einzelne statische Webseite, kein Server, keine Anmeldung. Läuft auf dem Handy genauso wie
am Rechner und lässt sich als App auf den Startbildschirm legen.

## Was es kann

- **Mehrere Angaben auf einmal** — eine pro Zeile, gemischt aus verschiedenen Strecken.
- **Übersichtskarte direkt in der App** — mit Bahn-Layer (OpenRailwayMap) und Luftbild,
  bevor man überhaupt zu Google Maps wechselt.
- **Zwischenwerte werden interpoliert.** Liegen Kilometersteine bei 12,0 und 13,0, wird für
  km 12,4 zwischen beiden gerechnet — statt einfach den nächsten Stein zu zeigen.
- **Ehrliche Abweichungsanzeige.** Ist für den gesuchten Kilometer nichts erfasst, steht in
  Klartext da, welcher Stein stattdessen genommen wurde und wie weit der daneben liegt.
  Die zugrunde liegende API antwortet im Umkreis von bis zu 10 km — das kann sonst leicht
  übersehen werden.
- **Abschnitte** — `16,0-17,2` zeichnet den Bereich als Linie auf die Karte.
- **Betriebsstellen** — `@Karlsruhe Hbf` findet Bahnhöfe über Name, DS100 oder UIC-Nummer.
- **Export** — Liste kopieren, CSV (Excel-tauglich), GPX für Navigationsgeräte, Link zum Teilen.
- **Offlinefähig** — die App selbst und bereits geladene Kartenkacheln bleiben ohne Netz nutzbar.
- **Eigener Standort** auf der Karte, inklusive grober Rückwärtssuche „welcher Kilometer ist hier?".

## Eingabeformate

| Eingabe | Bedeutung |
| --- | --- |
| `12,5` | Kilometer auf der oben eingetragenen Strecke |
| `5100 12,5` | Streckennummer direkt in der Zeile |
| `14+250` | Hektometer-Schreibweise = km 14,250 |
| `16,0-17,2` | Abschnitt, wird als Linie gezeichnet |
| `12,5 \| Text` | eigene Bezeichnung für den Punkt |
| `@Karlsruhe Hbf` | Betriebsstelle suchen |
| `# Text` | Kommentarzeile, wird übersprungen |

Punkt oder Komma als Dezimaltrennzeichen, beides geht. Füllwörter wie „Strecke" oder „km"
werden ignoriert, `5100; 12,5` und `5100 / 12,5` funktionieren ebenfalls.

`Strg`+`Enter` im Textfeld startet die Suche.

## Datenquelle und Grenzen

Die Positionen stammen aus den in [OpenStreetMap](https://www.openstreetmap.org/) erfassten
Kilometersteinen (`railway=milestone`), abgefragt über die
[OpenRailwayMap-API v2](https://wiki.openstreetmap.org/wiki/OpenRailwayMap/API).

Daraus ergeben sich zwei Dinge, die man wissen sollte:

1. **Die Abdeckung schwankt stark.** Auf manchen Strecken steht alle 100 m ein erfasster Stein,
   auf anderen über viele Kilometer keiner. Ohne passende Nachbarpunkte kann nicht interpoliert
   werden — dann zeigt die App den nächstgelegenen Stein und schreibt die Abweichung dazu.
2. **Interpoliert wird geradlinig.** Zwischen zwei Steinen wird linear gerechnet; im Bogen
   weicht das Ergebnis von der tatsächlichen Gleislage ab. Passt der Luftlinienabstand nicht
   zur Kilometerdifferenz (Kilometersprung, enger Bogen), weist die App darauf hin.

**Das ist keine amtliche Quelle.** Zur groben Verortung im Gelände gut geeignet, nicht für
Vermessung, Disposition oder sicherheitsrelevante Entscheidungen.

## Selbst betreiben

Es reicht, die Dateien auf einen beliebigen Webspace zu legen — es gibt keinen Build-Schritt.

Lokal zum Ausprobieren:

```bash
python -m http.server 8000
```

Dann `http://localhost:8000` öffnen. Über `file://` funktionieren Standortbestimmung und
Offline-Modus nicht, der Rest schon.

Auf GitHub Pages veröffentlichen: in den Repository-Einstellungen unter *Pages* als Quelle
den Branch `main` und den Ordner `/ (root)` wählen.

## Lizenz und Attribution

Code: [MIT](LICENSE).

Karten- und Bahndaten: © OpenStreetMap-Mitwirkende
([ODbL](https://www.openstreetmap.org/copyright)), Bahn-Layer von
[OpenRailwayMap](https://www.openrailwaymap.org/) (CC-BY-SA 2.0), Luftbilder von Esri.
[Leaflet](https://leafletjs.com/) (BSD-2-Clause) liegt unter `vendor/` bei, damit die App
ohne CDN und offline läuft.

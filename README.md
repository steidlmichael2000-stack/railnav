# Railnav

Streckennummer und Kilometer eingeben — Position auf der Karte sehen und in Google Maps öffnen.
Oder umgekehrt: auf die Karte tippen und ablesen, welcher Kilometer das ist.

Eine einzelne statische Webseite, kein Server, keine Anmeldung. Läuft auf dem Handy genauso wie
am Rechner und lässt sich als App auf den Startbildschirm legen.

**→ [steidlmichael2000-stack.github.io/railnav](https://steidlmichael2000-stack.github.io/railnav/)**

## Was es kann

- **Beide Richtungen.** Strecke + km → Position, und Tippen auf die Karte → Strecke + km.
- **Kilometersteine sind sichtbar.** Alle erfassten Steine der Strecke stehen beschriftet auf der
  Karte, verbunden zu einer Linie. Man sieht also, worauf sich die Angabe stützt — und kann einen
  Stein direkt antippen, statt zu interpolieren.
- **Ehrliche Genauigkeitsangabe.** Zu jedem interpolierten Punkt steht dabei, wie weit er
  danebenliegen kann (siehe unten).
- **Karte, Luftbild und Bahn-Layer** umschaltbar, eigener Standort, Link zum Teilen,
  Betriebsstellensuche über Name, DS100 oder UIC.
- **Offlinefähig** — die App selbst und bereits geladene Kartenkacheln bleiben ohne Netz nutzbar.

Eingabe: `12,5` oder `12.5`, auch Hektometer-Schreibweise `14+250` (= km 14,250).
Nur die Streckennummer ohne Kilometer zeigt den Streckenverlauf.

## Wie genau ist das?

Die Positionen stammen aus den in [OpenStreetMap](https://www.openstreetmap.org/) erfassten
Kilometersteinen (`railway=milestone`), abgefragt über die
[OpenRailwayMap-API v2](https://wiki.openstreetmap.org/wiki/OpenRailwayMap/API). Liegt für den
gesuchten Kilometer ein Stein vor, ist die Position so gut wie dessen Erfassung. Sonst wird
zwischen den beiden Nachbarsteinen **geradlinig** interpoliert — und genau da entsteht der Fehler:
im Bogen liegt die Sehne innerhalb des Gleisbogens.

Die Abweichung folgt $s \approx L^2/(8R)$ mit $L$ = Steinabstand und $R$ = Bogenhalbmesser. Statt
$R$ zu raten, wurde der Fehler gemessen: auf zwölf Strecken (1700, 1720, 2200, 2550, 2650, 3600,
4000, 4201, 5100, 5200, 6100, 6340) wurde über **1146 Steinpaare** jeweils ein Stein übersprungen,
über die Lücke interpoliert und mit seiner tatsächlichen Lage verglichen.

| | Abweichung | entspricht R |
| --- | --- | --- |
| Median | $L^2/9700$ | ≈ 1200 m |
| 90. Perzentil | $L^2/2900$ | ≈ 360 m |

In der Praxis:

| Steinabstand | typisch | ungünstige 10 % |
| --- | --- | --- |
| 100 m | 1 m | 3 m |
| 200 m | 4 m | 14 m |
| 500 m | 26 m | 86 m |
| 1000 m | 103 m | 345 m |

**Der Steinabstand entscheidet, nicht die Rechnung.** Wo alle 100–200 m eine Tafel erfasst ist,
liegt man im einstelligen Meterbereich. Wo nur alle 500 m oder 1 km ein Stein steht, kann es im
Bogen dreistellig werden. Die App schreibt den Steinabstand und beide Werte zu jedem Punkt dazu
und warnt, sobald es kritisch wird.

Ein früher eingebauter Schätzer, der den Bogenhalbmesser aus drei benachbarten Steinen berechnet,
wurde wieder entfernt: Er lag in fast der Hälfte der Fälle zu **niedrig**, weil die Streuung der
erfassten Steine bei kurzen Abständen voll durchschlägt. Eine zu optimistische Zahl ist schlimmer
als gar keine.

### Zwei weitere Fallstricke, die die App abfängt

1. **Die API antwortet unsortiert.** Sie liefert Steine im Umkreis von 10 km um die angefragte
   Position und kappt bei `limit`. Mit `limit=1` bekommt man deshalb einen quasi beliebigen Stein
   aus diesem Fenster — für Strecke 5100 km 12,5 etwa den bei km 20,8. Railnav lädt bis zu 200
   Steine und sucht das passende Paar selbst.
2. **Streckennummern tauchen mehrfach auf.** Auf Strecke 4201 liegen Steine, deren Kilometerwerte
   nur 165 m auseinanderliegen, geografisch aber 28 km. Ohne Prüfung würde quer durchs Land
   interpoliert. Railnav verwirft Paare, deren Luftlinie länger ist als die Kilometerdifferenz
   zulässt.

## Grenzen

**Keine amtliche Quelle.** Zur groben Verortung im Gelände gut geeignet, nicht für Vermessung,
Disposition oder sicherheitsrelevante Entscheidungen.

Das Tippen auf die Karte funktioniert ohne Netzabfrage, solange die Strecke schon geladen ist.
Wird weit abseits getippt, muss [Overpass](https://overpass-api.de/) beantworten, welche Strecke
dort liegt — das dauert einige Sekunden, ist aus manchen Netzen gesperrt, und an Knotenbahnhöfen
liegen mehrere Strecken nebeneinander. Dann fragt die App nach, sortiert nach Abstand zum Tippen.

## Selbst betreiben

Es gibt keinen Build-Schritt — die Dateien auf einen beliebigen Webspace legen genügt.
Lokal zum Ausprobieren:

```bash
python -m http.server 8000
```

Über `file://` funktionieren Standortbestimmung und Offline-Modus nicht, der Rest schon.

## Lizenz und Attribution

Code: [MIT](LICENSE).

Karten- und Bahndaten: © OpenStreetMap-Mitwirkende
([ODbL](https://www.openstreetmap.org/copyright)), Bahn-Layer von
[OpenRailwayMap](https://www.openrailwaymap.org/) (CC-BY-SA 2.0), Luftbilder von Esri.
[Leaflet](https://leafletjs.com/) (BSD-2-Clause) liegt unter `vendor/` bei, damit die App
ohne CDN und offline läuft.

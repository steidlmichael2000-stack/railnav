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
- **Gemessene Genauigkeitsangabe.** Zu jedem Punkt steht dabei, wie weit er danebenliegen kann —
  nicht geschätzt, sondern an 1474 Steintripeln nachgemessen (siehe unten).
- **Optional exakt auf dem Gleis.** Stehen die Steine weit auseinander, lässt sich der Punkt auf
  Knopfdruck entlang des tatsächlichen Gleisverlaufs rechnen statt entlang der Luftlinie.
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

Theoretisch beträgt die Abweichung $L^2/(8R)$ mit $L$ = Steinabstand und $R$ = Bogenhalbmesser.
Statt das zu glauben, wurde es gemessen: auf vierzehn Strecken wurde über **1474 Steintripel**
jeweils der mittlere Stein übersprungen, über die Lücke interpoliert und mit seiner tatsächlichen
Lage verglichen — getrennt nach nahezu geraden Abschnitten und engen Bögen.

| Steinabstand | gerade ($R$ > 4000 m) | Bogen ($R$ < 800 m) |
| --- | --- | --- |
| 150–250 m | 10 m / 27 m | 10 m / 24 m |
| 250–400 m | 29 m / 47 m | 27 m / 50 m |
| 400–700 m | 16 m / 43 m | 32 m / 64 m |
| über 700 m | 22 m / 77 m | 40 m / 149 m |

*Median / 90. Perzentil.*

**Der Bogen ist nicht der begrenzende Faktor.** Auf geraden Abschnitten müsste die Interpolation
exakt sein — gemessen werden trotzdem 10–29 m. Was den Fehler dominiert, ist also nicht die
Rechnung, sondern **wie genau die Steine überhaupt in OpenStreetMap sitzen**. Erst ab etwa 700 m
Steinabstand schlägt die Krümmung sichtbar durch (40 m statt 22 m im Median).

Die Zahlen sind eine Obergrenze für den Fehler des Verfahrens: Sie enthalten die Streuung des
Vergleichssteins mit. Umgekehrt heißt das, dass auch ein *exakt* getroffener Kilometerstein nur
auf etwa 10 m genau ist — das ist die Erfassungsgenauigkeit, keine Eigenschaft der App.

Ein zwischenzeitlich eingebauter Schätzer, der $R$ aus drei benachbarten Steinen berechnet, wurde
wieder entfernt: Er hat Rauschen gefittet, lag in fast der Hälfte der Fälle zu **niedrig** und
sagte bei großen Steinabständen absurd hohe Werte voraus. Eine falsche Zahl ist schlimmer als
gar keine.

### Genauer: dem Gleisverlauf folgen

Stehen die Steine weit auseinander, schneidet die Gerade den Bogen ab. Dann bietet die App den
Knopf **„Punkt auf das Gleis rechnen"** an (ab 700 m Steinabstand, darunter bringt es nichts).
Dahinter steckt: Gleisgeometrie über [Overpass](https://overpass-api.de/) holen, aus den
Wegstücken ein Knotennetz bauen, mit Dijkstra den kürzesten Gleisweg zwischen den beiden Steinen
suchen und den Punkt anteilig entlang dieses Wegs setzen — statt entlang der Luftlinie.

Am Beispiel Strecke 5321 km 99,0 (Steine bei km 96,42 und 100,0, 3,1 km Luftlinie):

| | |
| --- | --- |
| geradlinig interpoliert | 375 m neben dem Gleis |
| entlang des Gleises | **0 m**, exakt auf der Achse |
| gefundener Gleisweg | 3549 m gegenüber 3580 m Kilometerdifferenz (99,1 %) |
| Dauer | rund 16 s |

Das Verhältnis von Gleisweg zu Kilometerdifferenz dient gleich als Prüfung: Passt es nicht auf
±20–30 %, wurde das falsche Gleis erwischt und die App lehnt das Ergebnis ab, statt es zu zeigen.

Bewusst **kein Automatismus**: Die Abfrage dauert Sekunden, ist ratenbegrenzt, funktioniert nicht
offline, und bei den üblichen 200 m Steinabstand wäre der Gewinn kleiner als die
Erfassungsgenauigkeit der Steine selbst.

### Interpolieren oder einfach den nächsten Stein zeigen?

Dieselben Daten, andere Frage — für jeden Testpunkt wurde verglichen, wie weit die Interpolation
danebenlag und wie weit der jeweils nächstgelegene Stein entfernt war:

| Steinabstand | interpoliert | nächster Stein | interpoliert besser in |
| --- | --- | --- | --- |
| unter 200 m | 13 m | 22 m | 52 % der Fälle |
| 200–400 m | 26 m | 154 m | 96 % |
| 400–800 m | 19 m | 196 m | 98 % |
| 800–1500 m | 36 m | 233 m | 98 % |
| über 1500 m | 39 m | 581 m | 98 % |

*Median über 1128 Fälle; insgesamt schneidet die Interpolation in 95 % besser ab (23 m gegenüber
176 m).* Interpolieren ist also praktisch immer die bessere Wahl — nur wo ohnehin alle 100 m ein
Stein steht, ist es fast egal. Deshalb interpoliert Railnav grundsätzlich und fällt nur dann auf
den nächstgelegenen Stein zurück, wenn es kein brauchbares Steinpaar gibt.

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

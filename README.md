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
- **Eigene KML- und KMZ-Dateien** öffnen — beliebig viele, jede einzeln ein- und ausschaltbar wie
  in einer Ebenenliste. Sie bleiben auf dem Gerät und sind auch offline wieder da (siehe unten).
- **Eigener WMS-Layer** als Overlay, auch für zugangsgeschützte Dienste (siehe unten).
- **Hintergrund verblassen** — Karte oder Luftbild stufenlos bis auf null, dann bleibt nur der
  Bahn- bzw. WMS-Layer stehen; darunter liegt Weiß, damit schwarze Strichzeichnungen auch im
  Dunkelmodus lesbar bleiben.
- **Karte drehen** mit zwei Fingern; ein Nordknopf erscheint, sobald sie verdreht ist.
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

### Und umgekehrt: Wie genau ist ein Tipp auf die Karte?

Dieselbe Prüfmethode auf die andere Richtung angewandt — über **2060 Steintripel** den mittleren
Stein übersprungen, seine tatsächliche Lage auf die Sehne der beiden Nachbarn projiziert und den
dort abgelesenen Kilometer mit seinem echten verglichen. Das ist genau der Fall „auf das Gleis
getippt", nur mit bekannter Wahrheit:

| Steinabstand | Median | 90. Perzentil |
| --- | --- | --- |
| unter 250 m | 10 m | 33 m |
| 250–700 m | 14 m | 47 m |
| 700–1200 m | 20 m | 57 m |
| 1200–2000 m | 19 m | 56 m |
| 2000–3100 m | 17 m | 60 m |

Zwei Dinge fallen auf: Jenseits von 700 m wächst der Fehler **nicht weiter**, und getrennt nach
Krümmung liegen nahezu gerade Abschnitte bei 14 m / 49 m, ausgeprägte Bögen bei 19 m / 71 m. Die
Sehnennäherung ist hier also kaum schuld — anders als in der Richtung km → Position, wo sie bei
3 km Steinabstand 375 m Fehler machte.

Der Grund ist Geometrie: Beim Tippen steht die Position schon fest, gesucht ist nur der Kilometer.
Entlang eines Kreisbogens verhält sich die Projektion auf die Sehne aber fast proportional zur
Bogenlänge — der Sehnenanteil wächst mit dem Sinus des überstrichenen Winkels, der Bogenanteil mit
dem Winkel selbst, und beide fallen zur Bogenmitte hin zusammen. Übrig bleiben ein paar Meter aus
der Krümmung; der Rest ist die Erfassungsgenauigkeit der Steine.

**Deshalb gibt es in dieser Richtung bewusst keine Feinrechnung entlang des Gleises.** Sie könnte
nur diese wenigen Meter wegnehmen und kostet eine Overpass-Abfrage von 15–40 s. Angezeigt wird
stattdessen die gemessene Zahl: Das Etikett lautet „von der Karte ±57 m", und unter *Herkunft &
Genauigkeit* steht, woher der Wert kommt.

### Zwei weitere Fallstricke, die die App abfängt

1. **Die API antwortet unsortiert.** Sie liefert Steine im Umkreis von 10 km um die angefragte
   Position und kappt bei `limit`. Mit `limit=1` bekommt man deshalb einen quasi beliebigen Stein
   aus diesem Fenster — für Strecke 5100 km 12,5 etwa den bei km 20,8. Railnav lädt bis zu 200
   Steine und sucht das passende Paar selbst.
2. **Streckennummern tauchen mehrfach auf.** Auf Strecke 4201 liegen Steine, deren Kilometerwerte
   nur 165 m auseinanderliegen, geografisch aber 28 km. Ohne Prüfung würde quer durchs Land
   interpoliert. Railnav verwirft Paare, deren Luftlinie länger ist als die Kilometerdifferenz
   zulässt.

## Eigener WMS-Layer

Im Menü lässt sich ein beliebiger WMS als Overlay einblenden — Adresse, Layer-Name und Deckkraft
werden lokal gespeichert. Getestet mit
[TopPlusOpen](https://gdz.bkg.bund.de/index.php/default/wms-topplusopen-wms-topplus-open.html)
des BKG (`https://sgx.geodatenzentrum.de/wms_topplus_open`, Layer `web`).

**Geschützte Dienste** funktionieren, brauchen aber einen Umweg. Die App kann die Zugangsdaten
nicht selbst mitschicken: Dafür müssten die Kacheln per `fetch` mit `Authorization`-Header geholt
werden, und das verlangt CORS-Freigaben, die solche Dienste praktisch nie senden — der Browser
bricht bereits beim Preflight ab. Als Bild geladen entfällt die CORS-Prüfung, und der Browser
hängt von sich aus die Zugangsdaten an, die er für die Domain gespeichert hat.

Deshalb der Knopf **Anmelden**: Er öffnet die GetCapabilities-Adresse in einem neuen Tab, der
Browser fragt Benutzer und Kennwort ab und merkt sie sich. Danach lädt der Layer. Nebenbei sieht
man dort die verfügbaren Layer-Namen und Koordinatensysteme.

Die Zugangsdaten liegen damit im Passwortspeicher des Browsers — verschlüsselt und mit dem
Betriebssystem verzahnt. **Die App kennt sie nicht und speichert sie nicht**, weder im Code noch
im lokalen Speicher.

Voraussetzung ist, dass der Dienst `EPSG:3857` anbietet; andernfalls bräuchte es Proj4Leaflet.
Die Layer-Liste zeigt auch die Maßstabsgrenzen an, falls der Dienst welche angibt — die sind der
häufigste Grund, warum ein Layer beim Zoomen plötzlich verschwindet.

Der Layer selbst bekommt `maxZoom: 22`. Leaflet setzt bei Kachel-Layern standardmäßig 18, wodurch
ein WMS-Overlay beim Hineinzoomen verschwand; ein WMS rendert aber jeden Maßstab auf Anfrage und
hat keine natürliche Obergrenze.

## Eigene KML-Dateien

**KML oder KMZ öffnen** im Menü lädt beliebig viele Dateien vom Gerät. Jede bleibt als Eintrag in
einer Liste stehen und lässt sich einzeln ein- und ausschalten; der farbige Punkt zeigt, in welcher
Farbe sie auf der Karte liegt, die beiden Knöpfe daneben zoomen auf die Datei bzw. nehmen sie aus
der Liste. Ein Tipp auf ein Objekt zeigt Name, Beschreibung und die Felder aus `ExtendedData`, bei
Punkten zusätzlich die Koordinate und einen Link zu Google Maps. Am Rechner geht auch, die Datei
einfach ins Fenster zu ziehen.

Gelesen werden `Point`, `LineString`, `LinearRing`, `Polygon` (auch mit Löchern), `MultiGeometry`
und `gx:Track`, dazu `Style` und `StyleMap` (Zustand *normal*) mit Linienfarbe, Linienstärke und
Flächenfarbe. Ordner werden nicht als eigene Schalter angeboten, der Ordnerpfad steht aber in der
Sprechblase. Nicht unterstützt sind eigene Symbolbilder, `GroundOverlay`, `NetworkLink` und
Modelle. Beschreibungen enthalten oft ganze HTML-Tabellen — übernommen wird nur deren Text, gelesen
über `DOMParser`, damit nichts davon ausgeführt oder nachgeladen wird.

**KMZ ohne Fremdbibliothek.** Ein KMZ ist ein ZIP mit einer KML darin. Gelesen wird das zentrale
Verzeichnis am Dateiende: Nur dort stehen die Größen verlässlich — bei gestreamt geschriebenen ZIPs
sind sie im lokalen Kopf null. Das Aufblasen macht `DecompressionStream('deflate-raw')`, das jeder
aktuelle Browser mitbringt.

**Gespeichert wird in IndexedDB**, nicht in localStorage: Dessen rund 5 MB sprengt schon ein
mittelgroßes KML. Abgelegt wird die ausgewertete Geometrie statt des XML, sodass beim Start nichts
mehr zu parsen ist. Kopfdaten (Name, Farbe, sichtbar) und Geometrie liegen in getrennten Stores —
das Ein- und Ausschalten schreibt damit ein paar Byte statt der ganzen Datei. Die Dateien liegen
auf dem Gerät und sind auch ohne Netz wieder da; hochgeladen wird nichts.

Die Objekte liegen in einer eigenen Leaflet-Pane mit `z-index` 350: über den Kartenkacheln, aber
unter den Kilometersteinen der App. Ein Tipp auf ein KML-Objekt löst die Kilometersuche nicht mit
aus, sondern zeigt nur die Sprechblase.

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

Code: **[GPL-3.0](LICENSE)**.

Das Projekt lag ursprünglich unter MIT. Für die Kartendrehung wird
[leaflet-rotate](https://github.com/Raruto/leaflet-rotate) gebraucht — Leaflet selbst kann nicht
drehen —, und das steht unter GPL-3.0. Weil GPL Copyleft ist, lässt sich ein Werk, das GPL-Code
enthält, nicht unter MIT weitergeben; das ganze Projekt folgt deshalb der GPL-3.0. Praktisch heißt
das: Nutzen, ändern und weitergeben ist frei, wer es weitergibt muss den Quellcode ebenfalls unter
GPL-3.0 offenhalten.

Karten- und Bahndaten: © OpenStreetMap-Mitwirkende
([ODbL](https://www.openstreetmap.org/copyright)), Bahn-Layer von
[OpenRailwayMap](https://www.openrailwaymap.org/) (CC-BY-SA 2.0), Luftbilder von Esri.
Unter `vendor/` liegen [Leaflet](https://leafletjs.com/) (BSD-2-Clause) und
[leaflet-rotate](https://github.com/Raruto/leaflet-rotate) (GPL-3.0) bei, damit die App ohne CDN
und offline läuft.

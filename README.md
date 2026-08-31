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
- **Exakt auf dem Gleis.** Stehen die Steine weit auseinander, wird entlang des tatsächlichen
  Gleisverlaufs gerechnet statt entlang der Luftlinie — in der Richtung km → Position auf
  Knopfdruck, in der Gegenrichtung von selbst, sobald die Steine über 3 km auseinanderstehen und
  die Gerade zwischen ihnen nichts mehr taugt.
- **Karte, Luftbild, DOP20 und Geländerelief** umschaltbar, dazu Bahn-Layer und
  Flurstücksgrenzen als Auflagen, eigener Standort, Link zum Teilen, Betriebsstellensuche über
  Name, DS100 oder UIC.
- **Eigene KML- und KMZ-Dateien** öffnen — beliebig viele, jede einzeln ein- und ausschaltbar wie
  in einer Ebenenliste, mit wählbarer Farbe, wählbarem Symbol und Namen auf der Karte. Sie bleiben
  auf dem Gerät und sind auch offline wieder da (siehe unten).
- **Eigener WMS-Layer** als Overlay, auch für zugangsgeschützte Dienste (siehe unten).
- **Standort dauerhaft verfolgt** — ein Tipp auf den Standortknopf schaltet die Verfolgung ein, der
  Punkt bleibt von allein aktuell. Die Karte fährt dabei nur beim ersten Fix hin und bewegt sich
  danach **nie von selbst**: Beim Zielen und Messen würde eine nachziehende Karte gegen die eigene
  Hand arbeiten. Ein Tipp auf den Knopf holt die Karte zum Standort zurück, der nächste beendet die
  Verfolgung. Darüber erscheint eine Zeile mit der Ortungsgenauigkeit, dem
  Abstand zum letzten Messpunkt und **Entfernung samt Richtungspfeil zum nächsten Objekt der
  geladenen KML-Dateien** — damit lassen sich Punkte im Gelände ablaufen.
- **Messen** — Punkte auf der Karte antippen, die Luftlinie steht als Maßzahl an jedem Abschnitt
  und als Summe in der Leiste. Liegen Anfang und Ende auf der geladenen Strecke, steht die
  Differenz **nach Kilometrierung** daneben; die Abweichung zwischen beiden Zahlen zeigt gleich,
  wie stark es dort krümmt oder wie widersprüchlich die Steine stehen.
- **Hintergrund verblassen** — Karte oder Luftbild stufenlos bis auf null, dann bleibt nur der
  Bahn- bzw. WMS-Layer stehen; darunter liegt Weiß, damit schwarze Strichzeichnungen auch im
  Dunkelmodus lesbar bleiben.
- **Karte drehen** mit zwei Fingern; sobald sie verdreht ist, erscheint links unten ein Kompass,
  dessen Nadel samt N mitdreht und nach Norden zeigt — ein Tipp darauf stellt die Karte gerade.
- **Offlinefähig** — die App selbst und bereits geladene Kartenkacheln bleiben ohne Netz nutzbar.

Eingabe: `12,5` oder `12.5`, auch Hektometer-Schreibweise `14+250` (= km 14,250).
Nur die Streckennummer ohne Kilometer zeigt den Streckenverlauf.

Die Anzeige unten lässt sich über das **×** wieder wegdrücken, und der Fadenkreuz-Knopf auf der
Karte schaltet das Ablesen durch Tippen ganz ab — dann wirft ein versehentlicher Tipp die Anzeige
nicht mehr um. Kilometersteine bleiben antippbar, die trifft man nicht zufällig.

Der Knopf mit dem Lineal darüber schaltet das **Messen** ein. Solange es läuft, setzt jeder Tipp
einen Messpunkt statt einen Kilometer abzulesen. **Kilometersteine und Objekte aus geladenen
KML-Dateien werden dabei gefangen** — bei einem KML-Punkt auf seine genaue Koordinate, bei einer
Linie oder Fläche auf den nächstgelegenen Stützpunkt; die Sprechblase mit den Merkmalen bleibt
solange weg. Gerechnet wird ohne Netzabfrage im Browser; die Länge entlang des Gleises bleibt der
Feinrechnung in der Richtung km → Position vorbehalten.

**Live gemessen wird zur Bildmitte.** Sobald ein Punkt steht, läuft eine gestrichelte Linie vom
letzten Punkt zum Fadenkreuz in der Bildmitte, und die Entfernung steht direkt daneben — beim
Schieben der Karte läuft sie mit, in jedem Bild. So bekommt man eine Entfernung sofort, ohne erst
einen zweiten Punkt zu setzen; **Mitte** friert sie als Abschnitt ein. Die Zahl steht am Fadenkreuz
und damit immer an derselben Stelle des Bildschirms, ruhig zu lesen, während sich die Karte bewegt.
Für „genau 20 m von diesem Punkt" schiebt man also, bis 20 m dasteht.

Der Finger trifft keine 20 cm — deshalb diese beiden Wege statt des Antippens: **Mitte** setzt auf
das Fadenkreuz, **Standort** übernimmt die eigene Position. Läuft die Standortverfolgung, steht der
Abstand vom letzten Messpunkt zum eigenen Standort außerdem in der Zeile oben; im Gelände ist
„genau 20 m" damit eine Laufaufgabe: hingehen, bis die Zahl stimmt.

Gefangen wird nur, was auch in Metern nah liegt (bis 20 m). Der Umkreis von 26 Bildpunkten allein
genügte nicht: Auf Zoomstufe 15 sind das rund 125 m, und bei einer dichten Punktdatei wäre so jeder
Tipp still auf irgendeinen Punkt gesprungen — die Messung um diese Strecke falsch, ohne dass man es
sieht. Weiter entfernte Punkte stehen weiter zur Auswahl, nur nicht automatisch.

**Zoomknöpfe gibt es nicht** — am Rechner zoomt das Mausrad, am Gerät zwei Finger oder ein
Doppeltipp. Der Platz rechts unten gehört den drei eigenen Knöpfen: Messen, Ablesen, Standort.

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

**Die Ausnahme steht nicht in der Tabelle.** 1,6 % der Testfälle lagen über 100 m daneben — und zwar
nicht in Bögen: Der übersprungene Stein lag dort im Median nur 13,6 m von der Sehne entfernt, also auf
gerader Strecke, wo der tatsächliche Gleisverlauf mit der Sehne zusammenfällt. Ihr Kennzeichen ist ein
anderes, nämlich das Verhältnis von Luftlinie zu Kilometerdifferenz: im Median 0,93 gegenüber 0,99 bei
den übrigen. Unterhalb von 0,75 lag das ungünstige Zehntel bei **183 m statt 49 m**. Dahinter stecken
Kilometersprünge und falsch erfasste Steine — nichts, was ein Gleisverlauf reparieren könnte. Genau
diese Prüfung machte die App bisher nur in der Richtung km → Position; jetzt warnt sie auch nach einem
Kartentipp.

Ebenfalls geprüft und verworfen: eine Ausgleichsgerade über ein Fenster von acht Steinen statt der
beiden Nachbarn. Median 15 m gegenüber 14 m, 90. Perzentil 45 m gegenüber 48 m, besser in genau 50 %
der Fälle. Die Streuung der beiden Klammersteine ist also nicht der begrenzende Faktor — was bleibt,
ist die Streuung des Vergleichssteins selbst, mit dem gemessen wird. Die Zahlen der Tabelle sind damit
wie in der anderen Richtung eine Obergrenze und nicht der Fehler des Verfahrens.

**Solange ein Steinpaar da ist, gibt es in dieser Richtung deshalb keine Feinrechnung entlang des
Gleises.** Sie könnte nur diese wenigen Meter wegnehmen und kostet eine Overpass-Abfrage von
15–40 s. Angezeigt wird stattdessen die gemessene Zahl: Das Etikett lautet „von der Karte ±57 m",
und unter *Herkunft & Genauigkeit* steht, woher der Wert kommt.

### Wenn gar kein Steinpaar da ist

Die Tabelle oben endet bei 3,1 km Steinabstand, und das ist kein Zufall: Weiter auseinanderliegende
Steine verbindet die App fürs Zeichnen und Antippen gar nicht erst (`MAX_DRAW_GAP_KM`), weil eine
Gerade über Kilometer unbekannten Verlaufs auf der Karte falsch aussieht und Tipps weit neben dem
echten Gleis an sich zöge. Bisher war damit auch die Kilometersuche zu Ende — obwohl der Punkt
sichtbar neben dem Gleis lag.

Jetzt holt die App in diesem Fall den Gleisverlauf und misst daran entlang, mit demselben Baustein
wie in der Gegenrichtung: Geometrie über Overpass, Knotennetz, kürzester Weg zwischen den beiden
Steinen, anteilige Weglänge statt Sehnenanteil. Der Kilometer heißt dann *entlang des Gleises*.

Nachgemessen wie überall sonst hier — übersprungene Zwischensteine mit bekanntem Kilometer,
Steinabstand 3,0–6,8 km, 13 auswertbare Fälle auf drei Strecken:

| Strecke | Steine | Lücke | Sehne | Gleisweg |
| --- | --- | --- | --- | --- |
| 5321 | km 1,2–7,6 | 6400 m | **114 m** | 19 m |
| 5321 | km 13,8–17,2 | 3400 m | 0 m | 16 m |
| 5321 | km 53–57,6 | 4600 m | 16 m | 6 m |
| 5321 | km 54–58,4 | 4400 m | 20 m | 26 m |
| 5321 | km 58,4–61,4 | 3000 m | 4 m | 21 m |
| 5321 | km 60,2–63,6 | 3400 m | 22 m | 13 m |
| 5321 | km 96,42–100,2 | 3780 m | 39 m | 45 m |
| 5500 | km 23,4–30 | 6600 m | 4 m | 88 m |
| 5741 | km 0,243–3,396 | 3153 m | 75 m | 22 m |
| 5741 | km 2,4–7,8 | 5400 m | **186 m** | 12 m |
| 5741 | km 3,396–10,2 | 6804 m | 93 m | 27 m |
| 5741 | km 10,759–16,18 | 5421 m | 4 m | 23 m |
| 5741 | km 12,6–17,743 | 5143 m | **179 m** | 4 m |

**Im Median nehmen sich beide nichts** — 22 m gegenüber 21 m. Der Unterschied steckt im Schwanz:
Die Sehne lag in **3 von 13 Fällen über 100 m** daneben, bis zu 186 m; der Gleisweg in keinem
einzigen, im schlechtesten Fall 88 m.

Die Sehne ist also nicht durchgehend schlecht: Oft liegt sie ebenfalls unter 25 m, weil der
gesuchte Punkt zufällig nahe der Verbindungslinie liegt. **Man sieht dem Ergebnis aber nicht an,
ob man in diesem Fall steckt oder im 186-Meter-Fall** — und genau deshalb wird gerechnet statt
geschätzt, obwohl der Median dasselbe sagt.

Zwei Testfälle stehen nicht in der Tabelle. Einer wurde von der Wegprüfung abgelehnt (siehe unten).
Beim anderen — Strecke 5500, Vergleichsstein bei km 5,6 zwischen km 5,2 und 10,4 — lagen **beide**
Verfahren um 4,3 km daneben, bei sauberem Weg-zu-Kilometer-Verhältnis von 0,995 und null Abstand
quer zum Gleis. Der Stein selbst passt dort also nicht zur Kilometrierung seiner Nachbarn; das sagt
etwas über die Daten und nichts über das Verfahren.

Die Prüfung Gleisweg gegen Kilometerdifferenz greift auch hier und ist kein Zierrat: In einem der
Testfälle (Strecke 5321, km 9,9–13,7) fand Dijkstra einen 5958 m langen Weg für 3800 m
Kilometerdifferenz — über ein Nachbargleis. Das Ergebnis wäre 579 m danebengelegen; das Verhältnis
1,57 liegt außerhalb von 0,8–1,3, und die App lehnt es ab, statt es zu zeigen.

### Woran die Suche vorher scheiterte

Gemeldet mit einer Koordinate bei Bischofswiesen (47,667669 / 12,944516), 51 m vom Gleis der
Strecke 5741 entfernt: *„Strecke 5741 liegt hier, aber im Umkreis von 900 m ist kein Kilometerstein
erfasst."*

Die Overpass-Abfrage suchte nach `[railway=milestone]` mit dem Tag `railway:position`, und zwar im
Umkreis von 900 m. Was dort tatsächlich steht:

| Abstand | Objekt | Tag | Kilometer |
| --- | --- | --- | --- |
| 596 m | `railway=level_crossing` | `railway:position:exact` | 10,759 |
| 1138 m | `railway=milestone` | `railway:position` | 12,6 |
| 1181 m | `railway=level_crossing` | `railway:position` | 10,2 |

Der nächste brauchbare Wert lag also 596 m entfernt und fiel durch **beide** Maschen zugleich: kein
Stein, und das Tag heißt anders. Der übernächste war ein Stein mit dem richtigen Tag, stand aber
1138 m weit weg. Die Abfrage nimmt jetzt jeden Bahnknoten mit `railway:position` oder
`railway:position:exact` und schaut 4 km weit — der Wert dient ohnehin nur als Startposition für
die ORM-Abfrage, die danach die Steine ringsum liefert. Findet sich auch so nichts, wird die
Strecke selbst abgefragt, statt aufzugeben.

Der gemeldete Punkt löst sich damit in 0,6 s auf: Strecke 5741, km 11,388, 92 m querab der
Verbindungslinie zwischen den Angaben bei km 10,759 und 12,6.

### Zwei weitere Fallstricke, die die App abfängt

1. **Die API antwortet unsortiert.** Sie liefert Steine im Umkreis von 10 km um die angefragte
   Position und kappt bei `limit`. Mit `limit=1` bekommt man deshalb einen quasi beliebigen Stein
   aus diesem Fenster — für Strecke 5100 km 12,5 etwa den bei km 20,8. Railnav lädt bis zu 200
   Steine und sucht das passende Paar selbst.
2. **Streckennummern tauchen mehrfach auf.** Auf Strecke 4201 liegen Steine, deren Kilometerwerte
   nur 165 m auseinanderliegen, geografisch aber 28 km. Ohne Prüfung würde quer durchs Land
   interpoliert. Railnav verwirft Paare, deren Luftlinie länger ist als die Kilometerdifferenz
   zulässt.

## Amtliche bayerische Dienste

Drei offene Dienste der Bayerischen Vermessungsverwaltung sind fest eingebaut, alle unter
**CC BY 4.0** und mit `EPSG:3857`, laufen also ohne Umprojektion in Leaflet:

| Knopf | Dienst | Layer |
| --- | --- | --- |
| **DOP20** | `geoservices.bayern.de/od/wms/dop/v1/dop20` | `by_dop20c` |
| **Relief** | `geoservices.bayern.de/od/wms/dgm/v1/relief` | `by_relief_schraeglicht` |
| **Parzellen** | `geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte` | `by_alkis_parzellarkarte_umr_gelb` / `_umr_schwarz` |

**DOP20** ist das amtliche Orthophoto mit 20 cm Bodenauflösung und damit wesentlich feiner als das
weltweite Esri-Luftbild. **Relief** ist das Schräglicht aus dem Geländemodell — Dämme, Einschnitte
und alte Trassen sind darauf deutlich zu sehen; die ebenfalls angebotene kombinierte Darstellung
wäscht genau diese kleinen Formen weg und ist deshalb nicht eingebaut. Beides deckt nur Bayern ab;
außerhalb antworten die Dienste mit einem leeren Bild und Status 200, also nicht mit einem Fehler,
den man abfangen könnte — die App warnt daher selbst, wenn die Kartenmitte außerhalb liegt.

Bei den Rasterbildern wird **JPEG statt PNG** angefragt: gemessen 13 kB gegenüber 172 kB je Kachel
beim Orthophoto, ohne sichtbaren Unterschied.

Die **Parzellarkarte** liegt als Auflage darüber, aber nur als Umring: Die Farbfassung mit
Nutzungsarten bringt einen deckend weißen Grund mit (gemessen 0 % durchsichtig gegenüber 98 % beim
Umring) und würde alles darunter verdecken. Wer sie braucht, kann sie unter *Eigener WMS-Layer* mit
`by_alkis_parzellarkarte_farbe` laden. Die Umringe sind **gelb über Luftbildern und schwarz über der
Karte**, sonst verschwinden sie jeweils im Untergrund. Der Dienst zeichnet sie erst unterhalb
1:5000, also etwa ab Zoomstufe 17 — davor bleibt die Auflage leer, und die App sagt das beim
Einschalten.

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
einer Liste stehen und lässt sich einzeln ein- und ausschalten; das Symbol links öffnet Farbe und
Form, die beiden Knöpfe rechts zoomen auf die Datei bzw. nehmen sie aus der Liste. Ein Tipp auf ein
Objekt zeigt Name, Beschreibung und die Merkmale, bei Punkten zusätzlich die Koordinate und einen
Link zu Google Maps. Am Rechner geht auch, die Datei einfach ins Fenster zu ziehen. Die Objekte
liegen in einer eigenen Pane über allem anderen, auch über den Kilometersteinen der App.

**Symbole nach Merkmal.** Viele Ausgabeprogramme schreiben ihre Merkmale als Text in die
Beschreibung, etwa `Code: PS2, Marker type: 3`. Besteht eine Zeile vollständig aus solchen
`Schlüssel: Wert`-Stücken, wird sie in Merkmale zerlegt — bewusst streng, damit von einem Fließtext
kein Trümmerfeld übrig bleibt. Danach lassen sich die Symbole **automatisch** unterscheiden: eine
der zehn Formen je Merkmalswert, numerisch sortiert (2 vor 14), mit Legende in der Klappe. Trägt
eine Datei ein Merkmal, dessen Name nach Typ aussieht, ist das beim Öffnen gleich voreingestellt;
sonst liegt alles einheitlich als Kreis. Dieselben Merkmale lassen sich in die Beschriftung
aufnehmen, etwa `5062AA00001 · PS2`.

**Einzelne Merkmalswerte aus- und einblenden.** Unter *Sichtbar* steht jeder Wert des gewählten
Merkmals mit seiner Häufigkeit — ein Tipp nimmt ihn aus der Karte. Aus einer Datei mit 61 Objekten
werden so etwa nur die 36 Neubau-Querungen gezeigt; die Zeile in der Liste sagt dann „59 von 61
Objekten". Ausgeblendetes wird auch nicht beschriftet, nicht beim Messen gefangen und nicht als
nächstes Objekt gemeldet. Der Zustand bleibt gespeichert.

**Namen auf der Karte** erscheinen ab Zoomstufe 16 und höchstens 200 auf einmal, jeweils nur was
im Bild liegt. Ohne diese Grenzen hängen bei einer Datei mit tausend Punkten tausend Textknoten in
der Karte, und lesbar ist davon nichts.

Beschreibungen werden vor dem Auswerten an `<br>` und Absatzenden umgebrochen — `textContent` kennt
kein `<br>`, sonst lief ein ganzer Beschreibungsblock zu einer einzigen Zeile zusammen und die
Merkmale darin waren nicht mehr zu erkennen. Führt eine Datei dieselben Felder in `ExtendedData`
*und* in der Beschreibung, werden sie zusammengelegt; bei gleichem Schlüssel gewinnt der längere
Wert.

Gelesen werden `Point`, `LineString`, `LinearRing`, `Polygon` (auch mit Löchern), `MultiGeometry`
und `gx:Track`, dazu `Style` und `StyleMap` (Zustand *normal*) mit Linienfarbe, Linienstärke und
Flächenfarbe — eine selbst gewählte Farbe hat Vorrang, sonst hätte das Auswählen bei Dateien mit
eigenem Stil keine Wirkung. Ordner werden nicht als eigene Schalter angeboten, der Ordnerpfad steht aber in der
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

Punktsymbole und Namen liegen in einer eigenen Leaflet-Pane über allen Markern, Linien und Flächen
in Leaflets normaler Vektorebene.

### Warum Linien beim Drehen und Zoomen sprangen

Gemeldet als „wenn ich drehe und zoome, verspringt alles — aber nur die Linien". Zutreffend, und die
Ursache liegt nicht bei den KML-Dateien: **leaflet-rotate zieht die SVG-Vektorebene während einer
laufenden Zweifingergeste nicht mit.** Nachgemessen mit einer nachgebauten Geste (Pinch und Drehung
gleichzeitig) und der Bildschirmmatrix des Pfades: Der Endpunkt einer Linie wanderte mitten in der
Geste um bis zu **171 Pixel** und sprang am Ende zurück auf 0. Betroffen sind alle Vektoren gleich —
in einer selbst angelegten Pane genauso wie in Leaflets eigener; Marker und Symbole bleiben ruhig,
weil die einzeln gesetzt werden. Deshalb sah es aus, als sprängen nur die Linien.

Zwei Messfehler von mir haben das lange verdeckt: Erst habe ich bei Linien `_parts` verglichen, also
Leaflets *interne* Rechenpunkte — die stimmen auch dann, wenn der Container falsch transformiert
ist. Dann habe ich die Mitte des Umschließungsrechtecks genommen, und die bleibt bei einer geraden
Strecke selbst dann richtig, wenn die Linie falsch gedreht gezeichnet wird.

Die Abhilfe: Der Renderer wird während der Geste **bei jedem Bild neu gesetzt**, dann bleibt alles
auf 0 Pixel. Das kostet Rechenzeit — gemessen 0,6 ms bei den üblichen Dateien und bei 23 Linien,
2 ms bei 200 Kreisen, aber 14 ms bei einer einzigen Linie mit 5000 Stützpunkten, was bei 60 Bildern
je Sekunde zu viel wäre. Deshalb gilt ein Budget von 2500 Stützpunkten: darunter wird nachgezogen,
darüber die Vektorebene für die Dauer der Geste ausgeblendet und danach einmal neu gesetzt.
Verschwundene Linien irritieren weniger als umherfliegende.

### Kilometer zu einem KML-Objekt

Ein Tipp auf ein KML-Objekt löst die Kilometersuche nicht von selbst aus — sonst würde jeder Blick
in die Merkmale eine Netzabfrage anstoßen. In der Sprechblase steht dafür der Knopf **„Kilometer
bestimmen"**: Bei einem Punkt gilt dessen eigene Koordinate, bei einer Linie oder Fläche die
angetippte Stelle. Gerechnet wird danach genau wie bei einem Tipp auf die Karte, nur mit festem
Fangradius von 80 m statt der zoomabhängigen Fingerbreite — die Koordinate eines gesetzten Punktes
steht ja fest und soll nicht je nach Zoomstufe an eine andere Linie springen.

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

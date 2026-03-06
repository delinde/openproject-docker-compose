# Verfasser-Farben in OpenProject 17 – Technische Beschreibung
## Wie wir Etherpad-Stil-Autorenmarkierung in den kollaborativen Editor eingebaut haben

*Geschrieben für Techniker, die weiterbasteln wollen.*
*Fragen und Antworten sind gemischt – die selbst erfundenen Fragen stehen als eigene Abschnitte.*

---

## 1. Das Ziel: Was soll das eigentlich werden?

Wer Etherpad kennt, kennt das Bild: Mehrere Menschen tippen gleichzeitig in ein Dokument,
und jeder Buchstabe leuchtet in der Farbe seines Verfassers. Man sieht auf einen Blick,
wer welchen Satz geschrieben hat – ohne Hover, ohne Klick, einfach als farbige
Hinterlegung des Textes.

OpenProject 17 hat seit Version 17 einen eingebetteten kollaborativen Texteditor
(basierend auf BlockNote / Tiptap / ProseMirror, synchronisiert über Y.js und Hocuspocus).
Dieser Editor kann mehrere Nutzer gleichzeitig – aber er zeigt nicht, wer was geschrieben hat.

**Das Ziel war:**

- Jeder eingegebene Buchstabe bekommt im Hintergrund die Farbe seines Verfassers
  (semi-transparent, 50 % Deckkraft – damit der Text gut lesbar bleibt)
- Die Farbe bleibt auch nach dem Speichern erhalten, auch nach Seiten-Neuladen
- Die Farbe bleibt korrekt, wenn andere Nutzer davor oder dahinter einfügen
- Wenn zwei Nutzer an der gleichen Stelle schreiben, gibt es keine Farbüberlappungs-Chaos
- Dazu eine kleine Benutzeroberfläche: jeder Nutzer kann sich seine Farbe selbst wählen

---

**F: Warum macht OpenProject das nicht schon von sich aus?**

Gute Frage. Die Antwort ist: Y.js – das Synchronisierungsprotokoll unter der Haube –
kümmert sich ausschließlich um den *Inhalt* des Dokuments. Wer einen Buchstaben
eingetippt hat, ist für Y.js schlicht irrelevant. Y.js ist ein CRDT
(Conflict-free Replicated Data Type): Es garantiert, dass alle Teilnehmer am Ende
denselben Text haben – aber es speichert keine Metadaten über Authorship.

Etherpad hat das von Anfang an eingebaut, weil Etherpad ein eigenes Datenformat
verwendet (Changeset-basiert, mit Autorenfeldern). OpenProject benutzt Y.js,
das einfach anders funktioniert.

---

## 2. Die technische Schichtenarchitektur: Was steckt unter der Haube?

Um zu verstehen, wo wir eingegriffen haben, muss man die Schichten kennen:

```
Benutzeroberfläche (React)
        │
        ▼
  BlockNote Editor   ← React-Komponente, die den Editor rendert
        │
        ▼
  Tiptap             ← "Rahmen" für ProseMirror, kümmert sich um Extensions
        │
        ▼
  ProseMirror        ← der eigentliche Texteditor (State, Transactions, Decorations)
        │
        ▼
  y-prosemirror      ← Brücke zwischen ProseMirror und Y.js
        │
        ▼
  Y.js               ← CRDT-Synchronisierung (das "Gehirn" der Kollaboration)
        │
        ▼
  Hocuspocus         ← Server, der Y.js-Updates zwischen Browsern verteilt
        │
        ▼
  OpenProject-Backend ← stellt Hocuspocus-Authentifizierung bereit
```

Wir haben auf der Ebene **ProseMirror** und **Y.js** eingegriffen –
also tief, aber unterhalb von React und Tiptap.

---

**F: Warum nicht einfach eine Tiptap-Extension schreiben? Das klingt einfacher.**

Tiptap bietet ein sauberes Extension-API. Leider reicht es hier nicht aus.

Eine normale Tiptap-Extension kann Decorations erzeugen – das sind farbige
Hintergründe im Text. Aber sie hat keine Möglichkeit, zuverlässig zu verfolgen,
welcher Textbereich zu welchem Autor gehört, wenn sich das Dokument concurrent ändert.

Das Problem: Textpositionen in ProseMirror sind *absolute Zahlen* (z.B. „Position 327
bis 334"). Wenn jemand davor drei Buchstaben einfügt, sind es plötzlich 330 bis 337.
Man müsste nach jeder Änderung alle gespeicherten Positionen aktualisieren –
was bei concurrent Edits unmöglich korrekt ist.

Die Lösung liegt tiefer: Y.js hat *Relative Positions* – Zeiger, die nicht auf
eine Zahl zeigen, sondern auf ein internes Strukturelement des Y.js-Dokuments.
Dieser Zeiger bleibt korrekt, egal was drumherum passiert. Aber Relative Positions
gibt es nur in Y.js, nicht in ProseMirror. Deshalb mussten wir in beide Ebenen eingreifen.

---

## 3. Was fehlte: Die drei Kernlücken

### Lücke 1: Y.js speichert keine Autoreninfo

Y.js weiß, dass Text eingefügt wurde. Es weiß nicht, wer ihn eingefügt hat.

Es gibt zwar ein Konzept namens *Awareness* in Y.js (damit sieht man z.B. den Cursor
der anderen Nutzer als blinkende Linie), aber Awareness ist flüchtig – sie überlebt
kein Seiten-Neuladen und kein Server-Neustart.

Wir brauchten eine *persistente* Autoreninfo: welche Textstelle gehört welchem Nutzer,
und das auch nach dem nächsten Öffnen des Dokuments.

### Lücke 2: Keine öffentliche API für das, was wir brauchen

Die Brückenbibliothek `y-prosemirror` verbindet Y.js und ProseMirror. Sie exportiert
Hilfsfunktionen für Relative Positions. Aber das interne Objekt, das die Verbindung
verwaltet – das sogenannte `binding` – ist nicht als öffentliche Schnittstelle gedacht.

Wir mussten es trotzdem benutzen. Der Weg führt über den `ySyncPluginKey`:

```typescript
const binding = (ySyncPluginKey as any).getState(state)?.binding;
```

Das `as any` ist kein Programmierfehler – es ist ein bewusster Hinweis:
„Wir benutzen hier etwas Internes, das die Bibliothek eigentlich nicht herausgeben will."

### Lücke 3: ProseMirror hat eine überraschende Render-Reihenfolge

ProseMirror rendert in dieser Reihenfolge:

```
1. Neuer State wird berechnet (apply)
2. Decorations aller Plugins werden gesammelt  ← decorations() läuft hier
3. DOM wird aktualisiert
4. Plugin-Views werden aktualisiert            ← view.update() läuft hier
```

Das bedeutet: Wenn man in `view.update()` Daten aufbereitet und dann eine Dekoration
erzeugen will, ist es zu spät – die Decorations wurden schon abgefragt.

Wir mussten deshalb einen kleinen Umweg gehen: `view.update()` bereitet die Daten auf
und löst dann eine Mini-Transaktion aus (`__authorRebuild`), die ProseMirror zwingt,
`decorations()` noch einmal aufzurufen. Das ist ein bekanntes Muster in der
ProseMirror-Community, aber es ist nicht offensichtlich.

---

**F: Was ist ein „pending range" und warum braucht man das?**

Wenn ich einen Buchstaben tippe, entsteht in ProseMirror eine Transaktion.
In diesem Moment weiß ProseMirror die absolute Position: „Zeichen wurde an Position 42 eingefügt."

Aber `view.update()` – wo wir die Position in eine Y.js Relative Position umwandeln können –
läuft erst *danach*. Und `decorations()` läuft sogar noch davor.

Wir brauchen also eine Zwischenablage: `pending[]`. Dort legen wir die absolute Position
ab, sobald wir die Transaktion sehen. In `decorations()` rendern wir die pending-Ranges
direkt (mit der absoluten Position – riskant, aber für das sofortige visuelle Feedback
akzeptabel). In `view.update()` wandeln wir sie in Relative Positions um und verschieben
sie in den stabilen Cache.

```
Tastendruck
    │
    ▼
apply()  →  pending.push({ from: 42, to: 43, author: 'user-7' })
    │
    ▼
decorations()  →  pending-Ranges direkt rendern (sofortiges Feedback)
    │
    ▼
view.update()  →  pending → RelativePosition → relRangesCache
                  →  in Y.js-Map schreiben (Persistenz)
                  →  __authorRebuild dispatchen
    │
    ▼
decorations()  →  relRangesCache rendern (stabil, concurrent-sicher)
```

---

## 4. Die Y.js-Datenstruktur: Wo leben die Farb-Daten?

Wir haben zwei neue Y.js-Maps angelegt:

```
ydoc.getMap('authorRanges')
  ─ Key:   "user-7_1709123456789_a3f2b"  (eindeutige ID pro Range)
  ─ Value: { authorId: "user-7", relFrom: <RelPos>, relTo: <RelPos> }

ydoc.getMap('authorColors')
  ─ Key:   "user-7"
  ─ Value: "#e03a7f"  (Hex-Farbe, vom Nutzer gewählt)
```

Diese Maps werden von Y.js automatisch synchronisiert – alle Teilnehmer im
selben Dokument sehen dieselben Maps. Und wenn Y.js persistiert wird
(was Hocuspocus unterstützt), überleben sie auch den Server-Neustart.

---

**F: Warum braucht man eine eindeutige ID pro Range und nicht einfach eine Liste?**

Y.js-Maps haben einen wichtigen Vorteil gegenüber Listen: Sie sind merge-freundlich.
Wenn zwei Nutzer gleichzeitig neue Ranges hinzufügen, merged Y.js die Maps automatisch –
jeder Eintrag mit seiner eigenen ID bleibt erhalten. Eine Y.js-Liste würde bei
concurrent Inserts zu Konflikten führen oder unerwartete Reihenfolgen produzieren.

Die eindeutige ID setzt sich zusammen aus: `authorId + Timestamp + 5 zufällige Zeichen`.
Das verhindert Kollisionen auch bei sehr schnellem Tippen.

---

## 5. Das Überlappungsproblem: Wenn zwei Autoren an der gleichen Stelle schreiben

Das war das schwierigste Problem, und es hat mehrere Iterationen gebraucht, bis es gelöst war.

**Das Szenario:**
Autorin Anna schreibt einen langen Satz. Ihr Satz ist als Range `[100, 200]` mit
Annas Farbe gespeichert. Jetzt fügt Bob in der Mitte, bei Position 150, ein Wort ein.

Y.js aktualisiert die Relative Position korrekt: Annas Range dehnt sich automatisch
auf `[100, 207]` aus (Bobs Wort wird in Annas Range eingeschlossen). Das ist das
Y.js-Standardverhalten – Relative Positions folgen dem umgebenden Text.

Gleichzeitig entsteht Bobs eigene Range `[150, 157]` mit Bobs Farbe.

Jetzt haben wir eine Überlappung: Annas Range enthält Bobs Bereich vollständig.
Welche Farbe soll `[150, 157]` haben?

**Die Lösung: „Kleinste Range gewinnt"**

Wir sortieren alle Ranges aufsteigend nach ihrer Größe. Die kleinste Range –
das ist fast immer die jüngste, gerade eingetippte – wird zuerst gerendert.
Größere Ranges werden um die bereits beanspruchten Bereiche „ausgestanzt".

```
Annas Range:  [100 ────────────────────────────── 200]  Größe: 100
Bobs Range:              [150 ──── 157]                  Größe: 7

Sortierung nach Größe (aufsteigend):
  1. Bobs Range [150, 157] → wird gerendert, beansprucht [150, 157]
  2. Annas Range [100, 200] → wird ausgestanzt:
     Segment [100, 150] → gerendert
     Segment [157, 200] → gerendert

Ergebnis:
  [100────150] ANNA  [150──157] BOB  [157─────200] ANNA
```

Diese Regel ist symmetrisch: Beide Bildschirme berechnen dasselbe Ergebnis,
weil die Regel nicht davon abhängt, wer lokal eingeloggt ist.

---

**F: Warum hat das so lange gedauert, diesen Bug zu finden?**

Weil es zwei separate Fehlerquellen gab, die ähnliche Symptome erzeugten:

**Fehlerquelle 1 (pending-Phase):**
In `decorations()` wurden pending-Ranges mit veralteten binding.mapping-Daten
in absolute Positionen umgerechnet. Das `binding.mapping` war noch vom vorherigen
State – y-prosemirror hatte seinen eigenen State noch nicht aktualisiert.
Ergebnis: Die Farbmarkierung zeigte auf das Zeichen *rechts* vom Einfügepunkt,
nicht auf das eingefügte Zeichen selbst.

Lösung: pending-Ranges in `decorations()` nicht über das binding umrechnen,
sondern direkt als absolute Positionen verwenden (sie sind für diesen einen Frame
noch korrekt) und erst in `view.update()` in Relative Positions konvertieren.

**Fehlerquelle 2 (relRangesCache):**
Wenn wir nach dem Schreiben in die Y.js-Map den Observer triggerten,
rief `rebuildFromYMap()` auf, was `relRangesCache` komplett neu aufbaute –
dabei aber die gerade hinzugefügten Ranges erneut übernahm und damit den
Cache doppelt befüllte.

Lösung: `localPersisting`-Flag. Wenn wir selbst in die Y.js-Map schreiben,
ignorieren wir den Observer für genau diesen Augenblick.

---

## 6. Die Dateien, die wir verändert oder neu erstellt haben

### Neue Datei: `AuthorMarkExtension.ts`

```
/opt/op-frontend-build/frontend/src/react/extensions/AuthorMarkExtension.ts
```

Das ist die Hauptarbeit. Ein ProseMirror-Plugin, das:
- lokale Tipp-Transaktionen erkennt und in `pending[]` sammelt
- pending-Ranges sofort als Dekorationen rendert (visuelles Feedback)
- in `view.update()` die Umwandlung in Relative Positions vornimmt
- in die Y.js-Maps schreibt (Persistenz und Synchronisierung)
- Remote-Änderungen über Y.Map-Observer empfängt und den Cache aktualisiert
- in `decorations()` den „kleinste Range gewinnt"-Algorithmus ausführt

### Geänderte Datei: `OpBlockNoteEditor.tsx`

```
/opt/op-frontend-build/frontend/src/react/components/OpBlockNoteEditor.tsx
```

Hier wird der Editor initialisiert. Wir haben hinzugefügt:
- `localUserRef`: ein Ref-Objekt mit `{ id: string, color: string }` für den lokalen Nutzer
- Lesen der Nutzer-ID aus den OpenProject-Userdaten
- `useEffect`: registriert das Plugin nach Editor-Init über `tiptap.registerPlugin()`
- Cleanup: `tiptap.unregisterPlugin(AUTHOR_DECO_KEY)` beim Unmount

### (Optional) Farb-Picker-Komponente

Eine kleine React-Komponente (oder direktes UI-Element), über die Nutzer ihre eigene
Farbe wählen können. Die Wahl wird in `ydoc.getMap('authorColors')` geschrieben –
damit sehen alle anderen Teilnehmer sofort die neue Farbe.

---

**F: Muss man nach jeder Änderung neu bauen? Wie lange dauert das?**

Ja, leider. Der Angular-Build kompiliert TypeScript zu JavaScript und erzeugt
optimierte Bundle-Dateien. Das dauert auf dem Server ca. 10–20 Minuten
(RAM-begrenzt auf 2 GB, damit der Server nicht zusammenbricht).

Wichtig vor dem Build:
```bash
# Worker und Cron stoppen (freier RAM)
docker compose stop worker cron

# Build starten
docker exec -u root openproject-docker-compose-web-1 bash -c \
  "cd /app/frontend && node --max_old_space_size=2048 \
  ./node_modules/@angular/cli/bin/ng build \
  --configuration production --named-chunks --source-map 2>&1"

# Worker und Cron wieder starten
docker compose start worker cron
```

Nach dem Build: Das neue `main-XXXXXXXX.js` (der Hash ändert sich) muss im
Manifest eingetragen werden, dann Web-Container neu starten.

---

**F: Warum ist das `extensions/`-Verzeichnis nicht im Docker-Image?**

OpenProject bringt sein eigenes Image mit, das die Quelldateien des Frontends enthält.
Das `extensions/`-Verzeichnis wurde von uns neu angelegt und ist nicht im Image.

Nach jedem Container-Neustart muss es daher neu erstellt und die Dateien hinein kopiert werden:

```bash
docker exec -u root openproject-docker-compose-web-1 bash -c \
  "mkdir -p /app/frontend/src/react/extensions"

docker cp /opt/op-frontend-build/frontend/src/react/extensions/AuthorMarkExtension.ts \
  openproject-docker-compose-web-1:/app/frontend/src/react/extensions/
```

Das ist ein bekanntes Problem des Ansatzes: Wir patchen in ein fremdes Docker-Image.
Die saubere Lösung wäre ein eigenes Dockerfile, das die Änderungen einbettet.

---

## 7. Was noch fehlen würde: Offene Punkte für Weiterbastler

**Offener Punkt 1: Persistenz auf dem Server**

Derzeit speichert OpenProject das Y.js-Dokument als JSON-Inhalt in der Datenbank –
nicht als vollständigen Y.js-Binary-State. Das bedeutet: Die Y.js-Maps
`authorRanges` und `authorColors` gehen beim Konvertieren verloren.

Hocuspocus unterstützt vollständige Y.js-Persistenz über `@hocuspocus/extension-database`,
aber das müsste entsprechend konfiguriert und mit der Datenbank verbunden werden.

Kurzfristiger Workaround: Solange das Dokument im Server-Memory von Hocuspocus lebt
(d.h. mindestens ein Nutzer hat es geöffnet), bleiben die Maps erhalten.
Nach Timeout (alle Nutzer haben die Seite geschlossen) gehen sie verloren.

**Offener Punkt 2: Bereinigung alter Ranges**

Im Moment wachsen die `authorRanges` unbegrenzt. Gelöschter Text erzeugt Ranges,
die auf leere Positionen zeigen (relativePositionToAbsolutePosition gibt `null` zurück).
Die werden zwar nicht gerendert, aber sie bleiben in der Y.js-Map.

Eine Bereinigungsroutine (z.B. beim Speichern) könnte invalide Ranges entfernen.

**Offener Punkt 3: Farb-Picker-Integration in die OpenProject-UI**

Die Nutzerfarbe wird derzeit über ein einfaches Mittel gesetzt. Eleganter wäre
eine Integration in das Nutzerprofil von OpenProject – jeder Nutzer wählt dort
einmal seine Farbe, und die wird in der Datenbank gespeichert und beim Öffnen
des Editors geladen.

**Offener Punkt 4: Saubere Integration ohne Docker-Patching**

Der saubere Weg wäre: Ein Fork des `openproject` Docker-Images (oder ein eigenes
Dockerfile `FROM openproject/community:17-slim`), das die modifizierten Quelldateien
hinein kopiert und den Build-Schritt ausführt. Dann entfällt das manuelle
`docker cp` nach jedem Neustart.

---

## 8. Für Entwickler: Wie man am Code weiterarbeitet

**Repository der Quelldateien (auf dem Host):**
```
/opt/op-frontend-build/frontend/src/react/
  ├── components/
  │   └── OpBlockNoteEditor.tsx       ← Editor-Initialisierung
  └── extensions/
      └── AuthorMarkExtension.ts      ← das Plugin
```

**Workflow für Änderungen:**

1. Datei auf dem Host bearbeiten (z.B. mit VS Code oder vim)
2. Datei in den laufenden Container kopieren:
   ```bash
   docker cp /opt/op-frontend-build/frontend/src/react/extensions/AuthorMarkExtension.ts \
     openproject-docker-compose-web-1:/app/frontend/src/react/extensions/
   ```
3. Build anstoßen (s.o.)
4. Nach dem Build: Manifest prüfen, ggf. aktualisieren, Container neu starten

**TypeScript-Typen für Y.js:**
```typescript
import type { Map as YMap } from 'yjs';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from 'y-prosemirror';
```

**Der undokumentierte Eingriff (zur Erinnerung):**
```typescript
// Internes binding-Objekt aus y-prosemirror:
const binding = (ySyncPluginKey as any).getState(state)?.binding;
// binding.doc    = das Y.js-Dokument
// binding.type   = der Y.js-Texttyp (YText)
// binding.mapping = aktuelle Positions-Abbildung Y.js ↔ ProseMirror
```

Wenn `y-prosemirror` in einer zukünftigen Version das `binding` umbenennt oder
versteckt, bricht dieser Code. Das ist das Risiko des Ansatzes.

---

*Beschreibung erstellt: 2026-03-04*
*Getestete Konfiguration: OpenProject 17-slim, Hocuspocus 17.1.0, y-prosemirror (aktuelle Version im Image)*

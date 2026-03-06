/*
 * AuthorMark Extension – Etherpad-style author text coloring (v6)
 *
 * STRATEGY: Y.js Relative Positions + Y.Map Persistence + ProseMirror Decorations.
 *
 * Y.js DATENSTRUKTUR:
 *   ydoc.getMap('authorRanges')  → Map<rangeId, {authorId, relFrom, relTo}>
 *   ydoc.getMap('authorColors')  → Map<userId, hexColor>
 *
 * RENDER-REIHENFOLGE (ProseMirror):
 *   1. state = newState
 *   2. viewDecorations() → decorations(state) aller Plugins
 *   3. docView.update()  → DOM-Rendering
 *   4. updatePluginViews() → plugin view.update()
 *
 *   → decorations() läuft VOR view.update(). Daher: pending → relRanges in
 *     view.update(), dann __authorRebuild-Dispatch für frische decorations().
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import type { Map as YMap } from 'yjs';

// ── Typen ──────────────────────────────────────────────────────────────────────

interface LocalUser { id:string; color:string }

interface PendingRange { from:number; to:number; author:string }

interface RelRange {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relFrom:any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relTo:any;
  author:string;
}

// ── Plugin-Key ─────────────────────────────────────────────────────────────────

export const AUTHOR_DECO_KEY = new PluginKey<null>('authorDecorations');

const REBUILD_META = '__authorRebuild';

/** Kompaktierung: ab dieser Anzahl von Y.Map-Einträgen zusammenführen */
const COMPACT_THRESHOLD = 60;
/** Mindestabstand zwischen zwei Kompaktierungen (ms) */
const COMPACT_COOLDOWN_MS = 30_000;

// ── Hilfsfunktion ──────────────────────────────────────────────────────────────

function buildDecos(
  doc:     unknown,
  ranges:  RelRange[],
  binding: unknown,
  colors:  YMap<string> | null,
): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of ranges) {
    try {
      const from = relativePositionToAbsolutePosition(
        (binding as any).doc, (binding as any).type, r.relFrom, (binding as any).mapping,
      );
      const to = relativePositionToAbsolutePosition(
        (binding as any).doc, (binding as any).type, r.relTo, (binding as any).mapping,
      );
      if (from !== null && to !== null && to > from) {
        const baseColor = colors?.get(r.author) ?? '#cccccc';
        // 80 hex ≈ 50 % Deckkraft
        const bg = baseColor.length === 7 ? `${baseColor}80` : `${baseColor}80`;
        decos.push(
          Decoration.inline(from, to, {
            style:         `background-color:${bg};`,
            'data-author': r.author,
          }),
        );
      }
    } catch {
      // Ungültige relative Position – überspringen
    }
  }
  return DecorationSet.create(doc as any, decos);
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createAuthorDecoPlugin(
  getLocalUser:   () => LocalUser | null,
  authorRangesMap: YMap<unknown> | null,
  authorColorsMap: YMap<string>  | null,
): Plugin<null> {

  /** Lokal noch nicht in Y.Map geschriebene Positionen */
  const pending: PendingRange[] = [];
  /** Volatile Cache für die aktuelle decorations()-Berechnung */
  let relRangesCache: RelRange[] = [];
  let dispatching = false;
  /** Verhindert Re-Entrant-Observer-Aufruf bei lokalen Y.Map-Schreibvorgängen */
  let localPersisting = false;
  /** Zeitstempel der letzten Kompaktierung */
  let lastCompactTime = 0;
  /** Verhindert doppeltes Einplanen eines Compact-Timeouts */
  let compactScheduled = false;

  // ── Kompaktierung: läuft vollständig außerhalb des ProseMirror-Zyklus ──────
  // Wird per setTimeout eingeplant (nie synchron in view.update/decorations).
  // Das verhindert Re-Entranz-Probleme mit Y.js-Transaktionen und ProseMirror-
  // Dispatches, die beim synchronen Aufruf zu Darstellungsfehlern führten.
  function runCompact(editorView: any) {
    compactScheduled = false;
    if (!authorRangesMap) return;
    const binding = (ySyncPluginKey as any).getState(editorView.state)?.binding;
    if (!binding || localPersisting || dispatching) return;
    if (authorRangesMap.size <= COMPACT_THRESHOLD) return;

    // Alle Einträge in absolute Positionen auflösen
    type AbsRange = { from: number; to: number; author: string };
    const resolved: AbsRange[] = [];
    authorRangesMap.forEach((entry: any) => {
      try {
        const from = relativePositionToAbsolutePosition(
          (binding as any).doc, (binding as any).type, entry.relFrom, (binding as any).mapping,
        );
        const to = relativePositionToAbsolutePosition(
          (binding as any).doc, (binding as any).type, entry.relTo, (binding as any).mapping,
        );
        if (from !== null && to !== null && to > from) {
          resolved.push({ from, to, author: entry.authorId });
        }
      } catch { /* ungültige Position überspringen */ }
    });

    // Sicherheitscheck: nichts auflösbar → abbrechen, nichts löschen
    if (resolved.length === 0) return;

    // Pro Autor sortieren und überlappende/benachbarte Ranges zusammenführen
    const byAuthor = new Map<string, AbsRange[]>();
    for (const r of resolved) {
      const list = byAuthor.get(r.author) ?? [];
      list.push(r);
      byAuthor.set(r.author, list);
    }

    const merged: AbsRange[] = [];
    for (const [author, ranges] of byAuthor) {
      ranges.sort((a, b) => a.from - b.from);
      let cur = { from: ranges[0].from, to: ranges[0].to, author };
      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i];
        if (r.from <= cur.to + 1) {
          cur.to = Math.max(cur.to, r.to);
        } else {
          merged.push({ ...cur });
          cur = { from: r.from, to: r.to, author };
        }
      }
      merged.push({ ...cur });
    }

    // Zurück zu relativen Positionen
    const newRelRanges: RelRange[] = [];
    for (const r of merged) {
      try {
        const relFrom = absolutePositionToRelativePosition(r.from, (binding as any).type, (binding as any).mapping);
        const relTo   = absolutePositionToRelativePosition(r.to,   (binding as any).type, (binding as any).mapping);
        if (relFrom && relTo) {
          newRelRanges.push({ relFrom, relTo, author: r.author });
        }
      } catch { /* überspringen */ }
    }
    if (newRelRanges.length === 0) return;

    // Atomarer Tausch in Y.js-Transaktion
    localPersisting = true;
    lastCompactTime = Date.now();
    try {
      (binding as any).doc.transact(() => {
        const keys: string[] = [];
        authorRangesMap!.forEach((_: any, key: string) => { keys.push(key); });
        for (const key of keys) { authorRangesMap!.delete(key); }
        const ts = Date.now();
        for (let i = 0; i < newRelRanges.length; i++) {
          const r = newRelRanges[i];
          authorRangesMap!.set(`${r.author}_c${ts}_${i}`, { authorId: r.author, relFrom: r.relFrom, relTo: r.relTo });
        }
      });
      relRangesCache = newRelRanges;
    } finally {
      localPersisting = false;
    }
  }

  /** Kompaktierung einplanen (per setTimeout, außerhalb ProseMirror-Zyklus) */
  function scheduleCompact(editorView: any) {
    if (compactScheduled) return;
    if (!authorRangesMap || authorRangesMap.size <= COMPACT_THRESHOLD) return;
    if (Date.now() - lastCompactTime < COMPACT_COOLDOWN_MS) return;
    compactScheduled = true;
    // 30 s Startup-Delay: Y.js muss vollständig synchronisiert sein
    const delay = Math.max(30_000 - (Date.now() - lastCompactTime), 0);
    setTimeout(() => runCompact(editorView), delay || 100);
  }

  // ── Y.Map-Observer: reagiert auf Remote-Änderungen ────────────────────────
  function rebuildFromYMap(view:any) {
    if (localPersisting) return; // lokale Y.Map-Schreibvorgänge ignorieren
    if (!authorRangesMap) return;
    const binding = (ySyncPluginKey as any).getState(view.state)?.binding;
    if (!binding) return;

    relRangesCache = [];
    authorRangesMap.forEach((entry:any) => {
      try {
        relRangesCache.push({ relFrom: entry.relFrom, relTo: entry.relTo, author: entry.authorId });
      } catch { /* ungültiger Eintrag */ }
    });

    if (!dispatching) {
      dispatching = true;
      try {
        view.dispatch(view.state.tr.setMeta(REBUILD_META, true));
      } finally {
        dispatching = false;
      }
    }
  }

  return new Plugin<null>({
    key: AUTHOR_DECO_KEY,

    state: {
      init(): null { return null; },

      apply(tr): null {
        const isSyncTx  = !!tr.getMeta(ySyncPluginKey);
        const isRebuild = !!tr.getMeta(REBUILD_META);

        if (tr.docChanged && !isSyncTx && !isRebuild) {
          const user = getLocalUser();
          if (user) {
            for (const step of (tr as any).steps) {
              if (!('slice' in step)) continue;
              step.getMap().forEach(
                (_os:number, _oe:number, newStart:number, newEnd:number) => {
                  if (newEnd > newStart) {
                    const last = pending[pending.length - 1];
                    if (last && last.from === newStart && last.to === newEnd && last.author === user.id) return;
                    pending.push({ from: newStart, to: newEnd, author: user.id });
                  }
                },
              );
            }
          }
        }
        return null;
      },
    },

    // HINWEIS: appendTransaction wurde entfernt.
    // Grund: binding.mapping in appendTransaction stammt noch vom alten Zustand
    // (vor y-prosemirror view.update). absolutePositionToRelativePosition()
    // liefert dort Positionen, die um +1 versetzt sind → das Zeichen rechts
    // vom Einfügepunkt wurde gefärbt statt des eingefügten Zeichens.
    // Die Umwandlung erfolgt jetzt ausschließlich in view.update() (nach
    // y-prosemirror-Sync), und decorations() nutzt direkt die pending-Positionen
    // für sofortiges visuelles Feedback.

    view(editorView) {
      // Y.Map-Observer registrieren (Remote-Ranges)
      let observer:(() => void) | null = null;
      if (authorRangesMap) {
        observer = () => rebuildFromYMap(editorView);
        authorRangesMap.observe(observer);
      }

      // Y.Map-Observer für authorColorsMap: Dekorationen neu zeichnen wenn Farben geändert werden (5a)
      let colorObserver:(() => void) | null = null;
      if (authorColorsMap) {
        colorObserver = () => {
          if (!dispatching) {
            dispatching = true;
            try {
              editorView.dispatch(editorView.state.tr.setMeta(REBUILD_META, true));
            } finally {
              dispatching = false;
            }
          }
        };
        authorColorsMap.observe(colorObserver);
      }

      // Beim Start aus Y.Map laden (Persistenz über Seiten-Neuladen)
      setTimeout(() => rebuildFromYMap(editorView), 100);

      return {
        update(view, prevState) {
          if (dispatching) return;

          const binding = (ySyncPluginKey as any).getState(view.state)?.binding;
          if (!binding) {
            pending.length = 0;
            return;
          }

          let converted = 0;
          if (pending.length > 0) {
            // Eigene Farbe in Y.Map initialisieren, falls noch nicht vorhanden.
            // Zu diesem Zeitpunkt ist Y.js bereits synchronisiert (Editor war
            // vorher durch DocumentLoadingSkeleton geblockt) → kein CRDT-Konflikt.
            const localUser = getLocalUser();
            if (localUser && authorColorsMap && !authorColorsMap.has(localUser.id)) {
              authorColorsMap.set(localUser.id, localUser.color);
            }

            const newRelRanges: RelRange[] = [];
            for (const p of [...pending]) {
              try {
                const relFrom = absolutePositionToRelativePosition(p.from, binding.type, binding.mapping);
                const relTo   = absolutePositionToRelativePosition(p.to,   binding.type, binding.mapping);
                if (relFrom && relTo) {
                  newRelRanges.push({ relFrom, relTo, author: p.author });
                  converted++;
                }
              } catch { /* fehlerhaften Eintrag überspringen */ }
            }
            pending.length = 0;
            relRangesCache.push(...newRelRanges);

            // Y.Map-Persistenz: NACH Cache-Update und MIT localPersisting-Guard.
            // Verhindert, dass der Observer relRangesCache leert (rebuildFromYMap)
            // während wir noch schreiben – das war der Auslöser für den +1-Versatz.
            if (authorRangesMap && newRelRanges.length > 0) {
              localPersisting = true;
              try {
                for (const r of newRelRanges) {
                  const rangeId = `${r.author}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                  authorRangesMap.set(rangeId, { authorId: r.author, relFrom: r.relFrom, relTo: r.relTo });
                }
              } finally {
                localPersisting = false;
              }
            }
          }

          // Kompaktierung asynchron einplanen (außerhalb des ProseMirror-Zyklus)
          if (pending.length === 0) scheduleCompact(view);

          const needsRebuild = converted > 0 ||
            (view.state.doc !== prevState.doc && relRangesCache.length > 0);

          if (needsRebuild) {
            dispatching = true;
            try {
              view.dispatch(view.state.tr.setMeta(REBUILD_META, true));
            } catch { /* ignore */ } finally {
              dispatching = false;
            }
          }
        },

        destroy() {
          if (authorRangesMap && observer)    authorRangesMap.unobserve(observer);
          if (authorColorsMap && colorObserver) authorColorsMap.unobserve(colorObserver);
          relRangesCache.length = 0;
          pending.length       = 0;
        },
      };
    },

    props: {
      decorations(state) {
        if (relRangesCache.length === 0 && pending.length === 0) return DecorationSet.empty;
        const binding = (ySyncPluginKey as any).getState(state)?.binding;
        if (!binding) return DecorationSet.empty;
        try {
          const user = getLocalUser();
          const docSize = (state.doc as any).content.size;

          // ── Schritt 1: Alle relRangesCache-Einträge auflösen ─────────────────────
          const allResolved: Array<{ from: number; to: number; author: string }> = [];
          for (const r of relRangesCache) {
            try {
              const from = relativePositionToAbsolutePosition(
                (binding as any).doc, (binding as any).type, r.relFrom, (binding as any).mapping,
              );
              const to = relativePositionToAbsolutePosition(
                (binding as any).doc, (binding as any).type, r.relTo, (binding as any).mapping,
              );
              if (from !== null && to !== null && to > from) {
                allResolved.push({ from, to, author: r.author });
              }
            } catch { /* ungültige Position – überspringen */ }
          }

          // ── Schritt 2: Pending-Ranges (noch nicht in relRangesCache) ─────────────
          const pendingAbs = pending.filter(
            p => p.to > p.from && p.from >= 0 && p.to <= docSize,
          );

          // ── Schritt 3: "Kleinste Range gewinnt" – Auflösung von Überlappungen ────
          //
          // WARUM "kleinste gewinnt"?
          //   Wenn Benutzer A in den Text von Benutzer B einfügt, dehnt sich Bs
          //   Y.js-Range (durch relative Positionierung) auf den neuen Buchstaben aus.
          //   Dadurch überlappen As neue (kleine) Range und Bs alte (große) Range.
          //
          //   Lösung: Die kleinere Range (= spezifischer, gerade getippt) gewinnt
          //   gegenüber der größeren (= Y.js hat sie ausgedehnt). Diese Regel ist
          //   symmetrisch – sie liefert auf BEIDEN Bildschirmen dasselbe Ergebnis,
          //   weil sie nicht vom lokalen Benutzer abhängt.
          //
          //   Pending-Ranges werden als vorrangig initialisiert (Größe ≈ 1 Zeichen,
          //   gewinnen ohnehin, aber explizit vorgezogen um die Pending-Phase
          //   (vor view.update) korrekt abzudecken).
          //
          // Sortierung: aufsteigend nach Größe; gleiche Größe → Autor-ID als Tiebreaker.
          const sortedResolved = [...allResolved].sort((a, b) => {
            const da = a.to - a.from;
            const db = b.to - b.from;
            return da !== db ? da - db : a.author < b.author ? -1 : 1;
          });

          // "Beansprucht"-Liste: Ranges, die bereits eine Farbe bekommen haben.
          // Pending-Ranges vorab eintragen → sie schlagen alle cached Ranges.
          interface Claimed { from: number; to: number; author: string }
          const claimed: Claimed[] = pendingAbs.map(p => ({ from: p.from, to: p.to, author: p.author }));

          const decos: Decoration[] = [];

          for (const r of sortedResolved) {
            const baseColor = authorColorsMap?.get(r.author) ?? '#cccccc';
            const bg = `${baseColor.slice(0, 7)}80`;

            // Nur Beanspruchungen von ANDEREN Autoren ausstanzen
            let segs: Array<{ from: number; to: number }> = [{ from: r.from, to: r.to }];
            for (const c of claimed) {
              if (c.author === r.author) continue;
              segs = segs.flatMap(seg => {
                if (c.to <= seg.from || c.from >= seg.to) return [seg];
                const out: Array<{ from: number; to: number }> = [];
                if (seg.from < c.from) out.push({ from: seg.from, to: c.from });
                if (c.to < seg.to)     out.push({ from: c.to,     to: seg.to });
                return out;
              });
            }

            for (const seg of segs) {
              if (seg.to > seg.from) {
                decos.push(Decoration.inline(seg.from, seg.to, {
                  style:         `background-color:${bg};`,
                  'data-author': r.author,
                }));
              }
            }

            // Eigene Range als beansprucht eintragen (schlägt größere Ranges anderer Autoren)
            claimed.push({ from: r.from, to: r.to, author: r.author });
          }

          // Pending-Dekorationen direkt hinzufügen (bereits über claimed ausgestanzt)
          if (user && pendingAbs.length > 0) {
            const baseColor = authorColorsMap?.get(user.id) ?? user.color;
            const bg = `${baseColor.slice(0, 7)}80`;
            for (const p of pendingAbs) {
              decos.push(Decoration.inline(p.from, p.to, {
                style:         `background-color:${bg};`,
                'data-author': p.author,
              }));
            }
          }

          return DecorationSet.create(state.doc as any, decos);
        } catch {
          return DecorationSet.empty;
        }
      },
    },
  });
}

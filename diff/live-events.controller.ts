/*
 * -- copyright
 * openproject is an open source project management software.
 * copyright (c) the openproject gmbh
 *
 * this program is free software; you can redistribute it and/or
 * modify it under the terms of the gnu general public license version 3.
 *
 * openproject is a fork of chiliproject, which is a fork of redmine. the copyright follows:
 * copyright (c) 2006-2013 jean-philippe lang
 * copyright (c) 2010-2013 the chiliproject team
 *
 * this program is free software; you can redistribute it and/or
 * modify it under the terms of the gnu general public license
 * as published by the free software foundation; either version 2
 * of the license, or (at your option) any later version.
 *
 * this program is distributed in the hope that it will be useful,
 * but without any warranty; without even the implied warranty of
 * merchantability or fitness for a particular purpose.  see the
 * gnu general public license for more details.
 *
 * you should have received a copy of the gnu general public license
 * along with this program; if not, write to the free software
 * foundation, inc., 51 franklin street, fifth floor, boston, ma  02110-1301, usa.
 *
 * see copyright and license files for more details.
 * ++
 */

import iro from '@jaames/iro';
import { HocuspocusProvider, onAwarenessUpdateParameters, onStatelessParameters } from '@hocuspocus/provider';
import * as Turbo from '@hotwired/turbo';
import { LiveCollaborationManager } from 'core-stimulus/helpers/live-collaboration-helpers';
import { ApplicationController, useDebounce } from 'stimulus-use';

interface LiveUser { id:string; name:string; avatarUrl:string; color?:string }

/** Voreingestellte Farbreihenfolge (hellgrün, hellblau, dann weitere Pastellfarben) */
const DEFAULT_COLORS = ['#90ee90', '#add8e6', '#ffb347', '#dda0dd', '#87ceeb', '#f0e68c'];

export default class extends ApplicationController {
  static debounces = ['triggerUpdateUsersUI'];
  static targets = ['users', 'popover', 'colorSwatch', 'colorBadges'];

  declare readonly usersTarget:HTMLElement;
  declare readonly hasUsersTarget:boolean;
  declare readonly popoverTarget:HTMLElement;
  declare readonly colorSwatchTargets:HTMLElement[];
  declare readonly colorBadgesTarget:HTMLElement;
  declare readonly colorBadgesTargets:HTMLElement[];
  declare readonly hasColorBadgesTarget:boolean;

  private provider:HocuspocusProvider|null = null;
  private currentUsers = new Map<number, LiveUser>();
  private userColorOrder:string[] = [];   // userId-Reihenfolge für Farbzuweisung
  private colorPicker:iro.ColorPicker|null = null;
  private activeSwatchUserId:string|null = null;

  // ── Drag-State (F4: verschiebbare Verfasserliste) ──────────────────────────
  private dragState:{ startX:number; startY:number; startLeft:number; startTop:number }|null = null;
  private lastPanelPosition:{ left:number; top:number }|null = null;

  // ── Farbtausch-Zwischenspeicher (F5c) ──────────────────────────────────────
  private previousColors = new Map<string, string>();  // userId → gesicherter Farbwert vor dem Tausch

  // ── F6: Y.Map-Observer für Echtzeit-Badges ────────────────────────────────
  private colorBadgesObserver:(() => void)|null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connect() {
    LiveCollaborationManager.onReady((provider:HocuspocusProvider) => {
      this.provider = provider;
      this.provider.on('awarenessUpdate', this.onAwarenessUpdate);
      this.provider.on('stateless', this.onStateless);

      // F6/F10: authorColors beobachten → Badges + Farbtupfer in der Liste sofort aktualisieren
      const authorColors = LiveCollaborationManager.yjsDocInstance?.getMap<string>('authorColors');
      if (authorColors && !this.colorBadgesObserver) {
        this.colorBadgesObserver = () => {
          this.updateColorBadges();
          // Während der Farbwähler offen ist, KEIN listEl.innerHTML-Rebuild:
          // Der Swatch-Klick auf dem neu erzeugten Element würde den Picker sonst schließen.
          // destroyColorPicker() aktualisiert die Liste nach dem Schließen.
          if (!this.colorPicker) this.updatePanelUserList();
        };
        authorColors.observe(this.colorBadgesObserver);
      }

      // Initiale Farb-Aktualisierung nach Y.js-Sync (gespeicherte Farben laden).
      // setTimeout(0) stellt sicher, dass die Awareness-Daten (currentUsers) schon da sind.
      setTimeout(() => {
        this.updateColorBadges();
        this.updatePanelUserList();
      }, 0);
    });

    useDebounce(this, { wait: 1000 });

    // Klick außerhalb des Controllers schließt Panel + Picker
    document.addEventListener('click', this.onDocumentClick, { capture: true });
  }

  disconnect() {
    this.currentUsers.clear();
    this.provider?.off('awarenessUpdate', this.onAwarenessUpdate);
    this.provider?.off('stateless', this.onStateless);
    this.provider = null;
    this.destroyColorPicker();
    document.removeEventListener('click', this.onDocumentClick, { capture: true });
    document.removeEventListener('mousemove', this.onDragMove);
    const authorColors = LiveCollaborationManager.yjsDocInstance?.getMap<string>('authorColors');
    if (authorColors && this.colorBadgesObserver) authorColors.unobserve(this.colorBadgesObserver);
    this.colorBadgesObserver = null;
  }

  // ── Aktionen (vom ERB aufgerufen) ──────────────────────────────────────────

  toggle_popover(event:Event) {
    event.stopPropagation();
    const isOpen = !this.popoverTarget.classList.contains('d-none');
    this.popoverTarget.classList.toggle('d-none');
    if (isOpen) {
      this.destroyColorPicker();
    } else {
      // Panel gerade geöffnet: positionieren + Benutzerliste aktualisieren
      this.positionPanelNearToggle(event.currentTarget as HTMLElement);
      this.updatePanelUserList();
    }
  }

  openColorPicker(event:Event) {
    event.stopPropagation();
    this._openPickerForSwatch(event.currentTarget as HTMLElement);
  }

  // ── Interne Picker-Logik (auch von Swatch-Delegation aufgerufen) ──────────
  private _openPickerForSwatch(swatch:HTMLElement) {
    const userId = swatch.dataset['userId'] ?? '';

    // Zweiter Klick auf denselben Swatch: Picker schließen
    if (this.activeSwatchUserId === userId) {
      this.destroyColorPicker();
      return;
    }

    // Position und Startfarbe JETZT erfassen – destroyColorPicker → updatePanelUserList
    // ersetzt listEl.innerHTML und detacht den swatch-Node aus dem DOM.
    // Danach liefert getBoundingClientRect() nur noch Nullen (Picker erschiene bei 0/0).
    const swatchRect = swatch.getBoundingClientRect();
    const currentColor = this.colorForUser(userId);

    this.destroyColorPicker();
    this.activeSwatchUserId = userId;

    // Container an document.body hängen – überlebt innerHTML-Rebuilds des Panels.
    const container = document.createElement('div');
    container.id = 'iro-picker-container';
    const pickerWidth = 184;
    const left = Math.min(swatchRect.right + 6, window.innerWidth - pickerWidth - 4);
    const top  = Math.max(4, Math.min(swatchRect.top, window.innerHeight - 260));
    container.style.cssText = [
      'position:fixed',
      'z-index:1000',
      `left:${left}px`,
      `top:${top}px`,
      'background:#fff',
      'border:2px solid #b8a898',
      'border-radius:8px',
      'padding:10px',
      'box-shadow:0 4px 16px rgba(100,80,60,0.2)',
    ].join(';');

    document.body.appendChild(container);

    const picker = iro.ColorPicker(container, {
      width: 160,
      color: currentColor,
      layout: [
        { component: iro.ui.Wheel },
        { component: iro.ui.Slider, options: { sliderType: 'value' } },
      ],
    });
    this.colorPicker = picker;

    picker.on('color:change', (color:iro.Color) => {
      // Swatch im Panel direkt aktualisieren (per userId suchen, da swatch-Ref veralten kann)
      this.popoverTarget.querySelectorAll<HTMLElement>(
        `[data-documents--live-events-target="colorSwatch"][data-user-id="${CSS.escape(userId)}"]`
      ).forEach(s => { s.style.backgroundColor = color.hexString; });
      this.saveUserColor(userId, color.hexString);
    });

    // 5b: Endgültig gewählte Farbe beim Loslassen sicherstellen
    picker.on('input:end', (color:iro.Color) => {
      this.saveUserColor(userId, color.hexString);
    });
  }

  clearSelectionColors(event:Event) {
    event.stopPropagation();
    // Die eigentliche Logik liegt in OpBlockNoteEditor (hat Zugriff auf ProseMirror-View + Y.Map)
    document.dispatchEvent(new CustomEvent('op:decolor-selection'));
  }

  // inviteCollaborator – auskommentiert, kommt später
  // inviteCollaborator(event:Event) {
  //   event.stopPropagation();
  //   const projectLink = document.querySelector<HTMLAnchorElement>('a[href*="/projects/"]');
  //   const match = projectLink?.href.match(/\/projects\/([^/?#]+)/);
  //   if (match) { window.location.href = `/projects/${match[1]}/members/new`; }
  // }

  // 5c: Großen und kleinen Farbtupfer tauschen (Toggle)
  swapColors(event:MouseEvent) {
    event.stopPropagation();
    const btn = event.currentTarget as HTMLElement;
    const userId        = btn.dataset['userId']        ?? '';
    const awarenessColor = btn.dataset['awarenessColor'] ?? '';
    if (!userId || !awarenessColor) return;

    const prevColor = this.previousColors.get(userId);
    if (prevColor) {
      // Zweiter Klick: zurücktauschen
      this.saveUserColor(userId, prevColor);
      this.previousColors.delete(userId);
    } else {
      // Erster Klick: aktuelle Farbe sichern, Awareness-Farbe übernehmen
      this.previousColors.set(userId, this.colorForUser(userId));
      this.saveUserColor(userId, awarenessColor);
    }
    this.updatePanelUserList();
  }

  // 5c: Kleine Farbe (Gegenseite) in die große Farbwahl übernehmen
  adoptRemoteColor(event:MouseEvent) {
    event.stopPropagation();
    const btn = event.currentTarget as HTMLElement;
    const userId     = btn.dataset['userId']    ?? '';
    const remoteColor = btn.dataset['remoteColor'] ?? '';
    if (!userId || !remoteColor) return;

    this.previousColors.delete(userId); // Tausch-Zustand zurücksetzen
    this.saveUserColor(userId, remoteColor);
    this.updatePanelUserList();
  }

  startDrag(event:MouseEvent) {
    event.preventDefault();
    const panel = this.popoverTarget as HTMLElement;
    const rect  = panel.getBoundingClientRect();
    this.dragState = {
      startX:    event.clientX,
      startY:    event.clientY,
      startLeft: rect.left,
      startTop:  rect.top,
    };
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup',   this.onDragEnd, { once: true });
  }

  // ── Private: Drag ──────────────────────────────────────────────────────────

  private onDragMove = (event:MouseEvent) => {
    if (!this.dragState) return;
    const panel   = this.popoverTarget as HTMLElement;
    const dx      = event.clientX - this.dragState.startX;
    const dy      = event.clientY - this.dragState.startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  this.dragState.startLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, this.dragState.startTop  + dy));
    panel.style.left = `${newLeft}px`;
    panel.style.top  = `${newTop}px`;
  };

  private onDragEnd = () => {
    if (this.dragState) {
      const panel = this.popoverTarget as HTMLElement;
      this.lastPanelPosition = {
        left: parseInt(panel.style.left || '0', 10),
        top:  parseInt(panel.style.top  || '0', 10),
      };
    }
    this.dragState = null;
    document.removeEventListener('mousemove', this.onDragMove);
  };

  private positionPanelNearToggle(anchor?: HTMLElement) {
    const panel = this.popoverTarget as HTMLElement;
    if (this.lastPanelPosition) {
      // Letzte Position des Nutzers beibehalten
      panel.style.left = `${this.lastPanelPosition.left}px`;
      panel.style.top  = `${this.lastPanelPosition.top}px`;
      return;
    }
    // Erstmalig: unterhalb des Klick-Ankers positionieren.
    // anchor = das konkrete Element, auf das geklickt wurde (z. B. die Avatar-Zeile
    // oder das Stift-Icon). this.element ist das turbo-frame und hat rect.left=0
    // (volle Seitenbreite) – deshalb NICHT als Fallback verwenden.
    const ref  = anchor ?? this.element;
    const rect = ref.getBoundingClientRect();
    const panelWidth = 280;
    const left = Math.min(rect.left, window.innerWidth - panelWidth - 8);
    panel.style.left = `${Math.max(0, left)}px`;
    panel.style.top  = `${rect.bottom + 6}px`;
  }

  // ── Private: Awareness ─────────────────────────────────────────────────────

  private onAwarenessUpdate = (data:onAwarenessUpdateParameters) => {
    if (data.states.length === 0) return;
    const changed = this.updateUsers(data.states);
    this.persistUserProfiles();
    this.updateColorBadges();
    if (changed) {
      this.triggerUpdateUsersUI();
    }
  };

  private onStateless = (data:onStatelessParameters) => {
    if (data.payload === 'storeEvent') {
      this.fetchTemplate(`${window.location.pathname}/render_last_saved_at`);
    }
  };

  private updateUsers(states:onAwarenessUpdateParameters['states']):boolean {
    const nextState = new Map<number, LiveUser>();
    states.forEach((state, clientId) => {
      if (state.user) {
        const u = state.user as LiveUser;
        // id kommt aus Awareness-JSON als Zahl, auch wenn LiveUser.id als string deklariert ist.
        // Normalisieren auf string, damit Y.Map-Schlüssel (immer string) übereinstimmen.
        nextState.set(clientId, { ...u, id: String(u.id) });
      }
    });
    const prevKeys = [...this.currentUsers.keys()];
    const nextKeys = [...nextState.keys()];
    this.currentUsers = nextState;
    return prevKeys.length !== nextKeys.length || prevKeys.some(id => !nextKeys.includes(id));
  }

  private triggerUpdateUsersUI() {
    // Benutzerliste im Panel und Avatar-Stack im Toggle direkt per JS aufbauen.
    // Kein Turbo-Stream-Umweg: die Verfasserliste kennt bereits alle Verfasser.
    this.updatePanelUserList();
    this.applyColorsToAvatarStack();
  }

  // ── Private: Nutzerprofile in Y.Map sichern (für Offline-Anzeige) ────────────

  private persistUserProfiles() {
    const ydoc = LiveCollaborationManager.yjsDocInstance;
    if (!ydoc) return;
    const authorProfiles = ydoc.getMap<{ name:string; avatarUrl:string }>('authorProfiles');
    for (const user of this.currentUsers.values()) {
      authorProfiles.set(user.id, { name: user.name, avatarUrl: user.avatarUrl ?? '' });
    }
  }

  // ── Private: Panel-Benutzerliste ──────────────────────────────────────────

  private updatePanelUserList() {
    const listEl = this.popoverTarget.querySelector<HTMLElement>('#live-users-list');
    if (!listEl) return;

    const ydoc         = LiveCollaborationManager.yjsDocInstance;
    const authorColors  = ydoc?.getMap<string>('authorColors');
    const authorProfiles = ydoc?.getMap<{ name:string; avatarUrl:string }>('authorProfiles');
    const authorRanges   = ydoc?.getMap<any>('authorRanges');

    // Deduplizieren nach user.id (ein Benutzer kann mehrere clientIds haben)
    const onlineMap = new Map<string, LiveUser>(
      [...this.currentUsers.values()].map(u => [u.id, u])
    );

    // Alle Verfasser-IDs aus authorRanges sammeln (auch offline)
    const offlineIds = new Set<string>();
    if (authorRanges) {
      authorRanges.forEach((entry:any) => {
        const id = String(entry.authorId ?? '');
        if (id && !onlineMap.has(id)) offlineIds.add(id);
      });
    }

    if (onlineMap.size === 0 && offlineIds.size === 0) return;

    // Reihenfolge für Farbzuweisung pflegen
    for (const id of [...onlineMap.keys(), ...offlineIds]) {
      if (!this.userColorOrder.includes(id)) this.userColorOrder.push(id);
    }

    this.updateColorBadges();

    const parts: string[] = [];
    // Online-Nutzer zuerst
    for (const [userId, user] of onlineMap) {
      parts.push(this.renderUserRow(userId, user.name, user.avatarUrl ?? '', user.color ?? null, true, authorColors));
    }
    // Offline-Verfasser (Profil aus Y.Map)
    for (const userId of offlineIds) {
      const profile = authorProfiles?.get(userId);
      if (!profile?.name) continue;
      parts.push(this.renderUserRow(userId, profile.name, profile.avatarUrl ?? '', null, false, authorColors));
    }

    listEl.innerHTML = parts.join('');
  }

  private renderUserRow(
    userId:         string,
    name:           string,
    avatarUrl:      string,
    awarenessColor: string | null,
    isOnline:       boolean,
    authorColors:   { get:(k:string) => string|undefined } | null | undefined,
  ): string {
    const localColor = this.colorForUser(userId, authorColors);
    const smallColor = this.previousColors.get(userId) ?? awarenessColor;

    const avatarHtml = avatarUrl
      ? `<img src="${esc(avatarUrl)}" alt="${esc(name)}"
              style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;"
              onerror="this.style.display='none'">`
      : `<span style="width:24px;height:24px;border-radius:50%;background:#ccc;display:inline-flex;
                       align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">
           ${esc(name.charAt(0).toUpperCase())}
         </span>`;

    // Grüner / grauer Online-Punkt
    const dot = `<span style="position:absolute;bottom:0;right:0;width:7px;height:7px;
      border-radius:50%;background:${isOnline ? '#27ae60' : '#bbb'};border:1px solid #fff;"></span>`;

    return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:8px;">
      <div style="position:relative;flex-shrink:0;">${avatarHtml}${dot}</div>
      <span style="flex:1;font-size:13px;color:${isOnline ? '#444' : '#999'};
                   white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</span>
      <span
        title="Texthervorhebungsfarbe ändern"
        style="display:inline-block;width:22px;height:22px;border-radius:4px;
               background:${esc(localColor)};cursor:pointer;border:1px solid #bbb;flex-shrink:0;"
        data-documents--live-events-target="colorSwatch"
        data-user-id="${esc(userId)}"
        data-action="click->documents--live-events#openColorPicker"
      ></span>
    </div>`;
  }

  private colorForUser(userId:string, authorColors?:{ get:(k:string)=>string|undefined }|null):string {
    const ydoc = LiveCollaborationManager.yjsDocInstance;
    const map = authorColors ?? ydoc?.getMap<string>('authorColors');
    const stored = map?.get(userId);
    if (stored) return stored;
    const idx = this.userColorOrder.indexOf(userId);
    return DEFAULT_COLORS[idx >= 0 ? idx : DEFAULT_COLORS.length - 1] ?? '#90ee90';
  }

  private saveUserColor(userId:string, color:string) {
    const ydoc = LiveCollaborationManager.yjsDocInstance;
    if (ydoc) ydoc.getMap<string>('authorColors').set(userId, color);

    // Awareness-State wird NICHT aktualisiert – Cursor-Farbe (Awareness) und
    // Texthervorhebungsfarbe (authorColors Y.Map) bleiben unabhängig voneinander.
    // So bleibt der kleine Tupfer (Cursor-Farbe der Gegenseite) stabil und
    // ↔ / ← haben echte Bedeutung.

    // F6: Badges sofort aktualisieren (der Y.Map-Observer deckt Remote-Änderungen ab,
    // aber lokale Änderungen via Picker brauchen einen direkten Aufruf)
    this.updateColorBadges();
  }

  // ── Private: Farb-Badges (F6) ─────────────────────────────────────────────

  private updateColorBadges() {
    const ydoc         = LiveCollaborationManager.yjsDocInstance;
    const authorColors = ydoc?.getMap<string>('authorColors');
    const users        = [...new Map([...this.currentUsers.values()].map(u => [u.id, u])).values()];
    if (users.length === 0) return;

    const html = users.map(user => {
      const color  = this.colorForUser(user.id, authorColors);
      const bg     = `${color.slice(0, 7)}80`; // 50 % Deckkraft (hex8)
      // 2-Buchstaben-Monogramm: Anfangsbuchstabe Vorname + Anfangsbuchstabe Nachname
      const words    = user.name.trim().split(/\s+/).filter(w => w.length > 0);
      const initials = words.length >= 2
        ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
        : user.name.slice(0, 2).toUpperCase();
      return `<span title="${esc(user.name)}"
                    style="display:inline-flex;align-items:center;justify-content:center;
                           width:20px;height:20px;border-radius:50%;
                           background:${esc(bg)};color:#000;font-size:8px;font-weight:700;
                           border:1px solid rgba(0,0,0,0.12);flex-shrink:0;">
                ${esc(initials)}
              </span>`;
    }).join('');

    // document.querySelectorAll statt this.colorBadgesTargets:
    // Der Badge im Panel hat data-turbo-permanent → Stimulus verliert Target-Referenz
    // zeitweise → this.hasColorBadgesTarget wäre false → früher Rücksprung → keine Aktualisierung.
    document.querySelectorAll<HTMLElement>(
      '[data-documents--live-events-target="colorBadges"]'
    ).forEach(el => { el.innerHTML = html; });

    // AvatarStack-Avatare (linke Gruppe, 2 Buchstaben) mit Farbring versehen
    this.applyColorsToAvatarStack();
  }

  // ── Private: Avatar-Stack direkt aus Verfasser-Daten aufbauen ───────────────
  // Kein Turbo-Stream nötig: online (currentUsers) + offline (authorProfiles Y.Map)
  // liefern alle Verfasser; coloredAvatarSvg() erzeugt die farbigen Kreisscheiben.

  private applyColorsToAvatarStack() {
    if (!this.hasUsersTarget) return;
    const ydoc           = LiveCollaborationManager.yjsDocInstance;
    const authorColors   = ydoc?.getMap<string>('authorColors');
    const authorProfiles = ydoc?.getMap<{ name:string; avatarUrl:string }>('authorProfiles');

    // Alle Verfasser dedupliziert nach userId
    const onlineById = new Map<string, LiveUser>(
      [...this.currentUsers.values()].map(u => [u.id, u]),
    );
    const allIds = new Set<string>([...onlineById.keys()]);
    authorProfiles?.forEach((_p, id) => { allIds.add(id); });

    if (allIds.size === 0) return;

    const html = [...allIds].map(userId => {
      const name  = onlineById.get(userId)?.name ?? authorProfiles?.get(userId)?.name ?? userId;
      const color = this.colorForUser(userId, authorColors);
      const src   = coloredAvatarSvg(name, color);
      return `<img src="${src}" alt="${esc(name)}" title="${esc(name)}" ` +
             `style="width:20px;height:20px;border-radius:50%;flex-shrink:0;">`;
    }).join('');

    this.usersTarget.innerHTML = html;
  }

  // ── Private: Picker aufräumen ──────────────────────────────────────────────

  private destroyColorPicker() {
    if (this.colorPicker) {
      // iro v5: picker.el ist das DOM-Element
      (this.colorPicker as unknown as { el:HTMLElement }).el?.remove();
      this.colorPicker = null;
    }
    document.getElementById('iro-picker-container')?.remove();
    this.activeSwatchUserId = null;
    // Benutzerliste nach Picker-Schließen aktualisieren (Swatches neu zeichnen)
    this.updatePanelUserList();
  }

  // ── Private: Klick außerhalb ───────────────────────────────────────────────

  private onDocumentClick = (event:MouseEvent) => {
    const target = event.target as Node;
    if (this.element.contains(target)) return;
    // Fallback: Panel hat data-turbo-permanent und kann vorübergehend von this.element
    // getrennt sein – direkt am popoverTarget prüfen.
    if (this.popoverTarget.contains(target)) return;
    // Picker liegt an document.body – Klicks darin NICHT als "außerhalb" werten
    const pickerEl = document.getElementById('iro-picker-container');
    if (pickerEl?.contains(target)) return;
    // Außerhalb: Panel schließen und Picker zerstören
    if (!this.popoverTarget.classList.contains('d-none')) {
      this.popoverTarget.classList.add('d-none');
      this.destroyColorPicker();
    }
  };

  // ── Private: Turbo-Stream ─────────────────────────────────────────────────

  private fetchTemplate(url:string) {
    void fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/vnd.turbo-stream.html',
        'X-Authentication-Scheme': 'Session',
      },
    })
      .then((response:Response) => {
        if (response.ok) return response.text();
        return Promise.reject(new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`));
      })
      .then((html:string) => Turbo.renderStreamMessage(html))
      .catch((error:Error) => console.error('Error:', error));
  }
}

/** Farbige SVG-Kreisscheibe als data-URL (für AvatarStack ohne echtes Foto) */
function coloredAvatarSvg(name:string, color:string, size = 36):string {
  const words    = name.trim().split(/\s+/).filter(w => w.length > 0);
  const initials = words.length >= 2
    ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
  const bg       = color.slice(0, 7);
  const fontSize = Math.max(Math.round(size * 0.45), 8);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="${bg}80"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
    `fill="#000" font-size="${fontSize}" font-weight="600" ` +
    `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" ` +
    `style="user-select:none">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** HTML-Escaping für dynamisch generierte Strings */
function esc(s:unknown):string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 * -- copyright
 * OpenProject is an open source project management software.
 * Copyright (C) the OpenProject GmbH
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License version 3.
 *
 * OpenProject is a fork of ChiliProject, which is a fork of Redmine. The copyright follows:
 * Copyright (C) 2006-2013 Jean-Philippe Lang
 * Copyright (C) 2010-2013 the ChiliProject Team
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 *
 * See COPYRIGHT and LICENSE files for more details.
 * ++
 */

import { BlockNoteEditorOptions, BlockNoteSchema } from '@blocknote/core';
import { User } from '@blocknote/core/comments';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { BlockNoteView } from '@blocknote/mantine';
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from '@blocknote/react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { initializeOpBlockNoteExtensions, openProjectWorkPackageBlockSpec, openProjectWorkPackageSlashMenu } from 'op-blocknote-extensions';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as Y from 'yjs';
import { relativePositionToAbsolutePosition, ySyncPluginKey } from 'y-prosemirror';
import { useBlockNoteAttachments } from '../hooks/useBlockNoteAttachments';
import { useBlockNoteLocale } from '../hooks/useBlockNoteLocale';
import { useOpTheme } from '../hooks/useOpTheme';
import { AUTHOR_DECO_KEY, createAuthorDecoPlugin } from '../extensions/AuthorMarkExtension';

interface CollaborativeUser {
  name:string;
  color:string;
}

export interface OpBlockNoteEditorProps {
  activeUser:User;
  readOnly:boolean;
  openProjectUrl:string;
  attachmentsUploadUrl:string;
  attachmentsCollectionKey:string;
  hocuspocusProvider?:HocuspocusProvider;
  doc:Y.Doc;
}

const schema = BlockNoteSchema.create().extend({
  blockSpecs: {
    openProjectWorkPackage: openProjectWorkPackageBlockSpec(),
  },
});

function generateRandomColor() {
  return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
}

export function OpBlockNoteEditor({
  activeUser,
  readOnly,
  openProjectUrl,
  attachmentsUploadUrl,
  attachmentsCollectionKey,
  hocuspocusProvider,
  doc,
}:OpBlockNoteEditorProps) {
  const { localeString, localeDictionary } = useBlockNoteLocale(window.I18n.locale);
  const { enabled: attachmentsEnabled, uploadFile } = useBlockNoteAttachments(attachmentsCollectionKey, attachmentsUploadUrl);

  useEffect(() => {
    initializeOpBlockNoteExtensions({ baseUrl: openProjectUrl, locale: localeString });
  }, [openProjectUrl, localeString]);

  // Stable ref to the local user's { id, color } – the plugin closure reads
  // this on every transaction without needing to re-register.
  const localUserRef = useRef<{ id: string; color: string } | null>(null);

  const editorParams = useMemo<Partial<BlockNoteEditorOptions<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>>>(() => {
    const userColor = hocuspocusProvider ? generateRandomColor() : '#333333';

    // Keep the ref current whenever the memo recalculates.
    localUserRef.current = { id: String(activeUser.id), color: userColor };

    const baseCollaboration = {
      fragment: doc.getXmlFragment('document-store'),
      user: {
        name: activeUser.username,
        color: userColor,
        ...(hocuspocusProvider && { id: activeUser.id }),
      } as unknown as CollaborativeUser,
    };

    // NOTE: No _tiptapOptions here. The author-decoration plugin is added
    // via registerPlugin() in the useEffect below, AFTER the editor is fully
    // initialised. This avoids any schema or Y.js reconciliation issues that
    // arise when new TipTap Mark types are injected during schema setup.
    return {
      schema,
      collaboration: {
        ...baseCollaboration,
        provider: hocuspocusProvider ?? null,
        ...(hocuspocusProvider && { showCursorLabels: 'activity' as const }),
      },
      dictionary: localeDictionary,
      ...(attachmentsEnabled && { uploadFile }),
    };
  }, [hocuspocusProvider, doc, activeUser, localeDictionary, attachmentsEnabled, uploadFile]);

  const editor = useCreateBlockNote(editorParams, [activeUser]);
  type EditorType = typeof editor;
  const theme = useOpTheme();

  // Register the author-decoration plugin after the editor is ready.
  // Y.Maps aus dem shared Y.Doc: 'authorRanges' für Persistenz, 'authorColors' für Farben.
  useEffect(() => {
    if (!editor) return;
    const tiptap = (editor as any)._tiptapEditor;
    if (!tiptap) return;

    const authorRangesMap = doc.getMap('authorRanges');
    const authorColorsMap = doc.getMap<string>('authorColors');

    const plugin = createAuthorDecoPlugin(
      () => localUserRef.current,
      authorRangesMap,
      authorColorsMap,
    );
    tiptap.registerPlugin(plugin);

    // F3: "Auswahl entfärben" – entfernt nur die Ranges, die die aktuelle Selektion überschneiden
    const handleDecolorSelection = () => {
      const state = tiptap.view?.state;
      if (!state) return;
      const { from, to } = state.selection;
      if (from === to) return; // Keine Auswahl → nichts tun

      const binding = (ySyncPluginKey as any).getState(state)?.binding;
      if (!binding) return;

      const toDelete: string[] = [];
      authorRangesMap.forEach((entry:any, key:string) => {
        try {
          const entryFrom = relativePositionToAbsolutePosition(
            binding.doc, binding.type, entry.relFrom, binding.mapping,
          );
          const entryTo = relativePositionToAbsolutePosition(
            binding.doc, binding.type, entry.relTo, binding.mapping,
          );
          if (entryFrom !== null && entryTo !== null && entryFrom < to && entryTo > from) {
            toDelete.push(key);
          }
        } catch { /* ungültigen Eintrag überspringen */ }
      });

      if (toDelete.length > 0) {
        doc.transact(() => { toDelete.forEach(key => authorRangesMap.delete(key)); });
      }
    };

    document.addEventListener('op:decolor-selection', handleDecolorSelection);

    return () => {
      tiptap.unregisterPlugin(AUTHOR_DECO_KEY);
      document.removeEventListener('op:decolor-selection', handleDecolorSelection);
    };
  }, [editor, doc]);

  const getCustomSlashMenuItems = useCallback((editorInstance:EditorType) => [
    ...getDefaultReactSlashMenuItems(editorInstance),
    openProjectWorkPackageSlashMenu(editorInstance),
  ], []);

  return (
    <>
      <BlockNoteView
        editor={editor}
        slashMenu={false}
        theme={theme}
        editable={!readOnly}
        className={'block-note-editor-container'}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query:string) => Promise.resolve(filterSuggestionItems(getCustomSlashMenuItems(editor), query))}
        />
      </BlockNoteView>
    </>
  );
}

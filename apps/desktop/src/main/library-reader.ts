import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import type { Logger } from '@worldview/core';
import {
  READER_PARTITION,
  READER_SCHEME,
  readerResponse,
  readerUrl,
  type ReaderSource,
} from './library-reader-pages.js';

/**
 * The library reader (2026-10-30): a window that shows the pages of the operator's ZIM files,
 * read by WorldView itself (runtime support/zim-library.ts).
 *
 * The pages come from outside — Wikipedia, iFixit, anyone who made a ZIM file — so the reader
 * is kept apart from the app:
 *  - its own in-memory session; the `wvzim:` scheme is handled in that session only, so the
 *    main window cannot load a library page and the reader cannot load the app;
 *  - no page script at all (`javascript: false`), and a Content-Security-Policy on every answer
 *    that allows only the book's own images, styles, fonts and media — no script, no frames,
 *    no forms, nothing from the network;
 *  - every request that is not `wvzim:` is cancelled in that session (an article's links to
 *    the web go nowhere), downloads are refused, permissions are refused;
 *  - sandboxed, context-isolated, no preload, no Node.
 * The main window's own Content-Security-Policy is not changed.
 */

export { isReaderUrl } from './library-reader-pages.js';

const readerContents = new Set<number>();

/** Whether a WebContents is a library reader (its navigation rules are the reader's). */
export function isReaderContents(c: WebContents): boolean {
  return readerContents.has(c.id);
}

export interface ReaderDeps extends ReaderSource {
  logger: Logger;
  iconPath?: string;
}

let readerSession: Session | undefined;

/** Call once, after the app is ready. */
export function setUpReaderSession(deps: ReaderDeps): Session {
  if (readerSession) return readerSession;
  const ses = session.fromPartition(READER_PARTITION);
  ses.protocol.handle(READER_SCHEME, (request) => readerResponse(deps, request.url));
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const ok = details.url.startsWith(`${READER_SCHEME}://`) || details.url.startsWith('devtools://');
    if (!ok)
      deps.logger.info('library reader: a request off the book was cancelled', { url: details.url.slice(0, 120) });
    callback({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (event) => event.preventDefault());
  readerSession = ses;
  return ses;
}

let readerWindow: BrowserWindow | undefined;

/** Open (or bring forward) the reader at an entry. */
export async function openReader(deps: ReaderDeps, bookId: string, key: string): Promise<void> {
  const ses = setUpReaderSession(deps);
  if (!readerWindow || readerWindow.isDestroyed()) {
    const win = new BrowserWindow({
      width: 1100,
      height: 860,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: 'WorldView library',
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      ...(deps.iconPath ? { icon: deps.iconPath } : {}),
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    });
    const id = win.webContents.id;
    readerContents.add(id);
    win.setMenuBarVisibility(false);
    win.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(`${title.slice(0, 200)} — WorldView library`);
    });
    // Back and forward: Alt+Left/Right, Backspace, and the mouse's side buttons.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const h = win.webContents.navigationHistory;
      if ((input.alt && input.key === 'ArrowLeft') || input.key === 'BrowserBack' || input.key === 'Backspace') {
        if (h.canGoBack()) h.goBack();
        event.preventDefault();
      } else if ((input.alt && input.key === 'ArrowRight') || input.key === 'BrowserForward') {
        if (h.canGoForward()) h.goForward();
        event.preventDefault();
      }
    });
    win.on('app-command', (_e, cmd) => {
      const h = win.webContents.navigationHistory;
      if (cmd === 'browser-backward' && h.canGoBack()) h.goBack();
      if (cmd === 'browser-forward' && h.canGoForward()) h.goForward();
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      readerContents.delete(id);
      readerWindow = undefined;
    });
    readerWindow = win;
  }
  const win = readerWindow;
  await win.loadURL(readerUrl(bookId, key));
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

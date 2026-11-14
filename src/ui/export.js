// Getting the season record out of the browser. On a phone that means the
// share sheet (save to Files, send to yourself, drop into a chat); on a
// computer, a downloaded file. Copy is offered everywhere as the fallback that
// always works.

import { cinematic } from './ui.js';

const LAST_KEY = 'bbjury.lastRecord';

// The finished season is kept so it can still be exported after New Season
// has cleared the save. One season, replaced each time.
export function keepLastRecord(text, filename) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ text, filename, at: Date.now() })); } catch { /* too large or storage unavailable */ }
}
export function lastRecord() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; }
}

export function showExport(text, filename, label = 'this season') {
  const kb = Math.max(1, Math.round(text.length / 1024));
  const c = cinematic({
    kicker: 'Season record',
    title: 'Export the game',
    bodyHtml: `<p>Everything from ${label}: every conversation, comp, vote, promise and the finale, in one text file (${kb} KB).</p>` +
      '<p class="muted">Nothing is uploaded anywhere. You choose where the file goes.</p><p class="muted" id="export-note"></p>',
  });
  const note = c.card.querySelector('#export-note');
  const file = () => new File([text], filename, { type: 'text/plain' });

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    note.textContent = `Saved as ${filename}.`;
  };
  const share = async () => {
    try {
      const f = file();
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: 'BB Jury House season record' });
        note.textContent = 'Shared.';
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return; // the player closed the share sheet
    }
    download();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = 'Copied. Paste it wherever you need it.';
    } catch {
      note.textContent = 'This browser would not allow copying. Use Share or Save instead.';
    }
  };

  const canShareFiles = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [file()] })); } catch { return false; } })();
  c.setActions([
    { label: canShareFiles ? 'Share / save file' : 'Save file', style: 'gold', onClick: share },
    { label: 'Copy all text', style: 'primary', onClick: copy },
    { label: 'Close', style: '', onClick: () => c.close() },
  ]);
  return c;
}

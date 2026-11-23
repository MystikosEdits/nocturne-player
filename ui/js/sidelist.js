// Sidebar playlists: pinning + folders (Grant, Nov 20: "add playlist pinning and grouping/folders").
// YouTube Music has neither, so this lives in Nocturne's settings (settings.sidebar = {pinned: [ids], folders:
// [{id, name, open, items: [ids]}]}): your playlists on YouTube are never changed by it.
//   right-click a playlist  -> Pin to top / Unpin, Move to folder ▸, Remove from folder
//   drag a playlist         -> onto a folder (into it), onto a pinned one (pin it there), onto "Playlists" (back out)
//   right-click a folder    -> Rename, Delete (its playlists go back to the list)
import { get, post } from './api.js';
import { h, icon, emit, prompt, toast } from './ui.js';

let cfg = null;
export const resetSideCfg = () => { cfg = null; };   // the account sync brought new pins / folders
let loaded = false;       // never write before the saved pins/folders were really read: a failed read used to start
                          // from an empty set, and the next pin then saved over (= wiped) every folder
const fresh = () => ({ pinned: [], folders: [] });

export async function sideCfg() {
  if (!loaded) {
    try { cfg = { ...fresh(), ...((await get('/api/settings')).settings.sidebar || {}) }; loaded = true; }
    catch { cfg = cfg || fresh(); }
  }
  return cfg;
}
// saves go out one after another, so two quick drags can't land in the wrong order (the older one won)
let chain = Promise.resolve();
function save() {
  emit('sidecfg');
  if (!loaded) { toast('Couldn’t read your sidebar folders, so this change isn’t saved. Try again in a moment.', 'error'); loaded = false; cfg = null; return; }
  const snap = JSON.parse(JSON.stringify(cfg));
  chain = chain.then(() => post('/api/settings', { sidebar: snap })).catch((e) => toast(e.message, 'error'));
}
const folderOf = (id) => cfg.folders.find((f) => f.items.includes(id));
const outOfFolders = (id) => cfg.folders.forEach((f) => { f.items = f.items.filter((x) => x !== id); });

export function pin(id, before) {
  cfg.pinned = cfg.pinned.filter((x) => x !== id);
  const i = before ? cfg.pinned.indexOf(before) : -1;
  if (i >= 0) cfg.pinned.splice(i, 0, id); else cfg.pinned.push(id);
  save();
}
const loose = (id) => { outOfFolders(id); cfg.pinned = cfg.pinned.filter((x) => x !== id); };   // a playlist lives in one place
export function unpin(id) { cfg.pinned = cfg.pinned.filter((x) => x !== id); save(); }
export function moveToFolder(id, fid) {
  loose(id);
  const f = cfg.folders.find((x) => x.id === fid);
  if (f) { f.items.push(id); f.open = true; }
  save();
}
export function takeOut(id) { loose(id); save(); }
export async function newFolder(withId) {
  const name = await prompt('New folder', 'Folder name');
  if (!name) return;
  const f = { id: 'f' + Date.now().toString(36), name: name.trim(), open: true, items: [] };
  cfg.folders.push(f);
  if (withId) { loose(withId); f.items.push(withId); }
  save();
}

/** extra right-click items for a playlist (sidebar + Library) */
export function playlistMenuItems(p) {
  if (!cfg || p.id === 'LM' || p.id === 'versions') return [];
  const pinned = cfg.pinned.includes(p.id);
  const inF = folderOf(p.id);
  const sub = () => [
    { label: 'New folder…', icon: 'folderPlus', onClick: () => newFolder(p.id) },
    cfg.folders.length ? '-' : null,
    ...cfg.folders.filter((f) => f !== inF).map((f) => ({ label: f.name, icon: 'folder', onClick: () => moveToFolder(p.id, f.id) })),
  ];
  return ['-',
    pinned ? { label: 'Unpin', icon: 'pin', onClick: () => unpin(p.id) } : { label: 'Pin to top', icon: 'pin', onClick: () => { outOfFolders(p.id); pin(p.id); } },
    { label: inF ? 'Move to another folder' : 'Move to folder', icon: 'folder', sub },
    inF ? { label: `Take out of “${inF.name}”`, icon: 'x', onClick: () => takeOut(p.id) } : null,
  ];
}

// ------------------------------------------------------------------ drawing
let dragId = null;
function dropTarget(el, onDrop) {
  el.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); if (dragId) onDrop(dragId); dragId = null; });
}

/** -> the sidebar rows: pinned, then folders, then everything else. `row(p)` makes one playlist link. */
export function buildRows(pls, row, menuAt) {
  const byId = Object.fromEntries(pls.map((p) => [p.id, p]));
  // forget playlists that no longer exist (deleted on YouTube)
  const known = (id) => !!byId[id];
  const out = [];
  const mk = (p, extraCls = '') => {
    const a = row(p);
    if (extraCls) a.classList.add(extraCls);
    a.draggable = true;
    a.addEventListener('dragstart', (e) => { dragId = p.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.title || ''); });
    a.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });
    return a;
  };
  const pinned = cfg.pinned.filter(known);
  if (pinned.length) {
    const head = h('div', { class: 'side-sub' }, icon('pin'), h('span', null, 'Pinned'));
    dropTarget(head, (id) => { outOfFolders(id); pin(id); });
    out.push(head);
    pinned.forEach((id) => {
      const a = mk(byId[id], 'pinned');
      dropTarget(a, (dragged) => { if (dragged !== id) { outOfFolders(dragged); pin(dragged, id); } });
      out.push(a);
    });
  }
  const placed = new Set(pinned);
  cfg.folders.forEach((f) => {
    const items = f.items.filter((id) => known(id) && !placed.has(id));
    items.forEach((id) => placed.add(id));
    const fold = h('button', { class: `side-folder ${f.open ? 'open' : ''}`, title: f.name, onclick: () => { f.open = !f.open; save(); } },
      h('div', { class: 'art xs folder-art' }, icon(f.open ? 'folderOpen' : 'folder')), h('span', null, f.name), h('em', null, String(items.length)));
    fold.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menuAt(e.clientX, e.clientY, [
        { label: f.open ? 'Collapse' : 'Expand', icon: 'down', onClick: () => { f.open = !f.open; save(); } },
        { label: 'Rename folder', icon: 'wand', onClick: async () => { const n = await prompt('Rename folder', 'Folder name', f.name); if (n) { f.name = n.trim(); save(); } } },
        { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => { cfg.folders = cfg.folders.filter((x) => x !== f); save(); toast(`Folder deleted (its playlists are back in the list)`); } },
      ]);
    });
    dropTarget(fold, (id) => moveToFolder(id, f.id));
    out.push(fold);
    if (f.open) items.forEach((id) => out.push(mk(byId[id], 'in-folder')));
  });
  pls.filter((p) => !placed.has(p.id)).forEach((p) => out.push(mk(p)));
  return out;
}

/** the "Playlists" header takes a dragged playlist back out of its folder / pin */
export const headDrop = (el) => dropTarget(el, (id) => takeOut(id));

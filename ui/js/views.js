// Every page in the main area.
import { I } from './icons.js';
import { get, post, cached, dropCache, cmd } from './api.js';
import {
  h, icon, btn, pill, img, go, store, on, shelf, grid, empty, skeleton, errorBox, toast, run, modal,
  prompt, playTracks, playKind, playItem, artColor, fmtTime, fmtBytes, artistLinks, myPlaylists, isMac,
  copyLink, menu, addToPlaylistMenu, needSignIn, trackMenu, collectionMenu, prefetchOnHover, prefetchPageOnHover, pageZoom,
} from './ui.js';
import { trackList } from './tracklist.js';
import { shortcutRows } from './shortcuts.js';

const signedIn = () => !!store.state?.auth?.yt;

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function pageHead(title, sub, right) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'page-sub' }, sub) : null), right || null);
}

function signInCard(why) {
  return h('div', { class: 'callout' },
    h('div', { class: 'callout-ico', html: I.user }),
    h('div', { class: 'callout-text' }, h('div', { class: 'callout-title' }, 'Connect your YouTube Music account'), h('div', null, why)),
    h('button', { class: 'btn primary', onclick: () => go('#/settings') }, 'Connect'));
}

// ------------------------------------------------------------------ home
export async function home(_, el) {
  el.append(skeleton());
  const data = await cached('/api/home', 5 * 60000);
  el.innerHTML = '';
  el.append(pageHead(greeting(), signedIn() && store.state?.auth?.account?.name ? `Picked for ${store.state.auth.account.name.split(' ')[0]}` : null));
  if (!signedIn()) el.append(signInCard('Your mixes, liked songs and playlists show up here, and every song you play teaches your recommendations.'));
  for (const s of data.shelves || []) el.append(shelf(s));
  if (!(data.shelves || []).length) el.append(empty('music', 'Nothing here yet', 'Try searching for something.'));
  return { title: 'Home' };
}

// ------------------------------------------------------------------ explore
const MOOD_COLORS = ['#7c5cff', '#ff5c8a', '#2bb673', '#f59e0b', '#06b6d4', '#ef4444', '#8b5cf6', '#14b8a6', '#e11d48', '#3b82f6', '#84cc16', '#f97316'];
export async function explore(_, el) {
  el.append(skeleton());
  const data = await cached('/api/explore', 30 * 60000);
  el.innerHTML = '';
  el.append(pageHead('Explore'));
  for (const s of data.shelves || []) el.append(shelf(s));
  for (const group of data.moods || []) {
    const sec = h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', null, group.title)));
    const g = h('div', { class: 'mood-grid' });
    group.items.forEach((m, i) => g.append(h('button', {
      class: 'mood', style: { '--mc': MOOD_COLORS[(i + group.title.length) % MOOD_COLORS.length] },
      onclick: () => go(`#/mood/${encodeURIComponent(m.params)}?title=${encodeURIComponent(m.title)}`),
    }, m.title)));
    sec.append(g);
    el.append(sec);
  }
  return { title: 'Explore' };
}

export async function mood(params, el, query) {
  const title = query.get('title') || 'Mood';
  el.append(pageHead(title));
  el.append(skeleton());
  const data = await cached('/api/mood?params=' + encodeURIComponent(params), 30 * 60000);
  el.querySelector('.skel-wrap')?.remove();
  el.append(grid(data.items || []));
  return { title };
}

// ------------------------------------------------------------------ search
const FILTERS = [['', 'All'], ['songs', 'Songs'], ['videos', 'Videos'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'], ['youtube', 'All of YouTube']];

export async function search(_, el, query) {
  const q = query.get('q') || '';
  const f = query.get('filter') || '';
  const chips = h('div', { class: 'chips' }, ...FILTERS.map(([k, label]) => h('button', {
    class: `chip ${k === f ? 'on' : ''}`, onclick: () => go(`#/search?q=${encodeURIComponent(q)}${k ? '&filter=' + k : ''}`),
  }, k === 'youtube' ? icon('youtube') : null, label)));
  el.append(chips);
  if (!q) { el.append(empty('search', 'Search for anything', 'Songs, artists, albums, playlists — or paste a YouTube or Spotify link.')); return { title: 'Search' }; }
  const body = h('div');
  el.append(body);
  body.append(skeleton(f && f !== 'albums' && f !== 'artists' && f !== 'playlists' ? 'list' : 'shelves'));
  const data = await cached(`/api/search?q=${encodeURIComponent(q)}${f ? '&filter=' + f : ''}`, 5 * 60000);
  body.innerHTML = '';
  if (data.link) { handleLink(data.link); return { title: 'Search' }; }
  if (data.spotify) { await spotifySearch(body, data.spotify); return { title: 'Spotify link' }; }
  if (data.tracks) {
    if (!data.tracks.length) body.append(empty('search', `No results for “${q}”`, 'Try different words.'));
    else body.append(trackList(data.tracks, { context: { type: 'search', title: `“${q}”` }, showAlbum: f === 'songs', showViews: f !== 'songs', badgeVideos: true }));
    if (f === 'youtube') body.prepend(h('div', { class: 'note' }, 'Everything on YouTube, including uploads that aren’t official songs. Quality is whatever the uploader posted.'));
    return { title: q };
  }
  if (data.cards) { body.append(data.cards.length ? grid(data.cards) : empty('search', `No results for “${q}”`)); return { title: q }; }
  const top = data.top;
  const songs = (data.shelves || []).find((s) => s.title === 'Songs');
  if (top || songs) {
    const row = h('div', { class: 'search-top' });
    if (top) row.append(h('div', { class: 'top-result' }, h('div', { class: 'label' }, 'Top result'), topCard(top)));
    if (songs) row.append(h('div', { class: 'top-songs' }, h('div', { class: 'label' }, 'Songs'), trackList(songs.items.slice(0, 4), { header: false, showAlbum: false, context: { type: 'search', title: `“${q}”` } })));
    body.append(row);
  }
  for (const s of data.shelves || []) {
    if (s === songs) { if (s.items.length > 4) body.append(shelf({ ...s, title: 'More songs', items: s.items.slice(4) })); continue; }
    body.append(shelf(s));
  }
  if (!top && !(data.shelves || []).length) body.append(empty('search', `No results for “${q}”`, 'Try “All of YouTube” for uploads that aren’t on YouTube Music.'));
  return { title: q };
}

function topCard(item) {
  const isTrack = item.kind === 'song' || item.kind === 'video';
  const c = h('div', { class: 'topcard' },
    img(item.thumb, 'lg', item.round),
    h('div', { class: 'topcard-title' }, item.title),
    h('div', { class: 'topcard-sub' }, h('span', { class: 'kind' }, item.kind === 'song' ? 'Song' : item.kind === 'video' ? 'Video' : item.kind[0].toUpperCase() + item.kind.slice(1)),
      isTrack ? artistLinks(item.artists) : (item.sub || '').replace(/^(Album|Single|EP|Playlist|Artist)\s*•\s*/i, '')),
    h('button', { class: 'bigplay', title: 'Play', onclick: (e) => { e.stopPropagation(); playItem(item); } }, icon('play')));
  c.addEventListener('click', () => (isTrack ? playItem(item) : go(`#/${item.kind}/${item.id}`)));
  // the top result had no right-click menu at all (Grant, Nov 22): same menus as every other song / card
  c.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isTrack) trackMenu(item, e.clientX, e.clientY); else collectionMenu(item, e.clientX, e.clientY);
  });
  if (isTrack) prefetchOnHover(c, () => [item.id]); else prefetchPageOnHover(c, item);
  return c;
}

export function handleLink(link) {
  if (link.kind === 'song') playKind('song', link.id);
  else go(`#/${link.kind}/${link.id}`);
}

// ------------------------------------------------------------------ collection header (playlist / album)
async function tint(el, thumb) {
  const rgb = await artColor(thumb);
  if (rgb) el.style.setProperty('--tint', rgb.join(' '));
}

function collHeader({ thumb, type, title, meta, desc, round }) {
  const head = h('div', { class: 'coll-head' },
    img(thumb, 'cover', round),
    h('div', { class: 'coll-info' },
      h('div', { class: 'coll-type' }, type),
      h('h1', { class: `coll-title ${title.length > 28 ? 'long' : ''}` }, title),
      meta ? h('div', { class: 'coll-meta' }, meta) : null,
      desc ? h('div', { class: 'coll-desc', title: desc }, desc) : null));
  return head;
}

function actionRow(...kids) { return h('div', { class: 'actions' }, ...kids); }
// a song list with its find / sort / jump tools at the right end of the page's action row
function listWithTools(row, tracks, opts) {
  const list = trackList(tracks, { ...opts, tools: tracks.length > 1 });
  if (list.tools) row.append(list.tools);
  return list;
}
const bigPlay = (onClick) => h('button', { class: 'bigplay', title: 'Play', onclick: onClick }, icon('play'));

export async function playlist(id, el) {
  el.append(skeleton('list'));
  const p = await cached('/api/playlist/' + id, 60000);
  el.innerHTML = '';
  el.classList.add('tinted');
  tint(el, p.thumb);
  const metaText = (ts) => {
    const total = ts.reduce((a, t) => a + (t.dur || 0), 0);
    return [p.author, p.year, `${ts.length} song${ts.length === 1 ? '' : 's'}`, total ? fmtLong(total) : p.duration].filter(Boolean).join(' • ');
  };
  const head = collHeader({ thumb: p.thumb, type: id === 'LM' ? 'Your likes' : 'Playlist', title: p.title, meta: metaText(p.tracks), desc: p.desc });
  const metaEl = head.querySelector('.coll-meta');
  el.append(head);
  const ctx = { type: 'playlist', id, title: p.title };
  const dlAll = () => run(() => post('/api/downloads/add', { tracks: p.tracks }));
  const acts = actionRow(
    bigPlay(() => playTracks(p.tracks, 0, ctx, false)),
    btn('shuffle', 'Shuffle', () => playTracks(p.tracks, Math.floor(Math.random() * p.tracks.length), ctx, true), 'lg'),
    btn('radio', 'Radio', () => run(() => post('/api/play', { kind: 'radio', playlistId: id.startsWith('RD') ? id : 'RDAMPL' + id, title: `${p.title} radio` })), 'lg'),
    btn('download', 'Download all', dlAll, 'lg'),
    btn('more', 'More', (e) => menu(e.clientX, e.clientY, [
      { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: p.tracks }), 'Added to queue') },
      { label: 'Copy link', icon: 'link', onClick: () => copyLink({ id }, 'playlist') },
      p.owned && id !== 'LM' ? '-' : null,
      p.owned && id !== 'LM' ? { label: 'Delete playlist', icon: 'trash', danger: true, onClick: () => confirmDelete(id, p.title) } : null,
    ]), 'lg'));
  el.append(acts);
  if (!p.tracks.length) el.append(empty('music', 'This playlist is empty', p.owned ? 'Right-click any song and choose “Add to playlist”, or drag songs onto it in the sidebar.' : ''));
  else {
    // a copy: removing a song with Undo edits this list, never the cached one
    const tracks = p.tracks.slice();
    el.append(listWithTools(acts, tracks, { context: ctx, playlistId: id, owned: p.owned,
      onChanged: (now) => { metaEl.textContent = metaText(now); } }));
  }
  return { title: p.title };
}

function confirmDelete(id, title) {
  modal({
    title: 'Delete playlist?', body: h('p', null, `“${title}” will be deleted from your YouTube Music account.`),
    actions: [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: async () => {
      await run(() => post('/api/playlist/delete', { playlistId: id }), 'Playlist deleted');
      dropCache('/api/library'); myPlaylists(true); go('#/library/playlists');
    } }],
  });
}

function fmtLong(s) {
  const hr = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return hr ? `${hr} hr ${m} min` : `${m} min`;
}

export async function album(id, el) {
  el.append(skeleton('list'));
  const a = await cached('/api/album/' + id, 10 * 60000);
  el.innerHTML = '';
  el.classList.add('tinted');
  tint(el, a.thumb);
  const total = a.tracks.reduce((x, t) => x + (t.dur || 0), 0);
  const meta = h('span', null, artistLinks(a.artists), [a.year, `${a.tracks.length} songs`, total ? fmtLong(total) : a.duration].filter(Boolean).map((x) => ' • ' + x).join(''));
  el.append(collHeader({ thumb: a.thumb, type: a.type || 'Album', title: a.title, meta, desc: a.desc }));
  const ctx = { type: 'album', id: a.id, title: a.title };
  let saved = a.like === 'LIKE';
  const saveBtn = btn(saved ? 'check' : 'plus', saved ? 'Saved to library' : 'Save to library', async () => {
    if (!signedIn()) return needSignIn('save albums');
    if (!a.playlistId) return;
    saved = !saved;
    await run(() => post('/api/album/save', { playlistId: a.playlistId, status: saved ? 'LIKE' : 'INDIFFERENT' }), saved ? 'Saved to library' : 'Removed from library');
    saveBtn.innerHTML = '';
    saveBtn.append(icon(saved ? 'check' : 'plus'));
    saveBtn.classList.toggle('on', saved);
    dropCache('/api/library/albums');
  }, `lg ${saved ? 'on' : ''}`);
  const acts = actionRow(
    bigPlay(() => playTracks(a.tracks, 0, ctx, false)),
    btn('shuffle', 'Shuffle', () => playTracks(a.tracks, 0, ctx, true), 'lg'),
    saveBtn,
    btn('download', 'Download album', () => run(() => post('/api/downloads/add', { tracks: a.tracks })), 'lg'),
    btn('more', 'More', (e) => menu(e.clientX, e.clientY, [
      { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: a.tracks }), 'Added to queue') },
      signedIn() ? { label: 'Add to playlist', icon: 'plus', sub: () => addToPlaylistMenu(a.tracks) } : null,
      { label: 'Copy link', icon: 'link', onClick: () => copyLink({ id: a.id }, 'album') },
    ]), 'lg'));
  el.append(acts, listWithTools(acts, a.tracks, { context: ctx, showArt: false, showAlbum: false }));
  if (a.versions?.length) el.append(shelf({ title: 'Other versions', type: 'cards', items: a.versions }));
  return { title: a.title };
}

export async function artist(id, el) {
  el.append(skeleton());
  const a = await cached('/api/artist/' + id, 10 * 60000);
  el.innerHTML = '';
  el.classList.add('tinted');
  tint(el, a.thumb);
  const hero = h('div', { class: 'artist-hero' },
    a.thumb ? h('div', { class: 'hero-img', style: { backgroundImage: `url("${a.thumb}")` } }) : null,
    h('div', { class: 'hero-fade' }),
    h('div', { class: 'hero-info' }, h('div', { class: 'coll-type' }, 'Artist'), h('h1', { class: 'hero-name' }, a.name),
      h('div', { class: 'coll-meta' }, [a.subscribers ? `${a.subscribers} subscribers` : null, a.views].filter(Boolean).join(' • '))));
  el.append(hero);
  let subbed = !!a.subscribed;
  const sub = h('button', { class: `btn ${subbed ? '' : 'outline'}`, onclick: async () => {
    if (!signedIn()) return needSignIn('subscribe');
    subbed = !subbed;
    sub.textContent = subbed ? 'Subscribed' : 'Subscribe';
    sub.classList.toggle('outline', !subbed);
    await run(() => post('/api/subscribe', { id: a.channelId || id, on: subbed }));
    dropCache('/api/library/artists');
  } }, subbed ? 'Subscribed' : 'Subscribe');
  el.append(actionRow(
    bigPlay(() => (a.songs.length ? playTracks(a.songs, 0, { type: 'artist', id, title: a.name }) : playKind('artist', id, { radio: true }))),
    a.shuffleId ? btn('shuffle', 'Shuffle', () => playKind('artist', id, { shuffle: true }), 'lg') : null,
    a.radioId ? btn('radio', 'Artist radio', () => playKind('artist', id, { radio: true }), 'lg') : null,
    sub));
  if (a.songs.length) {
    const sec = h('section', { class: 'shelf' }, h('div', { class: 'shelf-head' }, h('h2', null, 'Popular'),
      a.songsPlaylist ? h('div', { class: 'shelf-nav' }, pill('Show all', () => go(`#/playlist/${a.songsPlaylist.replace(/^VL/, '')}`))) : null));
    sec.append(trackList(a.songs, { header: false, context: { type: 'artist', id, title: a.name } }));
    el.append(sec);
  }
  for (const s of a.shelves || []) el.append(shelf(s));
  if (a.desc) {
    const about = h('section', { class: 'shelf about' }, h('div', { class: 'shelf-head' }, h('h2', null, 'About')),
      h('div', { class: 'about-text clamp' }, a.desc));
    about.querySelector('.about-text').addEventListener('click', (e) => e.currentTarget.classList.toggle('clamp'));
    el.append(about);
  }
  return { title: a.name };
}

// ------------------------------------------------------------------ library
const LIB_TABS = [['playlists', 'Playlists'], ['liked', 'Liked songs'], ['versions', 'My versions'], ['albums', 'Albums'], ['artists', 'Artists'], ['history', 'History'], ['downloads', 'Downloads']];
export async function library(tab, el) {
  tab = tab || 'playlists';
  el.append(pageHead('Library'));
  el.append(h('div', { class: 'chips' }, ...LIB_TABS.map(([k, label]) => h('button', { class: `chip ${k === tab ? 'on' : ''}`, onclick: () => go('#/library/' + k) }, label))));
  if (tab === 'downloads') return downloads(null, el, null, true);
  if (tab === 'versions') return versions(null, el, null, true);
  if (!signedIn()) {
    el.append(signInCard('Your playlists, liked songs, saved albums and history live in your YouTube Music account.'));
    return { title: 'Library' };
  }
  if (tab === 'liked') { el.innerHTML = ''; return playlist('LM', el); }
  const body = h('div');
  el.append(body);
  body.append(skeleton(tab === 'history' ? 'list' : 'shelves'));
  const data = await cached('/api/library/' + tab, tab === 'history' ? 15000 : 120000);
  body.innerHTML = '';
  const items = data.items || [];
  if (tab === 'history') {
    if (!items.length) body.append(empty('history', 'No history yet', 'Songs you play show up here (and teach your recommendations).'));
    else { const acts = actionRow(); body.append(acts, listWithTools(acts, items, { context: { type: 'history', title: 'History' } })); }
  } else if (tab === 'playlists') {
    const create = h('div', { class: 'card newpl', onclick: async () => {
      const name = await prompt('New playlist', 'Playlist name');
      if (!name) return;
      const r = await run(() => post('/api/playlist/create', { title: name }));
      dropCache('/api/library'); myPlaylists(true);
      if (r?.id) go('#/playlist/' + r.id);
    } }, h('div', { class: 'card-art' }, h('div', { class: 'art newpl-art', html: I.plus })), h('div', { class: 'card-title' }, 'New playlist'), h('div', { class: 'card-sub' }, 'Private'));
    const g = grid(items);
    g.prepend(create);
    body.append(g);
  } else {
    body.append(items.length ? grid(items) : empty(tab === 'albums' ? 'album' : 'user', tab === 'albums' ? 'No saved albums' : 'No artists yet', tab === 'albums' ? 'Save albums with the + button on an album page.' : 'Subscribe to artists to see them here.'));
  }
  return { title: 'Library' };
}

// ------------------------------------------------------------------ my versions (slowed / reverb / sped up)
export async function versions(_, el, __, embedded = false) {
  if (!embedded) el.append(pageHead('My versions'));
  const body = h('div');
  el.append(body);
  const render = async () => {
    const { items } = await get('/api/versions');
    body.innerHTML = '';
    // the how-to only when there's nothing yet (a banner above the list was read once and scrolled past forever)
    if (!items.length) { body.append(empty('wand', 'No versions yet', 'Right-click any song → “Slowed / reverb / sped up…” (or press V) to make one. Versions play with their effects anywhere: queue, shuffle, playlists, downloads.')); return; }
    const acts = actionRow(bigPlay(() => playKind('versions', 'versions')), btn('shuffle', 'Shuffle', () => playKind('versions', 'versions', { shuffle: true }), 'lg'));
    body.append(acts, listWithTools(acts, items, { context: { type: 'versions', id: 'versions', title: 'My versions' }, onPlay: (i) => playKind('versions', 'versions', { index: i }) }));
  };
  await render();
  const off = on('versions-changed', render);
  return { title: 'My versions', cleanup: off };
}

// ------------------------------------------------------------------ downloads
export async function downloads(_, el, __, embedded = false) {
  if (!embedded) el.append(pageHead('Downloads'));
  const body = h('div');
  el.append(body);
  const progress = h('div');
  const paintProgress = (st) => {
    progress.replaceChildren(...(st.active ? [h('div', { class: 'dl-active' }, icon('download'), h('span', null, `Downloading “${st.active.title}”`),
      h('div', { class: 'bar' }, h('i', { style: { width: Math.round((st.active.progress || 0) * 100) + '%' } })),
      st.queued ? h('span', { class: 'muted' }, `+${st.queued} waiting`) : null)] : []));
  };
  let shown = '';
  const render = async () => {
    const { items } = await get('/api/library/offline');
    const st = await get('/api/downloads');
    shown = String(st.count);
    body.innerHTML = '';
    body.append(progress);
    paintProgress(st);
    if (!items.length) { body.append(empty('download', 'No downloads yet', 'Right-click a song, or use the download button on any playlist or album. Downloaded songs play without internet and start instantly.')); return; }
    const acts = actionRow(bigPlay(() => playKind('offline', 'offline')), btn('shuffle', 'Shuffle', () => playKind('offline', 'offline', { shuffle: true }), 'lg'),
      h('span', { class: 'muted small' }, `${items.length} song${items.length === 1 ? '' : 's'} • ${fmtBytes(st.bytes)} on this computer`));
    body.append(acts, listWithTools(acts, items, { context: { type: 'offline', id: 'offline', title: 'Downloads' }, onPlay: (i) => playKind('offline', 'offline', { index: i }), extraMenu: (t) => [{ label: 'Remove download', icon: 'trash', danger: true, onClick: () => run(() => post('/api/downloads/remove', { ids: [t.id] })) }] }));
  };
  await render();
  let tm = null;
  const off = on('downloads', (d) => {
    paintProgress(d);
    if (String(d.count) !== shown) { clearTimeout(tm); tm = setTimeout(render, 400); }   // the list itself changed
  });
  return { title: 'Downloads', cleanup: off };
}

// ------------------------------------------------------------------ settings
function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}
function setRow(title, desc, control) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, title), desc ? h('div', { class: 'set-desc' }, desc) : null), control);
}
function section(title, ...rows) { return h('section', { class: 'set-sec' }, h('h2', null, title), h('div', { class: 'set-card' }, ...rows)); }

/* SETTINGS (reorganised Nov 22, Grant: "organize settings better"): every group is its own card, listed in a sticky
   category column on the left (it follows your scroll), with a search box that filters rows as you type. */
export async function settings(_, el) {
  const data = await get('/api/settings');
  const s = data.settings;
  const save = (patch) => run(() => post('/api/settings', patch)).then(() => Object.assign(s, patch));
  const groups = [];          // [{id, title, cat, el}] in page order
  const add = (cat, id, title, card) => groups.push({ cat, id, title, el: card });
  const card = (...rows) => h('div', { class: 'set-card' }, ...rows);

  // account
  const auth = store.state?.auth || {};
  const acct = card();
  if (auth.yt) {
    const a = auth.account || {};
    acct.append(h('div', { class: 'acct' },
      a.photo ? img(a.photo, 'avatar', true) : h('div', { class: 'avatar-ph', html: I.user }),
      h('div', { class: 'acct-text' }, h('div', { class: 'set-title' }, a.name || 'Signed in'),
        h('div', { class: 'set-desc' }, auth.premium === true ? 'YouTube Music Premium • 256 kbps audio' : auth.premium === false ? 'Signed in • Premium audio not available on this account' : 'Signed in • audio quality is checked when the next song loads')),
      h('button', { class: 'btn', onclick: async () => { await run(() => post('/api/auth/youtube/logout'), 'Signed out'); location.reload(); } }, icon('logout'), 'Sign out')));
  } else {
    acct.append(h('div', { class: 'acct' },
      h('div', { class: 'avatar-ph', html: I.user }),
      h('div', { class: 'acct-text' }, h('div', { class: 'set-title' }, 'YouTube Music account'),
        h('div', { class: 'set-desc' }, 'Sign in for your library, liked songs, personal mixes and Premium 256 kbps audio.')),
      h('button', { class: 'btn primary', onclick: signInGoogle }, 'Sign in with Google')));
    acct.append(h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('div', { class: 'set-desc' }, 'Google sign-in blocked in the window? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); pasteSignIn(); } }, 'Paste your sign-in from the browser instead')))));
  }
  add('Account', 'account', 'Account', acct);

  // the look
  const { appearanceSections } = await import('./appearance.js');
  for (const g of appearanceSections()) add('Look', g.id, g.title, g.el);

  add('Listening', 'playback', 'Playback', card(
    setRow('Audio quality', 'Best: a song you click starts instantly, and everything queued after it loads at 256 kbps (Premium). Downloads are always 256 kbps. Data saver uses less internet.',
      selectEl([['best', 'Best available'], ['normal', 'Data saver']], s.quality, (v) => save({ quality: v }))),
    setRow('Autoplay similar songs', 'When your queue ends, keep going with songs like the last one.', toggle(s.autoplay, (v) => cmd('autoplay', v))),
    setRow('Even out volume', 'Keeps loud and quiet songs at a similar level.', toggle(s.normalize, (v) => save({ normalize: v }))),
    setRow('Count plays in my YouTube history', 'Songs you play teach YouTube Music’s recommendations, same as the official app.', toggle(s.log_history, (v) => save({ log_history: v }))),
  ));
  add('Listening', 'sound', 'Sound & effects', card(
    setRow('Equalizer', s.eq?.on ? `On: ${s.eq.preset}` : 'Off. 10 bands, presets, preamp.', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openEq()) }, icon('sliders'), 'Open equalizer')),
    setRow('Slowed / reverb / sped up', 'Right-click any song, or use the wand in the player bar. Saved ones live in Library → My versions.', h('button', { class: 'btn', onclick: () => go('#/library/versions') }, icon('wand'), 'My versions')),
    setRow('Effects on every song', s.global_fx?.on ? `On: ${describeGlobal(s.global_fx.fx)}` : 'Off. Play everything slowed, reverbed, muffled… (saved versions keep their own).', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openFx(null, { global: true })) }, icon('wand'), 'Set up')),
    setRow('Background sounds', s.bg_sound?.on ? `On: ${Object.keys(s.bg_sound.mix || { [s.bg_sound.sound]: 1 }).length} sound${Object.keys(s.bg_sound.mix || {}).length === 1 ? '' : 's'} playing` : 'Rain, thunder, ocean, fireplace, crickets, café, train, noise. Mix up to 4. Plays under or between your music.', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openBg()) }, icon('cloudRain'), 'Open')),
  ));
  add('Listening', 'library', 'Library & import', card(
    setRow('Import from Spotify', 'Paste any Spotify playlist, album or song link (anyone’s), or copy your own playlists and liked songs.', h('button', { class: 'btn', onclick: () => go('#/import') }, icon('importIco'), 'Open')),
    setRow('Downloads', `${data.offline.count} songs • ${fmtBytes(data.offline.bytes)}`, h('button', { class: 'btn', onclick: () => go('#/library/downloads') }, 'Manage')),
  ));

  add('App', 'app', 'Window & startup', card(
    setRow('Keep playing when the window is closed', 'Music keeps going from the tray / menu bar, and the window’s memory is freed.', toggle(s.keep_playing_on_close, (v) => save({ keep_playing_on_close: v }))),
    setRow('Start Nocturne when the computer starts', 'Starts quietly in the background, ready for your media keys.', toggle(s.start_at_login, (v) => save({ start_at_login: v }))),
  ));
  add('App', 'shortcuts', 'Keyboard shortcuts', card(...shortcutRows()));
  const mem = data.memory || {};
  add('App', 'about', 'About', card(
    setRow('Memory', 'The background player. The window adds its own while it’s open.', h('div', { class: 'mono' }, `${(mem.engine || 0) + (mem.player || 0)} MB`)),
    setRow('Version', null, h('div', { class: 'mono' }, data.version)),
    setRow('Data folder', data.data_dir, h('div')),
  ));

  // ---- layout: category column + search + the cards
  const secs = groups.map((g) => {
    const sec = h('section', { class: 'set-sec', id: `set-${g.id}`, dataset: { id: g.id } }, h('h2', null, g.title), g.el);
    g.sec = sec;
    return sec;
  });
  const nav = h('nav', { class: 'set-nav' });
  let lastCat = null;
  for (const g of groups) {
    if (g.cat !== lastCat) { nav.append(h('div', { class: 'set-nav-cat' }, g.cat)); lastCat = g.cat; }
    g.link = h('a', { class: 'set-nav-item', href: `#/settings?s=${g.id}`, onclick: (e) => { e.preventDefault(); jump(g.id); } }, g.title);
    nav.append(g.link);
  }
  const scroller = () => document.getElementById('main-scroll');
  // a group's top inside the scroller, in CSS px (rects are screen px under Settings -> Size: divide by the zoom)
  const topOf = (sec) => { const sc = scroller(); return sc ? (sec.getBoundingClientRect().top - sc.getBoundingClientRect().top) / pageZoom() + sc.scrollTop : 0; };
  const jump = (id) => {
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    if (search.value) { search.value = ''; filter(''); }
    scroller()?.scrollTo({ top: Math.max(0, topOf(g.sec) - 70), behavior: 'smooth' });
    mark(id);
  };
  const mark = (id) => groups.forEach((g) => g.link.classList.toggle('on', g.id === id));

  // search: rows whose text matches; whole groups whose title matches; nothing found -> a hint
  const search = h('input', { class: 'input set-search', type: 'search', placeholder: 'Search settings (theme, icon, equalizer, startup…)', spellcheck: false });
  const none = h('div', { class: 'set-none' }, 'No settings match. Try another word.');
  const filter = (q) => {
    q = q.trim().toLowerCase();
    let any = false;
    for (const g of groups) {
      const titleHit = !q || g.title.toLowerCase().includes(q) || g.cat.toLowerCase().includes(q);
      let rowsHit = 0;
      g.el.querySelectorAll('.set-row, .acct').forEach((r) => {
        const hit = titleHit || r.textContent.toLowerCase().includes(q);
        r.classList.toggle('set-miss', !hit);
        if (hit) rowsHit++;
      });
      const show = titleHit || rowsHit > 0;
      g.sec.style.display = show ? '' : 'none';
      g.link.classList.toggle('dim', !show);
      if (show) any = true;
    }
    none.style.display = any ? 'none' : '';
  };
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; filter(''); } });
  none.style.display = 'none';

  el.append(pageHead('Settings'), h('div', { class: 'set-layout' }, nav, h('div', { class: 'set-body' }, search, none, ...secs)));

  // the category column follows the scroll: the group nearest the top is lit
  const onScroll = () => {
    const top = (scroller()?.scrollTop || 0) + 90;
    let cur = groups[0];
    for (const g of groups) if (g.sec.style.display !== 'none' && topOf(g.sec) <= top) cur = g;
    mark(cur.id);
  };
  scroller()?.addEventListener('scroll', onScroll, { passive: true });
  requestAnimationFrame(onScroll);
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('s');
  if (want) requestAnimationFrame(() => jump(want));
  return { title: 'Settings', cleanup: () => scroller()?.removeEventListener('scroll', onScroll) };
}

function describeGlobal(f) {
  if (!f) return '';
  const p = [];
  if ((f.speed ?? 1) < 0.97) p.push('slowed'); else if ((f.speed ?? 1) > 1.03) p.push('sped up');
  if (f.reverb) p.push('reverb');
  if (f.muffle) p.push('muffled');
  if ((f.bass || 0) > 3) p.push('bass boosted');
  return p.join(' + ') || 'custom';
}

function selectEl(opts, value, onChange) {
  const s = h('select', { class: 'select' }, ...opts.map(([v, l]) => { const o = h('option', { value: v }, l); if (v === value) o.selected = true; return o; }));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

let signingIn = false;
export async function signInGoogle() {
  if (!window.pywebview?.api?.sign_in_google) { pasteSignIn(); return; }
  if (signingIn) return;
  signingIn = true;
  toast('Opening Google sign-in… (if you already signed in once, this connects by itself)');
  try {
    const res = await window.pywebview.api.sign_in_google();
    if (res?.ok) { toast(`Signed in as ${res.account?.name || 'you'}`); dropCache('/'); setTimeout(() => location.reload(), 800); }
    else if (res?.error && !/closed/.test(res.error)) signInFailed(res.error);
  } catch (e) { signInFailed(String(e)); }
  finally { signingIn = false; }
}

function signInFailed(msg) {
  modal({
    title: 'Sign-in didn’t go through',
    body: h('div', null, h('p', null, msg), h('p', null, 'You can try again, or paste your sign-in from Brave instead.')),
    actions: [{ label: 'Paste instead', onClick: () => { setTimeout(pasteSignIn, 50); } }, { label: 'Try again', primary: true, onClick: () => { setTimeout(signInGoogle, 50); } }],
  });
}

export function pasteSignIn() {
  const ta = h('textarea', { class: 'input', rows: 6, placeholder: 'Paste here…' });
  const steps = h('ol', { class: 'steps' },
    h('li', null, 'In your browser, open ', h('b', null, 'music.youtube.com'), ' (signed in).'),
    h('li', null, 'Press ', h('b', null, isMac() ? '⌥⌘I' : 'F12'), ', open the ', h('b', null, 'Network'), ' tab, and type ', h('b', null, 'browse'), ' in its filter box.'),
    h('li', null, 'Click around YouTube Music once so a request shows up, right-click it → ', h('b', null, 'Copy → Copy as cURL'), '.'),
    h('li', null, 'Paste it below. It stays on this computer.'));
  modal({
    title: 'Paste your YouTube Music sign-in', wide: true, body: h('div', null, steps, ta),
    actions: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: async () => {
      try {
        const r = await post('/api/auth/youtube/paste', { text: ta.value });
        toast(`Signed in as ${r.account?.name || 'you'}`);
        setTimeout(() => location.reload(), 600);
      } catch (e) { toast(e.message, 'error'); return true; }
    } }],
  });
  setTimeout(() => ta.focus(), 60);
}

// ------------------------------------------------------------------ Spotify import
// Two ways in, one matcher/review/import: (a) a pasted link to ANY public playlist/album/song (no Spotify
// sign-in; the public embed gives the first 100 songs, bigger playlists are then read in full from the normal page
// by an off-screen browser window = tempo/spotify_full.py), (b) your own Spotify library (Connect).
const SP_KIND = { playlist: 'Playlist', album: 'Album', track: 'Song' };
const selAll = () => (isMac() ? '⌘A then ⌘C' : 'Ctrl+A then Ctrl+C');

// the full read didn't get them all (or can't run here): the song-links trick still brings the rest
function moreThan100(total, count, reason) {
  const why = reason ? `Nocturne could only read ${count} of the ${total} songs (${reason}).` : `Spotify only shows the first ${count} of ${total} songs without signing in.`;
  return h('div', { class: 'note sp-note' },
    `${why} To bring all ${total}: open it in the Spotify app, click any song, press ${selAll()}, and paste here — Nocturne reads the song links.`);
}

// what a pasted link points at; `actions` = buttons under it
export function spotifyPreview(p, actions = []) {
  if (p.kind === 'many') {
    const bits = [p.lists ? `${p.lists} playlist${p.lists > 1 ? 's' : ''}/album${p.lists > 1 ? 's' : ''}` : null, p.songs ? `${p.songs} song${p.songs > 1 ? 's' : ''}` : null].filter(Boolean);
    return h('div', { class: 'sp-preview' }, h('div', { class: 'art md liked-art', html: I.link }),
      h('div', { class: 'tt' }, h('div', { class: 'sp-pname' }, `${p.count} Spotify links`), h('div', { class: 'tsub' }, bits.join(' + '),
        p.songs > 1 ? ' — the songs go into one playlist' : '')), actions.length ? h('div', { class: 'sp-pact' }, ...actions) : null);
  }
  const sub = [SP_KIND[p.kind] || p.kind, p.owner ? (p.kind === 'playlist' ? 'by ' + p.owner : p.owner) : null,
    p.kind !== 'track' ? (p.total > p.count ? `${p.total} songs` : `${p.count} songs`) : null].filter(Boolean).join(' • ');
  const wrap = h('div', null, h('div', { class: 'sp-preview' }, p.image ? img(p.image, 'md') : h('div', { class: 'art md liked-art', html: I.music }),
    h('div', { class: 'tt' }, h('div', { class: 'sp-pname' }, p.name), h('div', { class: 'tsub' }, sub)),
    actions.length ? h('div', { class: 'sp-pact' }, ...actions) : null));
  if (p.total > p.count && p.full) {
    wrap.append(h('div', { class: 'muted small sp-gap sp-full' }, `All ${p.total} songs get read when you start — takes a few seconds.`));
  } else if (p.total > p.count) wrap.append(moreThan100(p.total, p.count));
  if (p.kind === 'track') {
    const m = p.match || {};
    const opts = [m.track || m.best, ...(m.alts || [])].filter(Boolean);
    if (!opts.length) wrap.append(h('div', { class: 'muted small sp-gap' }, 'Couldn’t find this song on YouTube Music.'));
    else {
      wrap.append(h('div', { class: 'label sp-gap' }, m.status === 'good' ? 'On YouTube Music' : 'Closest on YouTube Music'),
        trackList(opts.slice(0, 4), { header: false, showAlbum: false, context: { type: 'search', title: p.name } }));
    }
  }
  return wrap;
}

function linkCard(state, rerender) {
  const step = h('div', { class: 'step' }, h('div', { class: 'step-num' }, icon('link')));
  const b = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, 'Paste a Spotify link'),
    h('div', { class: 'muted small' }, 'Any public playlist, album or song — someone else’s too. No Spotify sign-in needed.'));
  step.append(b);
  const ta = h('textarea', { class: 'input sp-link', rows: 2, spellcheck: 'false', placeholder: 'https://open.spotify.com/playlist/…' });
  ta.value = state.text || '';
  const prev = h('div', { class: 'sp-prev' });
  const go_ = h('button', { class: 'btn primary', onclick: async () => {
    const text = ta.value.trim();
    if (!text) return toast('Paste a Spotify link first', 'error');
    await run(() => post('/api/spotify/match_link', { text }));
    state.scroll = true;
    rerender();
  } }, 'Find songs on YouTube Music');
  let tm = null, seq = 0;
  const show = async () => {
    const text = ta.value.trim();
    state.text = ta.value;
    if (!text) { prev.replaceChildren(); state.preview = null; return; }
    if (state.preview && state.preview.text === text) { draw(state.preview.p); return; }
    const n = ++seq;
    prev.replaceChildren(skeleton('list'));
    try {
      const p = await get('/api/spotify/link?text=' + encodeURIComponent(text));
      if (n !== seq) return;
      state.preview = { text, p };
      draw(p);
    } catch (e) { if (n === seq) prev.replaceChildren(h('div', { class: 'muted small sp-gap' }, e.message)); }
  };
  const draw = (p) => {
    prev.replaceChildren(spotifyPreview(p));
    go_.textContent = p.kind === 'track' ? 'Add it to a new playlist' : 'Find songs on YouTube Music';
  };
  ta.addEventListener('paste', () => setTimeout(show, 0));
  ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(show, 450); });
  b.append(ta, prev, h('div', { class: 'row-inline' }, go_));
  if (ta.value.trim()) show();
  return step;
}

export async function importView(_, el, query) {
  el.append(pageHead('Import from Spotify', 'Copies Spotify playlists, albums and liked songs into your YouTube Music account — yours or anyone’s. Nothing is written until you press Import.'));
  const body = h('div', { class: 'import' });
  el.append(body);
  let timer = null;
  const linkState = { text: query?.get('link') || '', preview: null, scroll: false };
  const render = async () => {
    clearTimeout(timer);
    const st = await get('/api/spotify');
    body.innerHTML = '';
    if (!signedIn()) body.append(signInCard('Imports go into your YouTube Music account, so connect it first.'));
    const job = st.job;
    if (job && !job.finished) {
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      body.append(h('div', { class: 'step' }, h('div', { class: 'step-num' }, '…'), h('div', { class: 'step-body' },
        h('div', { class: 'step-title' }, job.message || 'Working…'), h('div', { class: 'bar big' }, h('i', { style: { width: pct + '%' } })),
        h('div', { class: 'muted small' }, job.total ? `${job.done} of ${job.total}` : ''))));
      linkState.scroll = true;
      timer = setTimeout(render, 900);
      return;
    }
    if (job && job.phase === 'error') body.append(h('div', { class: 'callout error' }, job.error));
    if (job && job.phase === 'imported') {
      const j = await get('/api/spotify/job');
      body.append(h('div', { class: 'callout ok' }, h('div', { class: 'callout-ico', html: I.check }), h('div', { class: 'callout-text' },
        h('div', { class: 'callout-title' }, 'Imported to YouTube Music'),
        h('div', null, (j.job?.made || []).map((m) => `${m.name}: ${m.count} songs`).join(' • ')))));
      dropCache('/api/library'); myPlaylists(true);
    }
    body.append(linkCard(linkState, render));
    // a fresh match goes right under the link box, where the user is looking
    if (st.has_results) {
      const rv = await reviewStep(render);
      body.append(rv);
      if (linkState.scroll && job?.phase === 'matched') { linkState.scroll = false; requestAnimationFrame(() => rv.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
    }
    body.append(h('div', { class: 'sp-or' }, h('span', null, 'Or bring over your own Spotify library')));
    // step 1: connect
    const step1 = h('div', { class: `step ${st.connected ? 'done' : ''}` }, h('div', { class: 'step-num' }, st.connected ? icon('check') : '1'));
    const s1 = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, st.connected ? `Spotify connected${st.user ? ' — ' + st.user : ''}` : 'Connect Spotify'));
    if (!st.connected) {
      const cid = h('input', { class: 'input', placeholder: 'Client ID (32 letters and numbers)' });
      s1.append(h('div', { class: 'muted small' }, 'Only needed for your liked songs and private playlists.'),
        h('ol', { class: 'steps' },
        h('li', null, 'Open ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openExternal('https://developer.spotify.com/dashboard'); } }, 'developer.spotify.com/dashboard'), ' and log in (Premium is required by Spotify).'),
        h('li', null, 'Create app → any name → ', h('b', null, 'Web API'), ', and add this Redirect URI: ',
          h('code', { class: 'copyable', title: 'Click to copy', onclick: () => { navigator.clipboard?.writeText(st.redirect); toast('Copied'); } }, st.redirect)),
        h('li', null, 'Copy the app’s ', h('b', null, 'Client ID'), ' here:')),
        h('div', { class: 'row-inline' }, cid, h('button', { class: 'btn primary', onclick: async () => {
          if (cid.value.trim().length < 20) return toast('That doesn’t look like a Client ID', 'error');
          await run(() => post('/api/spotify/config', { client_id: cid.value.trim() }));
          await run(() => post('/api/spotify/login'), 'Finish signing in to Spotify in your browser');
          poll();
        } }, 'Connect')));
      if (st.client_id) s1.append(h('div', { class: 'muted small' }, 'Already added a Client ID? ', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await run(() => post('/api/spotify/login'), 'Finish signing in to Spotify in your browser'); poll(); } }, 'Sign in again')));
    } else {
      s1.append(h('div', { class: 'muted small' }, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await post('/api/spotify/disconnect'); render(); } }, 'Disconnect')));
    }
    step1.append(s1);
    body.append(step1);
    if (!st.connected) return;

    // step 2: pick playlists
    const step2 = h('div', { class: 'step' }, h('div', { class: 'step-num' }, '2'));
    const s2 = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, 'Choose what to bring over'));
    step2.append(s2);
    body.append(step2);
    s2.append(skeleton('list'));
    let lists = [];
    try { lists = (await get('/api/spotify/playlists')).items; } catch (e) { s2.lastChild.remove(); s2.append(errorBox(e, render)); return; }
    s2.lastChild.remove();
    const checks = new Map();
    const pl = h('div', { class: 'sp-lists' });
    for (const l of lists) {
      const ok = l.id === 'liked' || l.mine !== false;
      const cb = h('input', { type: 'checkbox' });
      cb.checked = ok && l.id === 'liked';
      cb.disabled = !ok;
      checks.set(l.id, { cb, name: l.name });
      pl.append(h('label', { class: `sp-item ${ok ? '' : 'dim'}`, title: ok ? '' : 'Spotify only shares playlists you made here — paste its link in the box above instead' },
        cb, l.image ? img(l.image, 'sm') : h('div', { class: 'art sm liked-art', html: I.heartFill }),
        h('div', { class: 'tt' }, h('div', { class: 'tname' }, l.name), h('div', { class: 'tsub' }, [l.owner, l.count != null ? `${l.count} songs` : null].filter(Boolean).join(' • ')))));
    }
    s2.append(pl, h('div', { class: 'row-inline' },
      h('button', { class: 'btn', onclick: () => checks.forEach(({ cb }) => { if (!cb.disabled) cb.checked = true; }) }, 'Select all'),
      h('button', { class: 'btn primary', onclick: async () => {
        const ids = [...checks].filter(([, v]) => v.cb.checked).map(([k]) => k);
        if (!ids.length) return toast('Pick at least one', 'error');
        const names = Object.fromEntries([...checks].map(([k, v]) => [k, v.name]));
        await run(() => post('/api/spotify/match', { ids, names }));
        linkState.scroll = true;
        render();
      } }, 'Find songs on YouTube Music')));
  };
  let pollT = null;   // waiting for the browser sign-in; stopped when you leave the page (it used to run on for 3 min)
  const poll = () => { clearInterval(pollT); let n = 0; pollT = setInterval(async () => { n++; const st = await get('/api/spotify').catch(() => null); if (st?.connected || n > 120) { clearInterval(pollT); if (body.isConnected) render(); } }, 1500); };
  await render();
  const off = on('spotify', () => render());
  return { title: 'Import from Spotify', cleanup: () => { off(); clearTimeout(timer); clearInterval(pollT); } };
}

async function reviewStep(rerender) {
  const res = await get('/api/spotify/results');
  const wrap = h('div', { class: 'step sp-review' }, h('div', { class: 'step-num' }, icon('check')));
  const b = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, 'Check the matches'));
  wrap.append(b);
  const c = res.counts || {};
  const total = (c.good || 0) + (c.unsure || 0) + (c.missing || 0);
  b.append(h('div', { class: 'match-stats' },
    h('div', { class: 'stat good' }, h('b', null, c.good || 0), 'found'), h('div', { class: 'stat unsure' }, h('b', null, c.unsure || 0), 'not sure'),
    h('div', { class: 'stat missing' }, h('b', null, c.missing || 0), 'not found'),
    h('div', { class: 'muted small' }, total ? `${Math.round(((c.good || 0) / total) * 100)}% matched automatically` : '')));
  const includeUnsure = h('input', { type: 'checkbox' });
  includeUnsure.checked = true;
  const lists = res.lists || [];
  const nameInputs = new Map();
  for (const l of lists) {
    const unsure = l.items.map((it, i) => ({ it, i })).filter(({ it }) => it.match?.status !== 'good');
    if (l.id !== 'liked' && lists.length <= 4) {
      const inp = h('input', { class: 'input', value: l.name, maxlength: 150, title: 'Name of the new YouTube Music playlist' });
      nameInputs.set(l.id, inp);
      b.append(h('div', { class: 'row-inline sp-name' }, h('span', { class: 'muted small' }, 'New playlist'), inp));
    }
    if (l.total > l.items.length) b.append(moreThan100(l.total, l.items.length, l.short_reason));
    const det = h('details', { class: 'review' }, h('summary', null, h('b', null, l.name), h('span', { class: 'muted' }, ` — ${l.items.length - unsure.length} found, ${unsure.length} to check`)));
    for (const { it, i } of unsure.slice(0, 200)) {
      const m = it.match || {};
      const opts = [m.track, ...(m.alts || [])].filter(Boolean);
      const row = h('div', { class: 'rv-row' },
        h('div', { class: 'rv-src' }, h('div', { class: 'tname' }, it.src.name), h('div', { class: 'tsub' }, it.src.artists.join(', '), ' • ', fmtTime(it.src.ms / 1000))),
        h('div', { class: 'rv-arrow', html: I.right }));
      const pick = h('div', { class: 'rv-picks' });
      opts.forEach((t, k) => {
        const chosen = k === 0 && m.status !== 'missing';
        const opt = h('button', { class: `rv-opt ${chosen ? 'on' : ''}`, title: 'Use this one', onclick: async () => {
          await post('/api/spotify/choose', { list: l.id, index: i, track: t });
          pick.querySelectorAll('.rv-opt').forEach((x) => x.classList.remove('on'));
          opt.classList.add('on');
        } }, img(t.thumb, 'xs'), h('div', { class: 'tt' }, h('div', { class: 'tname' }, t.title), h('div', { class: 'tsub' }, t.artist, ' • ', fmtTime(t.dur))));
        pick.append(opt);
      });
      pick.append(h('button', { class: 'rv-opt skip', onclick: async () => { await post('/api/spotify/choose', { list: l.id, index: i, track: null }); pick.querySelectorAll('.rv-opt').forEach((x) => x.classList.remove('on')); pick.lastChild.classList.add('on'); } }, 'Skip'));
      row.append(pick);
      det.append(row);
    }
    b.append(det);
  }
  b.append(h('label', { class: 'row-inline check' }, includeUnsure, 'Include “not sure” songs (the highlighted pick is used)'),
    h('div', { class: 'row-inline' }, h('button', { class: 'btn primary', onclick: async () => {
      if (!signedIn()) return needSignIn('import');
      const names = Object.fromEntries([...nameInputs].map(([k, inp]) => [k, inp.value.trim()]));
      await run(() => post('/api/spotify/import', { ids: lists.map((l) => l.id), include_unsure: includeUnsure.checked, names }));
      rerender();
    } }, icon('importIco'), 'Import to YouTube Music')));
  return wrap;
}

// top search box got a Spotify link
async function spotifySearch(body, q) {
  body.append(skeleton('list'));
  let p;
  try { p = await get('/api/spotify/link?text=' + encodeURIComponent(q)); } catch (e) { body.replaceChildren(errorBox(e)); return; }
  body.replaceChildren();
  const acts = [];
  if (p.kind !== 'track') {
    acts.push(h('button', { class: 'btn primary', onclick: async () => {
      await run(() => post('/api/spotify/match_link', { text: q }));
      go(`#/import?link=${encodeURIComponent(q)}`);
    } }, icon('importIco'), 'Copy to YouTube Music'));
    if (p.kind === 'album') acts.push(h('button', { class: 'btn', onclick: () => go(`#/search?q=${encodeURIComponent(`${p.name} ${p.owner || ''}`.trim())}&filter=albums`) }, icon('search'), 'Find the album'));
  }
  body.append(h('div', { class: 'label' }, 'Spotify link'), spotifyPreview(p, acts));
}

export function openExternal(url) {
  if (window.pywebview?.api?.open_external) window.pywebview.api.open_external(url);
  else post('/api/open', { url }).catch(() => window.open(url, '_blank'));
}

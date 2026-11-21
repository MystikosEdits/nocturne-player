// Every page in the main area.
import { I } from './icons.js';
import { get, post, cached, dropCache, cmd } from './api.js';
import {
  h, icon, btn, pill, img, go, store, on, emit, trackList, shelf, grid, card, empty, skeleton, errorBox, toast, run, modal,
  prompt, playTracks, playKind, playItem, collectionMenu, artColor, fmtTime, fmtBytes, artistLinks, myPlaylists, mod, isMac,
  copyLink, menu, addToPlaylistMenu, needSignIn,
} from './ui.js';

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
  if (!q) { el.append(empty('search', 'Search for anything', 'Songs, artists, albums, playlists — or paste a YouTube link.')); return { title: 'Search' }; }
  const body = h('div');
  el.append(body);
  body.append(skeleton(f && f !== 'albums' && f !== 'artists' && f !== 'playlists' ? 'list' : 'shelves'));
  const data = await cached(`/api/search?q=${encodeURIComponent(q)}${f ? '&filter=' + f : ''}`, 5 * 60000);
  body.innerHTML = '';
  if (data.link) { handleLink(data.link); return { title: 'Search' }; }
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
const bigPlay = (onClick) => h('button', { class: 'bigplay', title: 'Play', onclick: onClick }, icon('play'));

export async function playlist(id, el) {
  el.append(skeleton('list'));
  const p = await cached('/api/playlist/' + id, 60000);
  el.innerHTML = '';
  el.classList.add('tinted');
  tint(el, p.thumb);
  const total = p.tracks.reduce((a, t) => a + (t.dur || 0), 0);
  const meta = [p.author, p.year, `${p.tracks.length} songs`, total ? fmtLong(total) : p.duration].filter(Boolean).join(' • ');
  el.append(collHeader({ thumb: p.thumb, type: id === 'LM' ? 'Your likes' : 'Playlist', title: p.title, meta, desc: p.desc }));
  const ctx = { type: 'playlist', id, title: p.title };
  const dlAll = () => run(() => post('/api/downloads/add', { tracks: p.tracks }));
  el.append(actionRow(
    bigPlay(() => playTracks(p.tracks, 0, ctx, false)),
    btn('shuffle', 'Shuffle', () => playTracks(p.tracks, Math.floor(Math.random() * p.tracks.length), ctx, true), 'lg'),
    btn('radio', 'Radio', () => run(() => post('/api/play', { kind: 'radio', playlistId: id.startsWith('RD') ? id : 'RDAMPL' + id, title: `${p.title} radio` })), 'lg'),
    btn('download', 'Download all', dlAll, 'lg'),
    btn('more', 'More', (e) => menu(e.clientX, e.clientY, [
      { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: p.tracks }), 'Added to queue') },
      { label: 'Copy link', icon: 'link', onClick: () => copyLink({ id }, 'playlist') },
      p.owned && id !== 'LM' ? '-' : null,
      p.owned && id !== 'LM' ? { label: 'Delete playlist', icon: 'trash', danger: true, onClick: () => confirmDelete(id, p.title) } : null,
    ]), 'lg')));
  if (!p.tracks.length) el.append(empty('music', 'This playlist is empty', p.owned ? 'Right-click any song and choose “Add to playlist”.' : ''));
  else el.append(trackList(p.tracks, { context: ctx, playlistId: id, owned: p.owned, onChanged: () => location.reload() }));
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
  el.append(actionRow(
    bigPlay(() => playTracks(a.tracks, 0, ctx, false)),
    btn('shuffle', 'Shuffle', () => playTracks(a.tracks, 0, ctx, true), 'lg'),
    saveBtn,
    btn('download', 'Download album', () => run(() => post('/api/downloads/add', { tracks: a.tracks })), 'lg'),
    btn('more', 'More', (e) => menu(e.clientX, e.clientY, [
      { label: 'Add to queue', icon: 'addQueue', onClick: () => run(() => post('/api/queue/add', { tracks: a.tracks }), 'Added to queue') },
      signedIn() ? { label: 'Add to playlist', icon: 'plus', sub: () => addToPlaylistMenu(a.tracks) } : null,
      { label: 'Copy link', icon: 'link', onClick: () => copyLink({ id: a.id }, 'album') },
    ]), 'lg')));
  el.append(trackList(a.tracks, { context: ctx, showArt: false, showAlbum: false }));
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
    body.append(items.length ? trackList(items, { context: { type: 'history', title: 'History' } }) : empty('history', 'No history yet'));
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
    body.append(h('div', { class: 'note' }, 'Songs you’ve slowed, reverbed, sped up or bass-boosted. Right-click any song → ', h('b', null, 'Slowed / reverb / sped up…'), ' to make one. They play with their effects anywhere: queue, shuffle, downloads.'));
    if (!items.length) { body.append(empty('wand', 'No versions yet', 'Right-click any song and choose “Slowed / reverb / sped up…”.')); return; }
    body.append(actionRow(bigPlay(() => playKind('versions', 'versions')), btn('shuffle', 'Shuffle', () => playKind('versions', 'versions', { shuffle: true }), 'lg')));
    body.append(trackList(items, { onPlay: (i) => playKind('versions', 'versions', { index: i }) }));
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
  const render = async () => {
    const { items } = await get('/api/library/offline');
    const st = await get('/api/downloads');
    body.innerHTML = '';
    body.append(h('div', { class: 'note' }, `${items.length} song${items.length === 1 ? '' : 's'} saved for offline • ${fmtBytes(st.bytes)}. Downloaded songs play without internet and start instantly.`));
    if (st.active) body.append(h('div', { class: 'dl-active' }, icon('download'), h('span', null, `Downloading “${st.active.title}”`), h('div', { class: 'bar' }, h('i', { style: { width: Math.round((st.active.progress || 0) * 100) + '%' } })), st.queued ? h('span', { class: 'muted' }, `+${st.queued} waiting`) : null));
    if (!items.length) { body.append(empty('download', 'No downloads yet', 'Right-click a song, or use the download button on any playlist or album.')); return; }
    body.append(actionRow(bigPlay(() => playKind('offline', 'offline')), btn('shuffle', 'Shuffle', () => playKind('offline', 'offline', { shuffle: true }), 'lg')));
    body.append(trackList(items, { onPlay: (i) => playKind('offline', 'offline', { index: i }), extraMenu: (t) => [{ label: 'Remove download', icon: 'trash', danger: true, onClick: () => run(() => post('/api/downloads/remove', { ids: [t.id] })).then(render) }] }));
  };
  await render();
  let tm = null;
  const off = on('downloads', () => { clearTimeout(tm); tm = setTimeout(render, 600); });
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

export async function settings(_, el) {
  const data = await get('/api/settings');
  const s = data.settings;
  const save = (patch) => run(() => post('/api/settings', patch)).then(() => Object.assign(s, patch));
  el.append(pageHead('Settings'));

  // account
  const auth = store.state?.auth || {};
  const acct = h('div', { class: 'set-card' });
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
  el.append(h('section', { class: 'set-sec' }, h('h2', null, 'Account'), acct));

  const { appearanceSection } = await import('./appearance.js');
  el.append(appearanceSection());

  el.append(section('Sound',
    setRow('Equalizer', s.eq?.on ? `On: ${s.eq.preset}` : 'Off. 10 bands, presets, preamp.', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openEq()) }, icon('sliders'), 'Open equalizer')),
    setRow('Slowed / reverb / sped up', 'Right-click any song, or use the wand in the player bar. Saved ones live in Library → My versions.', h('button', { class: 'btn', onclick: () => go('#/library/versions') }, icon('wand'), 'My versions')),
    setRow('Effects on every song', s.global_fx?.on ? `On: ${describeGlobal(s.global_fx.fx)}` : 'Off. Play everything slowed, reverbed, muffled… (saved versions keep their own).', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openFx(null, { global: true })) }, icon('wand'), 'Set up')),
    setRow('Background sounds', s.bg_sound?.on ? `On: ${Object.keys(s.bg_sound.mix || { [s.bg_sound.sound]: 1 }).length} sound${Object.keys(s.bg_sound.mix || {}).length === 1 ? '' : 's'} playing` : 'Rain, thunder, ocean, fireplace, crickets, café, train, noise. Mix up to 4. Plays under or between your music.', h('button', { class: 'btn', onclick: () => import('./fxpanel.js').then((m) => m.openBg()) }, icon('cloudRain'), 'Open')),
  ));

  el.append(section('Playback',
    setRow('Audio quality', 'Best: a song you click starts instantly, and everything queued after it loads at 256 kbps (Premium). Downloads are always 256 kbps. Data saver uses less internet.',
      selectEl([['best', 'Best available'], ['normal', 'Data saver']], s.quality, (v) => save({ quality: v }))),
    setRow('Autoplay similar songs', 'When your queue ends, keep going with songs like the last one.', toggle(s.autoplay, (v) => cmd('autoplay', v))),
    setRow('Even out volume', 'Keeps loud and quiet songs at a similar level.', toggle(s.normalize, (v) => save({ normalize: v }))),
    setRow('Count plays in my YouTube history', 'Songs you play teach YouTube Music’s recommendations, same as the official app.', toggle(s.log_history, (v) => save({ log_history: v }))),
  ));

  el.append(section('App',
    setRow('Keep playing when the window is closed', 'Music keeps going from the tray / menu bar, and the window’s memory is freed.', toggle(s.keep_playing_on_close, (v) => save({ keep_playing_on_close: v }))),
    setRow('Start Nocturne when the computer starts', 'Starts quietly in the background, ready for your media keys.', toggle(s.start_at_login, (v) => save({ start_at_login: v }))),
  ));

  el.append(section('Music from elsewhere',
    setRow('Import from Spotify', 'Copy your Spotify playlists and liked songs into YouTube Music.', h('button', { class: 'btn', onclick: () => go('#/import') }, icon('importIco'), 'Open')),
    setRow('Downloads', `${data.offline.count} songs • ${fmtBytes(data.offline.bytes)}`, h('button', { class: 'btn', onclick: () => go('#/library/downloads') }, 'Manage')),
  ));

  const mem = data.memory || {};
  el.append(section('Shortcuts', ...shortcutRows()));
  el.append(section('About',
    setRow('Memory', 'The background player. The window adds its own while it’s open.', h('div', { class: 'mono' }, `${(mem.engine || 0) + (mem.player || 0)} MB`)),
    setRow('Version', null, h('div', { class: 'mono' }, data.version)),
    setRow('Data folder', data.data_dir, h('div')),
  ));
  return { title: 'Settings' };
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

function shortcutRows() {
  const m = mod();
  const rows = [
    ['Play / pause', 'Space'], ['Next / previous song', `${m} →  /  ${m} ←`], ['Seek 10 s', '→  /  ←'], ['Volume', `${m} ↑  /  ${m} ↓`],
    ['Search', `${m} K  or  /`], ['Like current song', 'L'], ['Shuffle / repeat', 'S  /  R'], ['Queue / lyrics', 'Q  /  Y'], ['Now playing', 'F'], ['Mute', 'M'],
    ['Slowed / reverb / sped up', 'V'], ['Equalizer', 'E'], ['Background sounds on / off', 'B'], ['Collapse / expand the sidebar', '['], ['Wider queue / lyrics panel', ']'], ['Mini player', 'P'],
  ];
  return rows.map(([a, k]) => h('div', { class: 'set-row slim' }, h('div', { class: 'set-title' }, a), h('div', { class: 'keys' }, k)));
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
export async function importView(_, el) {
  el.append(pageHead('Import from Spotify', 'Copies your Spotify playlists and liked songs into your YouTube Music account. Nothing is written until you press Import.'));
  const body = h('div', { class: 'import' });
  el.append(body);
  let timer = null;
  const render = async () => {
    clearTimeout(timer);
    const st = await get('/api/spotify');
    body.innerHTML = '';
    if (!signedIn()) body.append(signInCard('Imports go into your YouTube Music account, so connect it first.'));
    // step 1: connect
    const step1 = h('div', { class: `step ${st.connected ? 'done' : ''}` }, h('div', { class: 'step-num' }, st.connected ? icon('check') : '1'));
    const s1 = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, st.connected ? `Spotify connected${st.user ? ' — ' + st.user : ''}` : 'Connect Spotify'));
    if (!st.connected) {
      const cid = h('input', { class: 'input', placeholder: 'Client ID (32 letters and numbers)' });
      s1.append(h('ol', { class: 'steps' },
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

    const job = st.job;
    if (job && !job.finished) {
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      body.append(h('div', { class: 'step' }, h('div', { class: 'step-num' }, '…'), h('div', { class: 'step-body' },
        h('div', { class: 'step-title' }, job.message || 'Working…'), h('div', { class: 'bar big' }, h('i', { style: { width: pct + '%' } })),
        h('div', { class: 'muted small' }, job.total ? `${job.done} of ${job.total}` : ''))));
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
      pl.append(h('label', { class: `sp-item ${ok ? '' : 'dim'}`, title: ok ? '' : 'Spotify only shares playlists you made or collaborate on' },
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
        render();
      } }, 'Find songs on YouTube Music')));
    if (st.has_results) body.append(await reviewStep(render));
  };
  const poll = () => { let n = 0; const t = setInterval(async () => { n++; const st = await get('/api/spotify').catch(() => null); if (st?.connected || n > 120) { clearInterval(t); render(); } }, 1500); };
  await render();
  const off = on('spotify', () => render());
  return { title: 'Import from Spotify', cleanup: () => { off(); clearTimeout(timer); } };
}

async function reviewStep(rerender) {
  const res = await get('/api/spotify/results');
  const wrap = h('div', { class: 'step' }, h('div', { class: 'step-num' }, '3'));
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
  for (const l of res.lists || []) {
    const unsure = l.items.map((it, i) => ({ it, i })).filter(({ it }) => it.match?.status !== 'good');
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
      await run(() => post('/api/spotify/import', { ids: (res.lists || []).map((l) => l.id), include_unsure: includeUnsure.checked }));
      rerender();
    } }, icon('importIco'), 'Import to YouTube Music')));
  return wrap;
}

export function openExternal(url) {
  if (window.pywebview?.api?.open_external) window.pywebview.api.open_external(url);
  else post('/api/open', { url }).catch(() => window.open(url, '_blank'));
}

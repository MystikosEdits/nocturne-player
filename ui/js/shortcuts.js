// Every keyboard shortcut, in ONE list: Settings -> Shortcuts and the "?" sheet both draw from it (README lists the same).
import { h, modal, mod } from './ui.js';

export function shortcutGroups() {
  const m = mod();
  return [
    ['Playback', [
      ['Play / pause', 'Space'], ['Next / previous song', `${m} →  /  ${m} ←`], ['Seek 10 s', '→  /  ←'],
      ['Volume', `${m} ↑  /  ${m} ↓`], ['Mute', 'M'], ['Like the song', 'L'], ['Shuffle / repeat', 'S  /  R'],
    ]],
    ['Song lists', [
      ['Select a song', 'Click'], ['Add to the selection', `${m} click`], ['Select a range', 'Shift click'], ['Select all', `${m} A`],
      ['Play the selection', 'Enter'], ['Remove from your playlist', 'Delete'], ['Clear the selection', 'Esc'],
      ['Find in the list', `${m} F`], ['Add to a playlist / the queue', 'Drag'],
    ]],
    ['Views', [
      ['Search', `${m} K  or  /`], ['Queue / lyrics', 'Q  /  Y'], ['Now playing', 'F'], ['Mini player', 'P'],
      ['Collapse / expand the sidebar', '['], ['Wider queue / lyrics panel', ']'], ['Back / forward', 'Alt ←  /  Alt →'],
      ['This list of shortcuts', '?'],
    ]],
    ['Sound', [
      ['Slowed / reverb / sped up', 'V'], ['Equalizer', 'E'], ['Background sounds on / off', 'B'],
    ]],
  ];
}

const row = ([a, k]) => h('div', { class: 'set-row slim' }, h('div', { class: 'set-title' }, a), h('div', { class: 'keys' }, k));

export function shortcutRows() {
  return shortcutGroups().flatMap(([g, rows]) => [h('div', { class: 'keys-group' }, g), ...rows.map(row)]);
}

let open = null;
export function showShortcuts() {
  if (open) { open.close(); return; }
  open = modal({
    title: 'Keyboard shortcuts', wide: true,
    body: h('div', { class: 'keys-sheet' }, ...shortcutGroups().map(([g, rows]) => h('div', { class: 'keys-col' }, h('div', { class: 'keys-group' }, g), ...rows.map(row)))),
    onClose: () => { open = null; },
  });
  open.box.classList.add('keys-modal');
}

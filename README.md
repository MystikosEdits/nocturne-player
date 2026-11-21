# Nocturne

A light, fast music player for Windows and Mac that plays from **YouTube Music** (and any YouTube video), with
YouTube Music's own recommendations, radio and mixes. It runs as a small background player instead of a browser tab:
about 65 MB with the window closed, and the music keeps going when you close the window.

## What it does

- **Everything on YouTube Music**: search, your playlists, liked songs, albums, artists, history, home mixes, radio
  from any song, autoplay that keeps going. Covers, remixes and anything else on YouTube play too (paste a link).
- **Gapless playback**, synced lyrics, a full-screen Now Playing view, queue with drag to reorder, sleep timer,
  downloads for offline listening, media keys and the Windows / macOS media controls.
- **Slowed / reverb / sped up / muffled versions** of any song (right-click it), saved to "My versions" and usable
  in playlists. Or put an effect on every song.
- **10-band equalizer** with presets, plus volume levelling.
- **Background sounds**: rain, thunder, ocean, fireplace, crickets, café, train, airplane, fan, noise. Mix up to 4.
- **Looks**: 25 themes, any accent colour (or rainbow), album-art / gradient / image backgrounds, glass panels,
  snow / starfield / embers effects, size, corners, fonts.
- **Layout**: collapsible sidebar, playlist pins and folders, resizable panels, a mini player (`P`).
- **Mac menu bar**: click Nocturne's icon at the top of the screen for the current song (cover, progress, play/pause,
  skip, like); right-click for the menu. "Player on desktop" puts a widget-sized player on your desktop.
- **Spotify import**: paste a link to any public Spotify playlist, album or song (anyone's, no Spotify login) into the
  search box or Settings → Import from Spotify, or bring over your own playlists and liked songs.

## Install

### Windows 10 / 11
1. Download this repo: green **Code** button → **Download ZIP**, and unzip it somewhere it can stay
   (for example `Documents\Nocturne`). Or `git clone` it.
2. In that folder, right-click **`setup_windows.ps1`** → **Run with PowerShell**.
   It installs Python 3.13 if you don't have it, the app's packages, and the mpv player, makes Start menu and Desktop
   shortcuts, and opens Nocturne. Takes a few minutes the first time.
   - If Windows blocks the script, open PowerShell in the folder and run:
     `powershell -ExecutionPolicy Bypass -File setup_windows.ps1`

### Mac (Apple silicon or Intel, macOS 15 or newer)
1. Download / unzip (or clone) this repo somewhere it can stay, for example `~/Nocturne`.
2. In Terminal: `cd ~/Nocturne && bash setup_mac.sh`
3. Open **Nocturne** from `~/Applications` or Spotlight. If macOS warns that it can't check the app, right-click it →
   **Open** once.
4. The menu-bar panel is compiled on your Mac and needs Apple's free Command Line Tools (`xcode-select --install`,
   then run `bash setup_mac.sh` again). Without them Nocturne still works, with a plain menu-bar icon.

## First run

- **Sign in** (Settings → Sign in with Google) to get your own library, likes, history and recommendations.
  With YouTube Music Premium, songs stream at 256 kbps; without signing in it still plays at about 130 kbps.
  If Google blocks the sign-in window, use the "paste your sign-in" link under the button.
- **Spotify import** (optional): paste a Spotify link into the search box — that needs nothing else. Big playlists come
  over whole: Nocturne reads every song from Spotify's public page in a browser window you never see (500 songs take
  about 15 seconds). If that ever fails it still gets the first 100; then open the playlist in the Spotify app, click a
  song, press Ctrl+A then Ctrl+C, and paste, and Nocturne reads each song link. To bring over your own liked songs / private playlists you need your own free Spotify app key:
  developer.spotify.com/dashboard → Create app → Redirect URI `http://127.0.0.1:8737/spotify/callback`, tick
  **Web API** → copy the **Client ID** into Nocturne.

## Keyboard

Space play/pause · Ctrl ←/→ previous/next · ←/→ seek 10 s · Ctrl ↑/↓ volume · L like · S shuffle · R repeat ·
Q queue · Y lyrics · F Now Playing · V slowed/reverb · E equalizer · B background sounds · `[` sidebar ·
`]` wide panel · P mini player · Ctrl K search

## Notes

- Your data (sign-in, settings, downloads) stays on your computer: `%APPDATA%\Tempo` on Windows,
  `~/Library/Application Support/Tempo` on Mac. Nothing is sent anywhere except YouTube (and Spotify if you import).
- Nocturne keeps its YouTube downloader (yt-dlp) updated by itself, so it keeps working when YouTube changes things.
- Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ytmusicapi](https://github.com/sigma67/ytmusicapi),
  [mpv](https://mpv.io) and [pywebview](https://pywebview.flowrl.com). For personal use.

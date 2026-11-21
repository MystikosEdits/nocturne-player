"""OS media integration: media keys, the Windows media flyout (SMTC), and macOS Now Playing / Control Center."""
from __future__ import annotations

import logging
from datetime import timedelta

from . import config

log = logging.getLogger("tempo.media")


class _Base:
    def __init__(self, engine):
        self.engine = engine
        self._last_key = None

    def _do(self, action: str, arg=None):
        loop = self.engine.loop
        e = self.engine

        async def run():
            if action == "play":
                await e.play()
            elif action == "pause":
                await e.pause()
            elif action == "toggle":
                await e.toggle()
            elif action == "next":
                await e.next()
            elif action == "prev":
                await e.prev()
            elif action == "seek":
                await e.seek(arg)
            elif action == "shuffle":
                await e.set_shuffle(bool(arg))
            elif action == "repeat":
                await e.set_repeat(arg)
        loop.call_soon_threadsafe(lambda: loop.create_task(run()))

    def update(self, track, playing, pos, dur):
        pass

    def close(self):
        pass


class WindowsMedia(_Base):
    def __init__(self, engine):
        super().__init__(engine)
        from winrt.windows.media.playback import MediaPlayer
        from winrt.windows.media import MediaPlaybackType, MediaPlaybackStatus, SystemMediaTransportControlsButton
        self.MediaPlaybackType = MediaPlaybackType
        self.Status = MediaPlaybackStatus
        self.Btn = SystemMediaTransportControlsButton
        self.player = MediaPlayer()
        self.player.command_manager.is_enabled = False
        s = self.smtc = self.player.system_media_transport_controls
        s.is_enabled = True
        s.is_play_enabled = s.is_pause_enabled = s.is_next_enabled = s.is_previous_enabled = True
        s.is_stop_enabled = False
        self._tok1 = s.add_button_pressed(self._on_button)
        self._tok2 = s.add_playback_position_change_requested(self._on_seek)
        s.playback_status = MediaPlaybackStatus.CLOSED

    def _on_button(self, sender, args):
        b = args.button
        if b == self.Btn.PLAY:
            self._do("play")
        elif b == self.Btn.PAUSE:
            self._do("pause")
        elif b == self.Btn.NEXT:
            self._do("next")
        elif b == self.Btn.PREVIOUS:
            self._do("prev")

    def _on_seek(self, sender, args):
        try:
            self._do("seek", args.requested_playback_position.total_seconds())
        except Exception:
            pass

    def update(self, track, playing, pos, dur):
        from winrt.windows.media import SystemMediaTransportControlsTimelineProperties
        s = self.smtc
        if not track:
            # nothing loaded: leave the media flyout so media keys go to whatever else is playing
            s.playback_status = self.Status.CLOSED
            self._last_key = None
            return
        key = track.get("qid") or track.get("id")
        if key != self._last_key:
            self._last_key = key
            du = s.display_updater
            du.type = self.MediaPlaybackType.MUSIC
            mp = du.music_properties
            mp.title = track.get("title") or ""
            mp.artist = track.get("artist") or ""
            mp.album_title = (track.get("album") or {}).get("name") or ""
            thumb = track.get("thumb")
            if thumb:
                try:
                    from winrt.windows.storage.streams import RandomAccessStreamReference
                    from winrt.windows.foundation import Uri
                    from .yt import resize_thumb
                    du.thumbnail = RandomAccessStreamReference.create_from_uri(Uri(resize_thumb(thumb, 300)))
                except Exception as e:
                    log.debug("thumb failed: %s", e)
            du.update()
        s.playback_status = self.Status.PLAYING if playing else self.Status.PAUSED
        try:
            tl = SystemMediaTransportControlsTimelineProperties()
            d = float(dur or track.get("dur") or 0)
            tl.start_time = timedelta(0)
            tl.min_seek_time = timedelta(0)
            tl.end_time = timedelta(seconds=d)
            tl.max_seek_time = timedelta(seconds=d)
            tl.position = timedelta(seconds=max(0.0, min(float(pos or 0), d or 0)))
            s.update_timeline_properties(tl)
        except Exception as e:
            log.debug("timeline failed: %s", e)

    def close(self):
        try:
            self.smtc.playback_status = self.Status.CLOSED
            self.smtc.display_updater.clear_all()
            self.smtc.display_updater.update()
        except Exception:
            pass


class MacMedia(_Base):
    """MPNowPlayingInfoCenter + MPRemoteCommandCenter. Needs the main thread's run loop (the menu-bar icon provides it)."""

    def __init__(self, engine):
        super().__init__(engine)
        import MediaPlayer as MP
        from PyObjCTools import AppHelper
        self.MP = MP
        self.AppHelper = AppHelper
        self._art_url = None
        self._artwork = None
        cc = MP.MPRemoteCommandCenter.sharedCommandCenter()

        def h(action, getarg=None):
            def handler(event):
                self._do(action, getarg(event) if getarg else None)
                return 0  # MPRemoteCommandHandlerStatusSuccess
            return handler

        self._handlers = [
            (cc.playCommand(), h("play")),
            (cc.pauseCommand(), h("pause")),
            (cc.togglePlayPauseCommand(), h("toggle")),
            (cc.nextTrackCommand(), h("next")),
            (cc.previousTrackCommand(), h("prev")),
            (cc.changePlaybackPositionCommand(), h("seek", lambda ev: ev.positionTime())),
        ]

        def register():
            for cmd, fn in self._handlers:
                cmd.setEnabled_(True)
                cmd.addTargetWithHandler_(fn)
        AppHelper.callAfter(register)  # remote commands belong on the main run loop

    def update(self, track, playing, pos, dur):
        self.AppHelper.callAfter(self._update_main, track, playing, pos, dur)

    def _update_main(self, track, playing, pos, dur):
        MP = self.MP
        center = MP.MPNowPlayingInfoCenter.defaultCenter()
        if not track:
            center.setNowPlayingInfo_(None)
            center.setPlaybackState_(MP.MPNowPlayingPlaybackStateStopped)
            return
        info = {
            MP.MPMediaItemPropertyTitle: track.get("title") or "",
            MP.MPMediaItemPropertyArtist: track.get("artist") or "",
            MP.MPMediaItemPropertyAlbumTitle: (track.get("album") or {}).get("name") or "",
            MP.MPMediaItemPropertyPlaybackDuration: float(dur or track.get("dur") or 0),
            MP.MPNowPlayingInfoPropertyElapsedPlaybackTime: float(pos or 0),
            MP.MPNowPlayingInfoPropertyPlaybackRate: 1.0 if playing else 0.0,
        }
        thumb = track.get("thumb")
        if thumb and thumb != self._art_url:
            self._art_url = thumb
            self._artwork = None
            self.engine.loop.call_soon_threadsafe(lambda: self.engine.loop.run_in_executor(None, self._load_art, thumb))
        if self._artwork is not None:
            info[MP.MPMediaItemPropertyArtwork] = self._artwork
        center.setNowPlayingInfo_(info)
        center.setPlaybackState_(MP.MPNowPlayingPlaybackStatePlaying if playing else MP.MPNowPlayingPlaybackStatePaused)

    def _load_art(self, url):
        try:
            import urllib.request
            from AppKit import NSImage
            from Foundation import NSData
            from .yt import resize_thumb, UA
            req = urllib.request.Request(resize_thumb(url, 400), headers={"User-Agent": UA})
            data = urllib.request.urlopen(req, timeout=8).read()
            img = NSImage.alloc().initWithData_(NSData.dataWithBytes_length_(data, len(data)))
            if img is None or url != self._art_url:
                return
            MP = self.MP
            art = MP.MPMediaItemArtwork.alloc().initWithBoundsSize_requestHandler_(img.size(), lambda size: img)
            self._artwork = art
            e = self.engine
            self.update(e.current, not e.paused, e._live_pos(), e.dur)
        except Exception as ex:
            log.debug("artwork failed: %s", ex)


def create(engine):
    try:
        if config.IS_WIN:
            return WindowsMedia(engine)
        if config.IS_MAC:
            return MacMedia(engine)
    except Exception as e:
        log.warning("media controls unavailable: %s", e)
    return None

"""Tempo launcher.

  run.py               open the window (starts the background engine if it isn't running)
  run.py --background  start only the engine + tray icon (used at login)
  run.py --engine      the engine process itself
  run.py --window      the window process itself
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tempo import config  # noqa: E402


def api(path, data=None, timeout=2.0):
    req = urllib.request.Request(f"http://{config.HOST}:{config.PORT}{path}",
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json", "X-Tempo": "1"},
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def engine_up() -> bool:
    try:
        return api("/api/ping", timeout=1.0).get("app") == "tempo"
    except Exception:
        return False


def start_engine():
    from tempo.app import python_gui
    me = os.path.abspath(__file__)
    if config.IS_WIN:
        subprocess.Popen([python_gui(), me, "--engine"], creationflags=0x08000000 | 0x00000008 | 0x00000200,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    else:
        log = open(config.LOGS / "engine.out", "ab")
        subprocess.Popen([sys.executable, me, "--engine"], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    for _ in range(150):
        if engine_up():
            return True
        time.sleep(0.1)
    return False


def normal_priority():
    """Anything started by a scheduled task runs at BELOW-normal priority on Windows (and its children
    inherit it): the player then stuttered whenever the laptop was busy. Always run at normal."""
    if config.IS_WIN:
        try:
            import ctypes
            from ctypes import wintypes
            k = ctypes.windll.kernel32
            # real HANDLE types: the current-process pseudo handle is -1, and ctypes' default 32-bit int
            # turned it into an invalid handle on 64-bit Python, so this silently did nothing (Nov 20)
            k.GetCurrentProcess.restype = wintypes.HANDLE
            k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            k.SetPriorityClass(k.GetCurrentProcess(), 0x00000020)   # NORMAL_PRIORITY_CLASS
        except Exception:
            pass


def main():
    normal_priority()
    args = sys.argv[1:]
    if "--engine" in args:
        from tempo.app import main as engine_main
        engine_main(silent="--silent" in args)
        return
    if not engine_up():
        if not start_engine():
            sys.exit("Nocturne engine didn't start - see logs in " + str(config.LOGS))
    if "--background" in args:
        return
    if "--window" not in args:
        try:
            if api("/api/window/show", {}).get("has_window"):
                return  # an open window was brought to the front
        except Exception:
            pass
    from tempo.window import main as window_main
    window_main()


if __name__ == "__main__":
    main()

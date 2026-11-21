"""Windows: Start menu + Desktop shortcuts for Tempo (with its icon and app id, so Windows shows
"Tempo" in the taskbar and the media flyout). Run with the venv python:  .venv\\Scripts\\python tools\\install_windows.py"""
import os
import sys
from pathlib import Path

import pythoncom
from win32com.propsys import propsys, pscon
from win32com.shell import shell, shellcon

ROOT = Path(__file__).resolve().parent.parent
APP_ID = "Nocturne.MusicPlayer"
PYW = Path(sys.executable).with_name("pythonw.exe")
ICON = ROOT / "assets" / "nocturne.ico"


def make_link(path: Path):
    link = pythoncom.CoCreateInstance(shell.CLSID_ShellLink, None, pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink)
    link.SetPath(str(PYW))
    link.SetArguments(f'"{ROOT / "run.py"}"')
    link.SetWorkingDirectory(str(ROOT))
    link.SetIconLocation(str(ICON), 0)
    link.SetDescription("Nocturne music player")
    store = link.QueryInterface(propsys.IID_IPropertyStore)
    store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType(APP_ID, pythoncom.VT_LPWSTR))
    store.Commit()
    link.QueryInterface(pythoncom.IID_IPersistFile).Save(str(path), 0)
    print("shortcut:", path)


def main():
    start = Path(shell.SHGetFolderPath(0, shellcon.CSIDL_PROGRAMS, None, 0))
    desktop = Path(shell.SHGetFolderPath(0, shellcon.CSIDL_DESKTOPDIRECTORY, None, 0))
    for old in (start / "Tempo.lnk", desktop / "Tempo.lnk"):   # shortcuts from before the rename
        if old.exists():
            old.unlink()
            print("removed", old)
    make_link(start / "Nocturne.lnk")
    if "--no-desktop" not in sys.argv:
        make_link(desktop / "Nocturne.lnk")


if __name__ == "__main__":
    main()

"""Captures the Gemini Bulk Image Studio window to docs/screenshot-dashboard.png.

Run while the app is open:
  python tools/capture-screenshot.py
"""
import ctypes
import ctypes.wintypes as wintypes
import os
import time

from PIL import ImageGrab

user32 = ctypes.windll.user32
TITLE = "Gemini Bulk Image Studio"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def get_text(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


target = None


def callback(hwnd, _lparam):
    global target
    if user32.IsWindowVisible(hwnd) and TITLE in get_text(hwnd):
        target = hwnd
        return False
    return True


user32.EnumWindows(EnumWindowsProc(callback), 0)
if not target:
    raise SystemExit("App window not found - is Gemini Bulk Image Studio running?")

user32.ShowWindow(target, 9)  # SW_RESTORE
try:
    user32.SetForegroundWindow(target)
except Exception:
    pass
time.sleep(2.0)

rect = wintypes.RECT()
user32.GetWindowRect(target, ctypes.byref(rect))
width = rect.right - rect.left
height = rect.bottom - rect.top
print(f"window rect: {width}x{height} at ({rect.left},{rect.top})")

image = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True)
docs = os.path.join(ROOT, "docs")
os.makedirs(docs, exist_ok=True)
out = os.path.join(docs, "screenshot-dashboard.png")
image.save(out, "PNG")
print("wrote", out, os.path.getsize(out), "bytes")

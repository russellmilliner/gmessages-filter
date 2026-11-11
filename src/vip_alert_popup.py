#!/usr/bin/env python3
"""
Center-of-Primary-Desktop VIP Message Alert Popup for Google Messages Filter
----------------------------------------------------------------------------
Displays a high-visibility always-on-top alert dialog at the exact center of
the KDE Plasma primary display (priority 1 output from kscreen-doctor -j, e.g. DP-1)
when a VIP contact (such as Michelle Milliner) sends a Google Message and the
Google Messages window is not currently visible on the desktop.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PyQt6.QtCore import QCoreApplication, QEventLoop, QObject, Qt, QTimer, pyqtSlot
from PyQt6.QtDBus import QDBusConnection, QDBusInterface
from PyQt6.QtGui import QColor, QFont, QGuiApplication, QKeySequence, QPalette, QShortcut
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

PID_FILE = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "gmessages-vip-alert.pid"


def _run_kwin_oneshot_clean(
    bus: QDBusConnection,
    js_code: str,
    plugin_name: str,
    wait_loop: QEventLoop | None = None,
    done_check=None,
    timeout_ms: int = 500,
) -> None:
    """
    Load and execute a temporary KWin script, optionally waiting on a QEventLoop
    until done_check() returns True or timeout_ms elapses, and ALWAYS call
    org.kde.kwin.Script.stop BEFORE org.kde.kwin.Scripting.unloadScript so KWin
    Script{N} object slots are never orphaned.
    """
    js_path: str | None = None
    scripting = QDBusInterface("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", bus)
    s_iface: QDBusInterface | None = None
    loaded = False
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(js_code)
            js_path = f.name

        is_loaded_reply = scripting.call("isScriptLoaded", plugin_name)
        if is_loaded_reply.arguments() and bool(is_loaded_reply.arguments()[0]):
            scripting.call("unloadScript", plugin_name)

        reply = scripting.call("loadScript", js_path, plugin_name)
        if reply.arguments():
            script_id = int(reply.arguments()[0])
            if script_id >= 0:
                loaded = True
                s_iface = QDBusInterface(
                    "org.kde.KWin",
                    f"/Scripting/Script{script_id}",
                    "org.kde.kwin.Script",
                    bus,
                )
                s_iface.call("run")
                if wait_loop is not None and (done_check is None or not done_check()):
                    QTimer.singleShot(timeout_ms, wait_loop.quit)
                    if done_check is None or not done_check():
                        wait_loop.exec()
    finally:
        try:
            if s_iface is not None:
                s_iface.call("stop")
        except Exception:
            pass
        try:
            if loaded:
                scripting.call("unloadScript", plugin_name)
        except Exception:
            pass
        if js_path and os.path.exists(js_path):
            try:
                os.unlink(js_path)
            except OSError:
                pass


def check_gmessages_window_visibility() -> dict:
    """
    Query KWin via DBus Scripting to determine whether the Google Messages window
    is currently visible to the user on the active virtual desktop.
    Returns a dict with:
      found, visible, minimized, hidden, active, onCurrentDesktop, coveredRatio, coveringWins
    """
    app = QCoreApplication.instance()
    if app is None:
        app = QCoreApplication(sys.argv)

    bus = QDBusConnection.sessionBus()
    res_holder: list[str] = []
    loop = QEventLoop()

    class _VisReceiver(QObject):
        @pyqtSlot(str)
        def report(self, msg: str):
            res_holder.append(msg)
            if loop.isRunning():
                loop.quit()

    recv = _VisReceiver()
    obj_path = f"/GMessagesVis_{os.getpid()}_{int(time.time() * 1000) % 100000}"
    bus.registerObject(obj_path, recv, QDBusConnection.RegisterOption.ExportAllSlots)
    service_name = bus.baseService()

    js = f"""
const wins = workspace.windowList();
let gmCandidates = [];
for (let i = 0; i < wins.length; i++) {{
    const w = wins[i];
    const rc = (w.resourceClass || "").toLowerCase();
    const cap = (w.caption || "").toLowerCase();
    if (rc.includes("hpfldicfbfomlpcikngkocigghgafkph") || cap.includes("google messages")) {{
        gmCandidates.push(w);
    }}
}}
function evalWindow(gm) {{
    const gx = gm.x, gy = gm.y, gw = gm.width, gh = gm.height;
    const gArea = Math.max(1, gw * gh);
    const gmScreenDesk = (gm.output && typeof workspace.currentDesktopForScreen === "function")
        ? workspace.currentDesktopForScreen(gm.output)
        : workspace.currentDesktop;
    let coveredArea = 0;
    let coveringWins = [];
    for (let i = 0; i < wins.length; i++) {{
        const o = wins[i];
        if (o === gm) continue;
        if ((o.caption || "").startsWith("GMessagesVIPAlert_")) continue;
        const oScreenDesk = (o.output && typeof workspace.currentDesktopForScreen === "function")
            ? workspace.currentDesktopForScreen(o.output)
            : gmScreenDesk;
        const oOnCur = o.onAllDesktops || o.desktops.length === 0 || o.desktops.some(d => (oScreenDesk && (d.id === oScreenDesk.id || d.x11DesktopNumber === oScreenDesk.x11DesktopNumber)));
        if (o.minimized || o.hidden || !oOnCur || !o.normalWindow) continue;
        if (o.stackingOrder > gm.stackingOrder) {{
            const ix1 = Math.max(gx, o.x);
            const iy1 = Math.max(gy, o.y);
            const ix2 = Math.min(gx + gw, o.x + o.width);
            const iy2 = Math.min(gy + gh, o.y + o.height);
            if (ix2 > ix1 && iy2 > iy1) {{
                const area = (ix2 - ix1) * (iy2 - iy1);
                coveredArea += area;
                coveringWins.push({{caption: o.caption, ratio: Number((area / gArea).toFixed(2))}});
            }}
        }}
    }}
    const coveredRatio = Math.min(1.0, coveredArea / gArea);
    const onCurDesk = gm.onAllDesktops || gm.desktops.length === 0 || gm.desktops.some(d => (gmScreenDesk && (d.id === gmScreenDesk.id || d.x11DesktopNumber === gmScreenDesk.x11DesktopNumber)));
    const isVisible = !gm.minimized && !gm.hidden && onCurDesk && coveredRatio < 0.35;
    let reason = "visible";
    if (gm.minimized) reason = "minimized";
    else if (gm.hidden) reason = "hidden";
    else if (!onCurDesk) reason = "other_virtual_desktop";
    else if (coveredRatio >= 0.35) reason = "covered_by_other_window";
    return {{
        found: true,
        visible: isVisible,
        reason: reason,
        minimized: gm.minimized,
        hidden: gm.hidden,
        active: gm.active,
        onCurrentDesktop: onCurDesk,
        coveredRatio: Number(coveredRatio.toFixed(2)),
        coveringWins: coveringWins,
        geometry: {{x: gx, y: gy, width: gw, height: gh}},
        internalId: String(gm.internalId)
    }};
}}
if (gmCandidates.length === 0) {{
    callDBus("{service_name}", "{obj_path}", "", "report", JSON.stringify({{
        found: false,
        visible: false,
        reason: "window_not_open"
    }}));
}} else {{
    let evals = gmCandidates.map(evalWindow);
    let visWin = evals.find(e => e.visible) || evals[0];
    callDBus("{service_name}", "{obj_path}", "", "report", JSON.stringify(visWin));
}}
"""
    plugin = f"gmessages_vis_{os.getpid()}_{int(time.time() * 1000) % 100000}"
    try:
        _run_kwin_oneshot_clean(
            bus,
            js,
            plugin,
            wait_loop=loop,
            done_check=lambda: bool(res_holder),
            timeout_ms=500,
        )
    except Exception as e:
        return {"found": False, "visible": False, "reason": f"kwin_error: {e}"}
    finally:
        bus.unregisterObject(obj_path)

    if res_holder:
        try:
            return json.loads(res_holder[0])
        except Exception:
            pass
    return {"found": False, "visible": False, "reason": "timeout"}


def detect_active_screensharing_outputs(all_output_names: list[str]) -> tuple[bool, set[str], list[str]]:
    """
    Inspect PipeWire (`pw-dump`) for active KWin / XDG Desktop Portal screencast streams.
    Returns (any_screenshare_active, shared_output_names_set, stream_descriptions).
    If a screencast stream is active and names a specific output (e.g. 'kwin-screencast-DP-1'),
    that output is marked shared. If a screencast stream is active without an explicit output
    name, the primary display is conservatively treated as shared so alerts never leak onto a call.
    """
    shared_outputs: set[str] = set()
    streams: list[str] = []
    any_active = False

    try:
        out = subprocess.check_output(["pw-dump"], text=True, timeout=2.0, stderr=subprocess.DEVNULL)
        data = json.loads(out)
        for item in data:
            info = item.get("info") or {}
            state = str(info.get("state") or "").lower()
            if state not in ("running", "idle"):
                continue
            props = info.get("props") or {}
            media_class = str(props.get("media.class") or "")
            node_name = str(props.get("node.name") or "")
            media_name = str(props.get("media.name") or "")
            app_name = str(props.get("application.name") or "")

            # Ignore physical V4L2 webcams
            if node_name.startswith("v4l2_input"):
                continue

            combined = f"{node_name} {media_name} {app_name}".lower()
            is_screencast = (
                "kwin-screencast" in combined
                or "kwin_screencast" in combined
                or "xdp-kde-screencast" in combined
                or "screencast" in combined
                or ("video/source" in media_class.lower() and not node_name.startswith("v4l2"))
            )
            if is_screencast and state == "running":
                any_active = True
                streams.append(f"{node_name or media_name} ({state})")
                matched_specific = False
                for out_name in all_output_names:
                    if out_name.lower() in combined:
                        shared_outputs.add(out_name)
                        matched_specific = True
                if not matched_specific and all_output_names:
                    # Conservatively assume primary output (index 0) is being shared
                    shared_outputs.add(all_output_names[0])
    except Exception:
        pass

    return any_active, shared_outputs, streams


def get_target_display_geometry(simulate_primary_screenshare: bool = False) -> dict:
    """
    Find the target display for the center-screen alert:
    - Defaults to the KDE Plasma primary display (priority == 1, e.g. DP-1).
    - If screensharing is currently active on the primary display, automatically
      switches to the next highest-priority display (e.g. DP-3, priority == 2).
    """
    ranked_outputs: list[dict] = []
    try:
        out = subprocess.check_output(["kscreen-doctor", "-j"], text=True, timeout=2.0)
        data = json.loads(out)
        outputs = [o for o in data.get("outputs", []) if o.get("enabled") and o.get("connected")]
        outputs.sort(key=lambda o: (o.get("priority", 99) if o.get("priority", 0) > 0 else 99))
        for o in outputs:
            pos = o.get("pos") or {"x": 0, "y": 0}
            size = o.get("size") or {"width": 2560, "height": 1440}
            scale = float(o.get("scale") or 1.0)
            logical_w = int(round(size.get("width", 2560) / scale))
            logical_h = int(round(size.get("height", 1440) / scale))
            ranked_outputs.append({
                "name": o.get("name", "DP-1"),
                "priority": o.get("priority", 99),
                "x": int(pos.get("x", 0)),
                "y": int(pos.get("y", 0)),
                "width": logical_w,
                "height": logical_h,
            })
    except Exception:
        pass

    if not ranked_outputs:
        ranked_outputs = [{"name": "DP-1", "priority": 1, "x": 2560, "y": 0, "width": 2560, "height": 1440}]

    output_names = [o["name"] for o in ranked_outputs]
    any_shared, shared_outputs, streams = detect_active_screensharing_outputs(output_names)
    if simulate_primary_screenshare and output_names:
        any_shared = True
        shared_outputs.add(output_names[0])
        streams.append(f"simulated-screenshare ({output_names[0]})")

    primary_name = ranked_outputs[0]["name"]
    chosen = ranked_outputs[0]
    rerouted = False

    if primary_name in shared_outputs and len(ranked_outputs) > 1:
        for candidate in ranked_outputs[1:]:
            if candidate["name"] not in shared_outputs:
                chosen = candidate
                rerouted = True
                break
        if not rerouted:
            chosen = ranked_outputs[1]
            rerouted = True

    result = dict(chosen)
    result["primary_display"] = primary_name
    result["screenshare_active"] = any_shared
    result["shared_outputs"] = sorted(shared_outputs)
    result["screenshare_streams"] = streams
    result["rerouted_from_primary"] = rerouted
    return result


def play_alert_sound():
    """Play a non-blocking desktop notification chime if available."""
    for cmd in (
        ["canberra-gtk-play", "-i", "message-new-instant"],
        ["paplay", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"],
        ["pw-play", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"],
    ):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            break
        except Exception:
            continue


def activate_gmessages_window(thread_sender: str = ""):
    """Notify the local server to focus the conversation thread and raise/activate the Google Messages window via KWin DBus."""
    if thread_sender:
        try:
            import urllib.request
            req = urllib.request.Request(
                "http://127.0.0.1:8768/api/open-conversation",
                data=json.dumps({"sender": thread_sender}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=1.0)
        except Exception:
            pass

    if QCoreApplication.instance() is None:
        QCoreApplication(sys.argv)

    js = """
const wins = workspace.windowList();
let target = null;
for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if ((w.caption || "").startsWith("GMessagesVIPAlert_")) continue;
    const rc = (w.resourceClass || "").toLowerCase();
    if (rc.includes("hpfldicfbfomlpcikngkocigghgafkph")) {
        target = w;
        break;
    }
}
if (!target) {
    for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        if ((w.caption || "").startsWith("GMessagesVIPAlert_")) continue;
        const cap = (w.caption || "").toLowerCase();
        if (cap.includes("google messages")) {
            target = w;
            break;
        }
    }
}
if (target) {
    const targetDesk = (target.output && typeof workspace.currentDesktopForScreen === "function")
        ? workspace.currentDesktopForScreen(target.output)
        : workspace.currentDesktop;
    const onCurDesk = target.onAllDesktops
        || !target.desktops
        || target.desktops.length === 0
        || (targetDesk && target.desktops.some(d => d.id === targetDesk.id || d.x11DesktopNumber === targetDesk.x11DesktopNumber));
    if (!onCurDesk && targetDesk) {
        target.desktops = [targetDesk];
    }
    if (target.minimized) {
        target.minimized = false;
    }
    if (typeof workspace.raiseWindow === "function") {
        workspace.raiseWindow(target);
    }
    workspace.activeWindow = target;
}
"""
    plugin = f"gmessages_activate_{os.getpid()}_{int(time.time() * 1000) % 100000}"
    try:
        bus = QDBusConnection.sessionBus()
        _run_kwin_oneshot_clean(bus, js, plugin)
    except Exception:
        pass


class VipAlertWindow(QWidget):
    def __init__(self, sender: str, timestamp_str: str, primary_geom: dict, thread_sender: str = ""):
        super().__init__()
        self.sender = sender
        self.thread_sender = thread_sender or sender
        self.timestamp_str = timestamp_str or datetime.datetime.now().strftime("%-I:%M %p")
        self.primary_geom = primary_geom
        self.window_tag = f"GMessagesVIPAlert_{os.getpid()}"
        self._kwin_centered = False

        self.setWindowTitle(self.window_tag)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)

        self.card_width = 520
        self.setFixedWidth(self.card_width)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        card = QFrame(self)
        card.setObjectName("vipCard")
        card.setStyleSheet(
            """
            QFrame#vipCard {
                background-color: #131926;
                border: 2px solid #38bdf8;
                border-radius: 16px;
            }
            QLabel#badgeLabel {
                background-color: rgba(56, 189, 248, 0.16);
                color: #7dd3fc;
                border: 1px solid rgba(56, 189, 248, 0.40);
                border-radius: 10px;
                padding: 4px 10px;
                font-weight: 700;
                font-size: 11pt;
            }
            QLabel#timeLabel {
                color: #94a3b8;
                font-size: 10.5pt;
                font-weight: 600;
            }
            QLabel#senderLabel {
                color: #f8fafc;
                font-size: 18pt;
                font-weight: 800;
            }
            QLabel#subLabel {
                color: #94a3b8;
                font-size: 11.5pt;
                font-weight: 500;
            }
            QPushButton#openBtn {
                background-color: #0284c7;
                color: #ffffff;
                border: none;
                border-radius: 10px;
                padding: 10px 20px;
                font-size: 11.5pt;
                font-weight: 700;
            }
            QPushButton#openBtn:hover {
                background-color: #0369a1;
            }
            QPushButton#dismissBtn {
                background-color: #334155;
                color: #e2e8f0;
                border: 1px solid #475569;
                border-radius: 10px;
                padding: 10px 18px;
                font-size: 11.5pt;
                font-weight: 600;
            }
            QPushButton#dismissBtn:hover {
                background-color: #475569;
            }
            """
        )

        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(24, 20, 24, 20)
        card_layout.setSpacing(12)

        # Top row: badge + timestamp
        top_row = QHBoxLayout()
        badge = QLabel("💬 GOOGLE MESSAGES ALERT")
        badge.setObjectName("badgeLabel")
        time_lbl = QLabel(self.timestamp_str)
        time_lbl.setObjectName("timeLabel")
        top_row.addWidget(badge, 0, Qt.AlignmentFlag.AlignLeft)
        top_row.addStretch(1)
        top_row.addWidget(time_lbl, 0, Qt.AlignmentFlag.AlignRight)
        card_layout.addLayout(top_row)

        # Sender title (no message content shown)
        sender_lbl = QLabel(f"New message from {self.sender}")
        sender_lbl.setObjectName("senderLabel")
        sender_lbl.setWordWrap(True)
        card_layout.addWidget(sender_lbl)

        sub_lbl = QLabel("Message content hidden. Press Enter to view in Google Messages.")
        sub_lbl.setObjectName("subLabel")
        sub_lbl.setWordWrap(True)
        card_layout.addWidget(sub_lbl)

        card_layout.addSpacing(4)

        # Buttons row
        btn_row = QHBoxLayout()
        btn_row.setSpacing(12)
        btn_row.addStretch(1)

        dismiss_btn = QPushButton("Dismiss (Esc)")
        dismiss_btn.setObjectName("dismissBtn")
        dismiss_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        dismiss_btn.clicked.connect(self.close)

        open_btn = QPushButton("Open Google Messages (Enter)")
        open_btn.setObjectName("openBtn")
        open_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        open_btn.clicked.connect(self.on_open_clicked)
        open_btn.setDefault(True)

        btn_row.addWidget(dismiss_btn)
        btn_row.addWidget(open_btn)
        card_layout.addLayout(btn_row)

        outer.addWidget(card)

        QShortcut(QKeySequence("Escape"), self, activated=self.close)
        QShortcut(QKeySequence("Return"), self, activated=self.on_open_clicked)
        QShortcut(QKeySequence("Enter"), self, activated=self.on_open_clicked)

    def on_open_clicked(self):
        activate_gmessages_window(self.thread_sender)
        self.close()

    def center_on_primary_via_kwin(self):
        if self._kwin_centered:
            return
        self._kwin_centered = True

        w = self.width() or self.card_width
        h = self.height() or 250
        px = self.primary_geom["x"]
        py = self.primary_geom["y"]
        pw = self.primary_geom["width"]
        ph = self.primary_geom["height"]
        target_x = int(round(px + (pw - w) / 2))
        target_y = int(round(py + (ph - h) / 2))

        js = f"""
const wins = workspace.windowList();
for (let i = 0; i < wins.length; i++) {{
    const w = wins[i];
    if ((w.caption || "") === "{self.window_tag}") {{
        w.keepAbove = true;
        w.skipTaskbar = true;
        w.skipPager = true;
        w.onAllDesktops = true;
        w.frameGeometry = {{
            x: {target_x},
            y: {target_y},
            width: Math.round(w.width || {w}),
            height: Math.round(w.height || {h})
        }};
    }}
}}
"""
        plugin = f"gmessages_move_{os.getpid()}_{int(time.time() * 1000) % 100000}"
        try:
            bus = QDBusConnection.sessionBus()
            _run_kwin_oneshot_clean(bus, js, plugin)
        except Exception:
            pass


def kill_existing_popup():
    if PID_FILE.is_file():
        try:
            old_pid = int(PID_FILE.read_text().strip())
            if old_pid != os.getpid():
                os.kill(old_pid, 15)
        except Exception:
            pass
    try:
        PID_FILE.write_text(str(os.getpid()))
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Google Messages VIP Center Desktop Alert")
    parser.add_argument("--check-visibility", action="store_true", help="Print JSON visibility status of Google Messages window and exit")
    parser.add_argument("--sender", default="Michelle Milliner", help="Sender display name")
    parser.add_argument("--thread-sender", default="", help="Thread title in Google Messages to focus on open")
    parser.add_argument("--snippet", default="", help="Ignored (message text is not displayed)")
    parser.add_argument("--timestamp", default="", help="Message timestamp string")
    parser.add_argument("--auto-close-sec", type=int, default=0, help="Optional auto-close timeout in seconds (0 = stay until dismissed)")
    parser.add_argument("--no-sound", action="store_true", help="Do not play notification sound")
    parser.add_argument("--simulate-screenshare", action="store_true", help="Simulate active screensharing on the primary display")
    args = parser.parse_args()

    if args.check_visibility:
        vis = check_gmessages_window_visibility()
        disp = get_target_display_geometry(simulate_primary_screenshare=args.simulate_screenshare)
        vis["target_display"] = disp
        print(json.dumps(vis))
        return

    kill_existing_popup()
    app = QApplication(sys.argv)
    primary_geom = get_target_display_geometry(simulate_primary_screenshare=args.simulate_screenshare)

    win = VipAlertWindow(args.sender, args.timestamp, primary_geom, thread_sender=args.thread_sender or args.sender)
    win.adjustSize()
    win.winId()

    target_screen = next((s for s in app.screens() if s.name() == primary_geom["name"]), None) or app.primaryScreen()
    if target_screen is not None:
        if win.windowHandle():
            win.windowHandle().setScreen(target_screen)
        avail = target_screen.availableGeometry()
        if not avail.isValid():
            avail = target_screen.geometry()
        w_hint = win.width() or win.card_width
        h_hint = win.height() or win.sizeHint().height() or 250
        init_x = int(round(avail.x() + (avail.width() - w_hint) / 2))
        init_y = int(round(avail.y() + (avail.height() - h_hint) / 2))
        win.move(init_x, init_y)

    win.show()
    if not args.no_sound:
        play_alert_sound()

    QTimer.singleShot(60, win.center_on_primary_via_kwin)

    if args.auto_close_sec and args.auto_close_sec > 0:
        QTimer.singleShot(args.auto_close_sec * 1000, app.quit)

    sys.exit(app.exec())


if __name__ == "__main__":
    main()

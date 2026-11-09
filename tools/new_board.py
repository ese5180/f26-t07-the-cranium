#!/usr/bin/env python3
"""What scripts/board/new-board.sh needs that bash does badly. Run by it; each command also works alone.

    python3 tools/new_board.py boards                     the boards plugged in, from `nrfutil device list
                                                          --json` on stdin and the serial ports
    python3 tools/new_board.py boards --pick [--serial-number <n>] [--board <type>] [--need-debugger]
                                                          exactly one of them, or a refusal that says why
    python3 tools/new_board.py release --board <type>     the signed image to install: --image, else the
                                                          console's newest release, else binaries/
    python3 tools/new_board.py serial-status --port <p>   what the board's serial console says, without
                                                          its network, endpoint or download address
    python3 tools/new_board.py console-status --thing <name>   the console's view of the board
    python3 tools/new_board.py watch-seal --port <p>      the bootloader's log while a person does the gesture
    python3 tools/new_board.py ble-scan --name <name>     whether the board advertises (needs bleak)
    python3 tools/new_board.py token [--online]           whether there is a console token, and what it may do
    python3 tools/new_board.py outputs                    whether cloud/.deploy/outputs.json has what is needed
    python3 tools/new_board.py pydeps                     which of the tools' Python packages are missing
    python3 tools/new_board.py redact                     stdin to stdout, without what names the network or
                                                          the AWS account

Nothing here prints a secret: no console token, no Wi-Fi network's name or password, no AWS account,
endpoint, bucket or console address. The console is reached with a console token (CRANIUM_TOKEN or
~/.cranium/console-token, as scripts/firmware/ota.sh uses), and only read from, except for the download of a
release's image, which the console records like a write.

pyserial is needed only by the commands that open a serial port, and bleak only by ble-scan.
"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib.util import find_spec
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_image  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
BINARIES = REPO / "binaries"
OUTPUTS = REPO / "cloud" / ".deploy" / "outputs.json"
VERIFY_IMAGE = REPO / "cloud" / "api" / "verify-image.mjs"

SEGGER_VID = 0x1366
BOARD_TYPES = ("nrf7002dk", "nrf5340dk")
DEFAULT_BOARD = "nrf7002dk"
LABELS = {"nrf7002dk": "nRF7002 DK", "nrf5340dk": "nRF5340 DK"}
# What a DK's on-board debugger says the board is: boardVersion in `nrfutil device list --json`.
BOARD_OF_PCA = {"PCA10143": "nrf7002dk", "PCA10095": "nrf5340dk"}
# The names a build gives each board type's images in binaries/ (tools/store_binary.py).
IMAGE_PREFIX = {"nrf7002dk": "cranium-", "nrf5340dk": "cranium-nrf5340dk-"}

TOKEN = re.compile(r"^crn_[A-Za-z0-9_-]{43}$")
CONSOLE_URL = re.compile(r"^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)$")
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?")

# What provisioning needs of the cloud stack's outputs, and the console's address.
OUTPUT_KEYS = ("Region", "DeviceGroupName", "DevicePolicyName", "FirmwareDownloadPrefix", "ConsoleUrl")
# Of the outputs, those that name nothing in the account (as in firmware/tests/hil/ota_bench.py).
OUTPUTS_THAT_NAME_NOTHING = ("Region", "DeployedCommit", "DeployedTree")

# What STATUS says that may be shown. Everything else is hidden: the network's name, the board's
# Wi-Fi address, the AWS IoT endpoint and the download address name the network or the account.
SHOWN_KEYS = ("state", "id", "thing name", "firmware", "board", "layout", "stuck count", "wifi password",
              "wifi link", "cloud", "mqtt", "root CA", "private key", "certificate", "update", "bt passkey",
              "bt failures", "bt name", "bt window")
HIDDEN_STATUS_LINE = re.compile(r"^(\s*)(wifi network|wifi address|endpoint|download from)(\s{2,}).*$")
WIFI_STORED = re.compile(r'Wi-Fi network ".*"(?= \(| stored|$)')
ACCOUNT_SHOWN = "<account>"
ACCOUNT_PATTERNS = (re.compile(r"\barn:aws[a-z-]*:[^\s\"',;)\]}]+"),
                    re.compile(r"[\w.-]+\.amazonaws\.com(?:/[^\s\"',;)\]}]*)?"),
                    re.compile(r"\bs3://[^\s\"',;)\]}]+"),
                    re.compile(r"(?<![\w.-])\d{12}(?![\w.-])"))
ADDRESS = re.compile(r"\bhttps?://[^\s\"',;)\]}]+")

# What the golden image's code in the bootloader says (firmware/tests/hil/golden_bench.py's SAYS).
SEAL_DONE = {"golden: sealed, restarting": "sealed", "golden: nothing to do": "nothing to do"}
SEAL_REFUSED = "golden: refused"
SEAL_NOTES = ("golden: Button 2 let go too early or too late", "golden: Button 2 is still down",
              "golden: gesture completed", "golden: sealing the running image", "golden: restoring the pinned image",
              "golden: restored, restarting")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class Refusal(Exception):
    """Something this cannot go on with, said for a person. The code is the exit status."""

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def say(text: str = "") -> None:
    print(text, file=sys.stderr, flush=True)


def label(board_type: str) -> str:
    return LABELS.get(board_type, board_type or "board of unknown type")


# ---- the boards plugged in ---------------------------------------------------------------------


def same_serial(a: str, b: str) -> bool:
    """A J-Link's serial number with or without its leading zeros: 001050797470 is 1050797470."""
    return bool(a) and bool(b) and a.lstrip("0") == b.lstrip("0")


def port_order(name: str) -> list:
    """Sort key that puts COM9 before COM10 and ttyACM2 before ttyACM10, as tools/board.py does."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


def device_path(path: str, platform: str | None = None) -> str:
    """On macOS the callout device: opening /dev/tty.* waits for a carrier that a J-Link never raises."""
    # Looked up at the call, not as a default argument, which Python fixes when the module loads.
    platform = sys.platform if platform is None else platform
    if platform == "darwin" and path.startswith("/dev/tty."):
        return "/dev/cu." + path[len("/dev/tty."):]
    return path


@dataclass
class Board:
    serial: str
    pca: str = ""
    debugger: bool = False
    ports: list = field(default_factory=list)  # [(path, vcom number or None)]

    @property
    def type(self) -> str:
        return BOARD_OF_PCA.get(self.pca.upper(), "")

    def ordered_ports(self) -> list:
        """By VCOM number where nrfutil gives one (numbered ones first), and by name."""
        return [path for path, _ in sorted(self.ports, key=lambda p: (p[1] is None, p[1] or 0, port_order(p[0])))]

    def console_port(self) -> str:
        """The application's console: the last virtual COM port (VCOM1 on an nRF7002 DK)."""
        numbered = [port for port in self.ports if port[1] is not None]
        if numbered:
            return max(numbered, key=lambda port: port[1])[0]
        ports = self.ordered_ports()
        return ports[-1] if ports else ""

    def log_port(self) -> str:
        """The first virtual COM port, where the nRF7002 DK's bootloader logs. None if there is one port."""
        ports = self.ordered_ports()
        return ports[0] if len(ports) > 1 else ""

    def describe(self) -> str:
        kind = f"{label(self.type)} ({self.pca})" if self.type else (
            f"unknown board ({self.pca})" if self.pca else "unknown board")
        if not self.debugger:
            kind += ", serial port only: nrfutil does not see its debugger"
        port = self.console_port()
        return f"{self.serial:<14} {kind}" + (f", console {port}" if port else ", no serial port")


def nrfutil_devices(text: str) -> list:
    """The devices in `nrfutil device list --json`, which prints one JSON event per line."""
    events = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    if not events:
        try:
            events = [json.loads(text)]
        except ValueError:
            return []
    found = {}
    for event in events:
        data = event.get("data") if isinstance(event, dict) else None
        devices = data.get("devices") if isinstance(data, dict) else None
        for device in devices if isinstance(devices, list) else []:
            if isinstance(device, dict) and isinstance(device.get("serialNumber"), (str, int)):
                found[str(device["serialNumber"])] = device
    return list(found.values())


def board_from_device(device: dict, platform: str | None = None) -> Board | None:
    """A DK's debugger, or None for a device that has no J-Link (a dongle, say)."""
    traits = device.get("traits")
    if isinstance(traits, dict) and "jlink" in traits and not traits["jlink"]:
        return None
    pca = ""
    for part in (device.get("devkit"), device.get("jlink")):
        if isinstance(part, dict) and isinstance(part.get("boardVersion"), str) and part["boardVersion"]:
            pca = part["boardVersion"]
            break
    ports = []
    for port in device.get("serialPorts") or []:
        if not isinstance(port, dict):
            continue
        path = port.get("comName") or port.get("path")
        if isinstance(path, str) and path:
            vcom = port.get("vcom") if isinstance(port.get("vcom"), int) else None
            ports.append((device_path(path, platform), vcom))
    return Board(serial=str(device["serialNumber"]), pca=pca, debugger=True, ports=ports)


def serial_ports() -> list:
    """The serial ports, as pyserial lists them. NEW_BOARD_PORTS names a JSON file of them instead,
    or "none": for tests, which must not see a board that happens to be plugged in."""
    override = os.environ.get("NEW_BOARD_PORTS")
    if override is not None:
        if override in ("", "none"):
            return []
        return json.loads(Path(override).read_text())
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    return [{"device": p.device, "serial_number": p.serial_number or "", "vid": p.vid}
            for p in list_ports.comports()]


def find_boards(nrfutil_text: str, ports: list, platform: str | None = None) -> list:
    """Each board once: what nrfutil sees of its debugger, with the J-Link serial ports added."""
    boards = [board for board in (board_from_device(d, platform) for d in nrfutil_devices(nrfutil_text)) if board]
    for port in ports:
        if not isinstance(port, dict) or port.get("vid") != SEGGER_VID or not port.get("device"):
            continue
        serial = str(port.get("serial_number") or "")
        path = device_path(port["device"], platform)
        board = next((b for b in boards if same_serial(b.serial, serial)), None)
        if board is None:
            board = next((b for b in boards if not b.debugger and b.serial == (serial or "unknown")), None)
        if board is None:
            board = Board(serial=serial or "unknown")
            boards.append(board)
        if all(existing != path for existing, _ in board.ports):
            board.ports.append((path, None))
    return sorted(boards, key=lambda b: b.serial)


def listing(boards: list) -> str:
    return "\n".join(f"  {board.describe()}" for board in boards)


def pick(boards: list, serial: str | None, board_type: str | None, need_debugger: bool,
         any_type: bool = False) -> tuple:
    """(board, its type): exactly one board, and what it is. Refusal otherwise. With any_type, a board
    whose type is not known is taken too, with "" for its type."""
    if serial:
        chosen = [board for board in boards if same_serial(board.serial, serial)]
        if not chosen:
            raise Refusal(f"no board with the serial number {serial} is plugged in."
                          + (f" These are:\n{listing(boards)}" if boards else " No board is."), 4)
    else:
        if not boards:
            raise Refusal("no board is plugged in. Plug the DK in by its debug USB port (J2), switch it on, and "
                          "close any serial terminal on it.", 2)
        if len(boards) > 1:
            raise Refusal(f"{len(boards)} boards are plugged in, so it is not clear which one to set up:\n"
                          f"{listing(boards)}\nUnplug the others, or name one with --serial-number <n>.", 3)
        chosen = boards
    board = chosen[0]
    if need_debugger and not board.debugger:
        raise Refusal(f"nrfutil does not see the debugger of the board on {board.console_port() or 'its port'}. "
                      "Is SEGGER's J-Link software installed, and nrfutil's device command (nrfutil install "
                      "device)?", 4)
    detected = board.type
    if board_type and detected and board_type != detected:
        raise Refusal(f"the debugger says the board {board.serial} is an {label(detected)} ({board.pca}), not an "
                      f"{label(board_type)}. Pass --board {detected}, or plug in the other board.", 5)
    chosen_type = detected or board_type or ""
    if not chosen_type and not any_type:
        raise Refusal(f"the debugger of the board {board.serial} does not say which DK it is "
                      f"({board.pca or 'no board version'}). Say it: --board nrf7002dk or --board nrf5340dk.", 5)
    if not board.console_port():
        raise Refusal(f"no serial port of the board {board.serial} was found. Unplug it and plug it in again; on "
                      "Linux, check that you are in the dialout group.", 4)
    return board, chosen_type


def command_boards(args) -> int:
    boards = find_boards(sys.stdin.read(), serial_ports())
    if not args.pick:
        print(listing(boards) if boards else "  no board is plugged in")
        return 0
    try:
        board, board_type = pick(boards, args.serial_number, args.board, args.need_debugger, args.any_type)
    except Refusal as refusal:
        say(f"error: {refusal}")
        return refusal.code
    if not board.type and args.board:
        say(f"note: the debugger does not say which DK this is ({board.pca or 'no board version'}): going by "
            f"--board {args.board}")
    print("|".join((board.serial, board_type, board.pca, board.console_port(), board.log_port())))
    return 0


# ---- the console -------------------------------------------------------------------------------


class Console:
    """The console's API with a console token, under /api/t/. Never prints the token or the address."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token

    def request(self, path: str, timeout: float = 30) -> tuple:
        """(HTTP status, body as bytes). Status 0 when the console could not be reached."""
        request = urllib.request.Request(f"{self.url}/api/t{path}", headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
                return answer.status, answer.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()
        except (urllib.error.URLError, OSError, ValueError):
            return 0, b""

    def get_json(self, path: str) -> tuple:
        status, body = self.request(path)
        try:
            return status, json.loads(body) if body else None
        except ValueError:
            return status, None


def console() -> Console:
    """The console, or Refusal with code 2 when there is no token (nothing to ask), 1 when it is wrong."""
    try:
        token = check_image.console_token()
    except PermissionError as error:
        raise Refusal(str(error), 1) from error
    if token is None:
        raise Refusal("no console token: make one on the console (Developer > API tokens) and keep it in "
                      "~/.cranium/console-token with mode 600, or set CRANIUM_TOKEN", 2)
    if not TOKEN.match(token):
        raise Refusal("the console token is not one the console makes: it is crn_ and 43 more characters", 1)
    url = check_image.console_url()
    if url is None:
        raise Refusal("the console's address is not known: cloud/.deploy/outputs.json has no ConsoleUrl, and "
                      "CRANIUM_CONSOLE_URL is not set", 1)
    if not CONSOLE_URL.match(url):
        raise Refusal("the console's address is not an https:// address", 1)
    return Console(url, token)


def command_token(args) -> int:
    try:
        api = console()
    except Refusal as refusal:
        print(refusal)
        return refusal.code
    if not args.online:
        print("a console token is there")
        return 0
    status, data = api.get_json("/me")
    if status == 0:
        print("the console could not be reached")
        return 1
    if status == 401:
        print("the console did not accept the token: it is unknown, revoked or expired. Make a new one on the "
              "console: Developer > API tokens")
        return 1
    if status != 200 or not isinstance(data, dict):
        print(f"the console answered {status} to the token")
        return 1
    if data.get("canWrite") is True:
        print("the console takes the token, and its owner is a release manager")
        return 0
    print("the console takes the token, and its owner can only read")
    return 3


def parse_version(text) -> tuple | None:
    match = VERSION.fullmatch(text) if isinstance(text, str) else None
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def version_text(parts: tuple) -> str:
    return f"{parts[0]}.{parts[1]}.{parts[2]}+{parts[3]}"


def same_version(said: str, expected: str) -> bool:
    """1.14.0+0 is 1.14.0: a board and the console show the build number or leave it out."""
    a, b = VERSION.match(said or ""), VERSION.match(expected or "")
    return bool(a and b) and a.groups()[:3] == b.groups()[:3]


def age(iso: str | None, now: float) -> str:
    try:
        seconds = now - datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return "never"
    if seconds < 90:
        return f"{max(0, round(seconds))} s ago"
    if seconds < 5400:
        return f"{round(seconds / 60)} min ago"
    return f"{round(seconds / 3600)} h ago"


def fleet_board(api: Console, thing: str) -> dict | None:
    status, data = api.get_json("/fleet")
    if status != 200 or not isinstance(data, dict):
        raise Refusal("the console could not be asked about its boards"
                      + (f" ({status})" if status else ": it could not be reached"), 1)
    for board in data.get("boards") or []:
        if isinstance(board, dict) and board.get("thing") == thing:
            return board
    return None


def describe_fleet_board(board: dict | None, now: float) -> list:
    if board is None:
        return ["  console        not registered: the board is not in the project's device group"]
    kind = label(str(board.get("type") or DEFAULT_BOARD))
    if board.get("bluetoothOnly"):
        where = "Bluetooth only: it never reaches AWS by itself"
    else:
        where = ("online" if board.get("online") else "offline") + f", last seen {age(board.get('lastSeen'), now)}"
    version = board.get("version")
    source = {"board": "as the board reported it", "phone": "as a phone last saw it"}.get(board.get("versionFrom"), "")
    return [f"  console        registered, {kind}, {where}",
            f"  firmware       {version} ({source})" if version and source else
            f"  firmware       {version or 'not known yet'}"]


def console_unmet(board: dict | None, args) -> list:
    unmet = []
    if board is None:
        return ["the console does not list the board"]
    if args.expect_online and not board.get("online"):
        unmet.append("the console does not show it online")
    if args.expect_version and not same_version(board.get("version") or "", args.expect_version):
        unmet.append(f"the console shows firmware {board.get('version') or 'none'}, not {args.expect_version}")
    return unmet


def command_console_status(args) -> int:
    try:
        api = console()
        deadline = time.time() + args.wait
        while True:
            board = fleet_board(api, args.thing)
            unmet = console_unmet(board, args) if (args.expect_online or args.expect_version or args.expect_listed) \
                else []
            if not unmet or time.time() >= deadline:
                break
            time.sleep(args.poll)
    except Refusal as refusal:
        say(f"error: {refusal}")
        return refusal.code
    print("\n".join(describe_fleet_board(board, time.time())))
    if unmet:
        say("error: " + "; ".join(unmet) + (f", after {args.wait:.0f} s" if args.wait else ""))
        return 1
    return 0


# ---- the image to install ----------------------------------------------------------------------


@dataclass
class Image:
    path: Path
    version: tuple
    board: str
    sha256: str
    source: str
    layout: int = check_image.LAYOUT_BEFORE


def read_image(path: Path, source: str) -> Image:
    data = path.read_bytes()
    parts = check_image.header_version(data)
    if parts is None:
        raise check_image.ImageError("not an MCUboot image")
    # An image from before 1.13.0 says no board type or flash layout: it is an nRF7002 DK's, of layout 1.
    board = check_image.board_of(data) or check_image.BOARD_BEFORE
    layout = check_image.layout_of(data) or check_image.LAYOUT_BEFORE
    return Image(path, parts, board, hashlib.sha256(data).hexdigest(), source, layout)


def fits(image: Image, board_type: str, layout: int | None) -> str | None:
    """Why the image is not for a board of this type whose bootloader has this flash layout, or None.
    Serial recovery checks neither, so this is the check that there is."""
    if image.board != board_type:
        return f"it is for the {label(image.board)}, not the {label(board_type)}"
    if layout is not None and image.layout != layout:
        return f"it is for flash layout {image.layout}, and this board's bootloader is built for layout {layout}"
    return None


def local_images(board_type: str, folder: Path, layout: int | None = None) -> list:
    """The images a build kept in binaries/ for this board type and layout, each one readable, newest first."""
    pattern = re.compile(rf"^{re.escape(IMAGE_PREFIX[board_type])}\d+\.\d+\.\d+-\d+\.signed\.bin$")
    found = []
    for path in sorted(folder.glob("*.signed.bin")) if folder.is_dir() else []:
        if not pattern.match(path.name):
            continue
        try:
            image = read_image(path, "binaries")
        except (OSError, check_image.ImageError):
            continue
        if fits(image, board_type, layout) is None:
            found.append(image)
    return sorted(found, key=lambda image: image.version, reverse=True)


def signature_checked(image: Image) -> None:
    """The console's own check of the signature (cloud/api/verify-image.mjs), where node is installed.
    Refusal if it fails. The bootloader checks it again, and starts nothing that fails."""
    node = shutil.which("node")
    if node is None:
        say("note: node was not found, so the signature was not checked here. The bootloader checks it, and "
            "starts nothing that fails.")
        return
    answer = subprocess.run([node, str(VERIFY_IMAGE), str(image.path)], capture_output=True, text=True,
                            timeout=120, check=False)
    if answer.returncode != 0:
        reason = " ".join((answer.stderr or answer.stdout).split())[:300]
        raise Refusal(f"{image.path.name} fails the console's check of its signature: {reason}")


def console_release(api: Console, board_type: str, layout: int | None = None) -> dict | None:
    """The newest active release for this board type and layout on the console, or None if it has none."""
    status, data = api.get_json("/firmware")
    if status != 200 or not isinstance(data, dict):
        raise Refusal("the console's releases could not be read" + (f" ({status})" if status else ""), 1)
    best = None
    for release in data.get("releases") or []:
        if not isinstance(release, dict) or release.get("status") != "active":
            continue
        if (release.get("board") or DEFAULT_BOARD) != board_type:
            continue
        if layout is not None and (release.get("layout") or check_image.LAYOUT_BEFORE) != layout:
            continue
        parts = parse_version(release.get("version"))
        sha256 = release.get("sha256")
        if parts is None or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            continue
        if best is None or parts > best[0]:
            best = (parts, release)
    return best[1] if best else None


def image_name(board_type: str, parts: tuple) -> str:
    return f"{IMAGE_PREFIX[board_type]}{parts[0]}.{parts[1]}.{parts[2]}-{parts[3]}.signed.bin"


def from_console(api: Console, board_type: str, out_dir: Path, binaries: Path,
                 layout: int | None = None) -> Image | None:
    release = console_release(api, board_type, layout)
    if release is None:
        say(f"note: the console has no active release for the {label(board_type)}")
        return None
    parts = parse_version(release["version"])
    for image in local_images(board_type, binaries, layout) + local_images(board_type, out_dir, layout):
        if image.sha256 == release["sha256"]:
            image.source = "console"
            say(f"The console's newest release for the {label(board_type)} is {version_text(parts)}: "
                f"its copy in {image.path.parent.name}/ has the same bytes.")
            return image
    status, data = api.request(f"/firmware/{urllib.parse.quote(release['version'], safe='')}/image", timeout=120)
    if status == 403:
        say("note: the console lets only a release manager download a release's image, and this token's owner "
            "is not one")
        return None
    if status != 200:
        raise Refusal(f"the image of release {version_text(parts)} could not be downloaded"
                      + (f" ({status})" if status else ": the console could not be reached"), 1)
    if hashlib.sha256(data).hexdigest() != release["sha256"] or len(data) != release.get("size", len(data)):
        raise Refusal(f"what the console sent for {version_text(parts)} is not that release's image: its SHA-256 "
                      "differs. Nothing was installed.", 1)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / image_name(board_type, parts)
    path.write_bytes(data)
    image = read_image(path, "console")
    unfit = fits(image, board_type, layout)
    if unfit:
        path.unlink()
        raise Refusal(f"the console's release {version_text(parts)} is not for this board: {unfit}", 1)
    say(f"Downloaded the console's newest release for the {label(board_type)}, {version_text(parts)}, "
        f"to {path.relative_to(REPO) if path.is_relative_to(REPO) else path}.")
    return image


def choose_image(args) -> Image:
    binaries = Path(args.binaries)
    out_dir = Path(args.out_dir)
    if args.image:
        image = read_image(Path(args.image), "given")
        unfit = fits(image, args.board, args.layout)
        if unfit:
            raise Refusal(f"{Path(args.image).name} is not for this board: {unfit}")
        signature_checked(image)
        return image

    newest_local = next(iter(local_images(args.board, binaries, args.layout)), None)
    try:
        image = from_console(console(), args.board, out_dir, binaries, args.layout)
    except Refusal as refusal:
        say(f"note: not from the console: {refusal}")
        image = None
    if image is not None:
        if newest_local is not None and newest_local.version > image.version:
            say(f"note: binaries/ has {version_text(newest_local.version)}, newer than the console's newest release. "
                f"To install it instead: --image binaries/{newest_local.path.name}")
        return image

    if newest_local is not None:
        say(f"The newest image in binaries/ for the {label(args.board)} is {version_text(newest_local.version)}. "
            "It may not be a release on the console.")
        signature_checked(newest_local)
        return newest_local

    if args.fallback and Path(args.fallback).is_file():
        image = read_image(Path(args.fallback), "build")
        if fits(image, args.board, args.layout) is None:
            say(f"warning: no release was found, so the board gets this build's own application, "
                f"{version_text(image.version)}, which is no release. Give it a release later from the console.")
            return image
    raise Refusal(f"there is no image to install for the {label(args.board)}: no console token to fetch the newest "
                  "release with, nothing for it in binaries/, and no build. Pass --image <signed.bin>")


def command_release(args) -> int:
    try:
        image = choose_image(args)
    except Refusal as refusal:
        say(f"error: {refusal}")
        return refusal.code
    except (OSError, check_image.ImageError) as error:
        say(f"error: {error}")
        return 1
    # As a path from here, where that is short: the script runs from the repository.
    shown = os.path.relpath(image.path) if image.path.resolve().is_relative_to(Path.cwd().resolve()) else image.path
    print("|".join((str(shown), version_text(image.version), image.source, image.sha256)))
    return 0


# ---- the board's serial console ----------------------------------------------------------------


def shown_status(status: dict) -> tuple:
    """(lines that may be shown, names of the keys left out)."""
    lines = [f"  {key:<14} {value}" for key, value in status.items() if key in SHOWN_KEYS]
    hidden = [key for key in status if key not in SHOWN_KEYS]
    return lines, hidden


def status_unmet(status: dict, args) -> list:
    unmet = []
    if args.expect_state and status.get("state") != args.expect_state:
        unmet.append(f"its state is {status.get('state', 'not known')}, not {args.expect_state}")
    if args.expect_version and not same_version(status.get("firmware", ""), args.expect_version):
        unmet.append(f"it runs {status.get('firmware', 'nothing it says')}, not {args.expect_version}")
    # Firmware that does not say its board type is an nRF7002 DK's (docs/fleet.md).
    if args.expect_board and status.get("board", DEFAULT_BOARD) != args.expect_board:
        unmet.append(f"it says it is a {status.get('board', DEFAULT_BOARD)}, not a {args.expect_board}")
    if args.expect_cloud and status.get("cloud") != args.expect_cloud:
        unmet.append(f"its cloud is {status.get('cloud', 'not known')}, not {args.expect_cloud}")
    if args.expect_bt_window and status.get("bt window") != args.expect_bt_window:
        unmet.append(f"its Bluetooth window is {status.get('bt window', 'not known')}, not {args.expect_bt_window}")
    return unmet


def read_status(port: str) -> dict:
    from board import Console as SerialConsole  # pyserial: only here

    with SerialConsole(port) as link:
        return link.status()


def command_serial_status(args) -> int:
    if find_spec("serial") is None:
        say("error: pyserial is missing: python3 -m pip install -r tools/requirements.txt")
        return 3
    from board import BoardError

    deadline = time.time() + args.wait
    status, problem, unmet = None, None, []
    while True:
        try:
            status = read_status(args.port)
            problem = None
            unmet = status_unmet(status, args)
            if not unmet:
                break
        except (BoardError, OSError) as error:
            problem = str(error)
        if time.time() >= deadline:
            break
        time.sleep(args.poll)
    if status is None:
        say(f"error: the board on {args.port} does not answer: {problem}")
        return 1
    if args.record:
        Path(args.record).write_text("".join(f"{key}={status.get(key, '')}\n" for key in (
            "state", "thing name", "firmware", "board", "cloud", "bt passkey", "bt name", "bt window")))
    if not args.quiet:
        lines, hidden = shown_status(status)
        print("\n".join(lines))
        if hidden:
            print(f"  (not shown: {', '.join(hidden)})")
    if unmet:
        say("error: the board on " + args.port + ": " + "; ".join(unmet)
            + (f", after {args.wait:.0f} s" if args.wait else ""))
        return 1
    return 0


def seal_result(line: str) -> str | None:
    """'sealed' or 'nothing to do' when the gesture did what it should, 'refused' when it cannot, or None."""
    for said, result in SEAL_DONE.items():
        if said in line:
            return result
    return "refused" if SEAL_REFUSED in line else None


def command_watch_seal(args) -> int:
    if find_spec("serial") is None:
        say("error: pyserial is missing, so the bootloader's log cannot be read here")
        return 3
    import serial

    deadline = time.time() + args.timeout
    pending = b""
    try:
        with serial.Serial(args.port, 115200, timeout=0.2) as link:
            while time.time() < deadline:
                pending += link.read(4096)
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    line = ANSI.sub("", raw.decode("utf-8", "replace")).strip()
                    if "golden:" not in line:
                        continue
                    print(f"  bootloader: {line[line.index('golden:'):]}", flush=True)
                    result = seal_result(line)
                    if result == "refused":
                        return 1
                    if result is not None:
                        return 0
    except (OSError, serial.SerialException) as error:
        say(f"error: the bootloader's log on {args.port} cannot be read: {error}")
        return 3
    say(f"error: the bootloader said nothing about the golden image within {args.timeout:.0f} s")
    return 2


def command_ble_scan(args) -> int:
    if find_spec("bleak") is None:
        say("note: bleak is not installed (python3 -m pip install bleak), so this computer cannot look for the "
            "board over Bluetooth")
        return 3
    from bleak import BleakScanner

    async def scan() -> list:
        return await BleakScanner.discover(timeout=args.timeout)

    try:
        names = {device.name for device in asyncio.run(scan()) if device.name}
    except Exception as error:  # noqa: BLE001 - bleak raises many kinds, all meaning "cannot scan"
        say(f"note: this computer cannot scan for Bluetooth here: {type(error).__name__}")
        return 3
    if args.name in names or (args.prefix and any(name.startswith(args.prefix) for name in names)):
        print(f"  bluetooth      advertising as {args.name if args.name in names else args.prefix + '...'}")
        return 0
    say(f"error: nothing advertised as {args.name or args.prefix + '...'} within {args.timeout:.0f} s")
    return 1


# ---- this computer -----------------------------------------------------------------------------


def command_outputs(args) -> int:
    try:
        outputs = json.loads(OUTPUTS.read_text())
    except OSError:
        print("cloud/.deploy/outputs.json is missing")
        return 2
    except ValueError:
        print("cloud/.deploy/outputs.json is not JSON")
        return 1
    missing = [key for key in OUTPUT_KEYS if not isinstance(outputs, dict) or not outputs.get(key)]
    if missing:
        print(f"cloud/.deploy/outputs.json has no {', '.join(missing)}")
        return 1
    print("cloud/.deploy/outputs.json has what provisioning and the console need")
    return 0


def command_pydeps(args) -> int:
    missing = [name for name, module in (("pyserial", "serial"), ("cbor2", "cbor2"), ("cryptography", "cryptography"))
               if find_spec(module) is None]
    print(" ".join(missing))
    return 1 if missing else 0


def account_names(outputs: Path = OUTPUTS) -> list:
    """What the cloud stack's outputs name, longest first, for redact_line()."""
    try:
        values = json.loads(outputs.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(values, dict):
        return []
    names = {value for key, value in values.items()
             if key not in OUTPUTS_THAT_NAME_NOTHING and isinstance(value, str) and len(value) >= 6}
    return sorted(names, key=len, reverse=True)


def redact_line(line: str, names: list) -> str:
    """A line of a tool's output without the network's name, the board's Wi-Fi address, or anything that
    says whose AWS account this is: its names, ARNs, endpoints, buckets, addresses and account number."""
    line = HIDDEN_STATUS_LINE.sub(r"\1\2\3(hidden)", line)
    line = WIFI_STORED.sub("Wi-Fi network (name not shown)", line)
    for name in names:
        line = line.replace(name, ACCOUNT_SHOWN)
    for pattern in ACCOUNT_PATTERNS:
        line = pattern.sub(ACCOUNT_SHOWN, line)
    return ADDRESS.sub("<address>", line)


def command_redact(args) -> int:
    names = account_names()
    for line in sys.stdin:
        sys.stdout.write(" " * args.indent + redact_line(line.rstrip("\n"), names) + "\n")
        sys.stdout.flush()
    return 0


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    command = commands.add_parser("boards", help="the boards plugged in; nrfutil device list --json on stdin")
    command.add_argument("--pick", action="store_true", help="exactly one: serial|type|pca|console|log")
    command.add_argument("--serial-number")
    command.add_argument("--board", choices=BOARD_TYPES)
    command.add_argument("--need-debugger", action="store_true")
    command.add_argument("--any-type", action="store_true", help="also a board whose type is not known")

    command = commands.add_parser("release", help="the signed image to install: path|version|source|sha256")
    command.add_argument("--board", choices=BOARD_TYPES, required=True)
    command.add_argument("--image", help="this image, checked")
    command.add_argument("--fallback", help="the build's own image, if nothing else is found")
    command.add_argument("--layout", type=int, help="the flash layout the board's bootloader was built for")
    command.add_argument("--out-dir", default=str(REPO / "build-new-board" / "images"))
    command.add_argument("--binaries", default=str(BINARIES))

    command = commands.add_parser("serial-status", help="the board's STATUS, without what names the network")
    command.add_argument("--port", required=True)
    command.add_argument("--wait", type=float, default=0, help="seconds to keep asking until it answers as expected")
    command.add_argument("--poll", type=float, default=3)
    command.add_argument("--expect-state")
    command.add_argument("--expect-version")
    command.add_argument("--expect-board", choices=BOARD_TYPES)
    command.add_argument("--expect-cloud")
    command.add_argument("--expect-bt-window")
    command.add_argument("--record", help="write state, thing name, firmware, board, cloud and the bt keys here")
    command.add_argument("--quiet", action="store_true")

    command = commands.add_parser("console-status", help="the console's view of the board")
    command.add_argument("--thing", required=True)
    command.add_argument("--wait", type=float, default=0)
    command.add_argument("--poll", type=float, default=10)
    command.add_argument("--expect-online", action="store_true")
    command.add_argument("--expect-version")
    command.add_argument("--expect-listed", action="store_true")

    command = commands.add_parser("watch-seal", help="the bootloader's log while a person does the gesture")
    command.add_argument("--port", required=True)
    command.add_argument("--timeout", type=float, default=240)

    command = commands.add_parser("ble-scan", help="whether the board advertises over Bluetooth")
    command.add_argument("--name", default="")
    command.add_argument("--prefix", default="Cranium-")
    command.add_argument("--timeout", type=float, default=20)

    command = commands.add_parser("token", help="whether there is a console token")
    command.add_argument("--online", action="store_true", help="and ask the console what it may do")

    commands.add_parser("outputs", help="whether cloud/.deploy/outputs.json has what is needed")
    commands.add_parser("pydeps", help="the missing Python packages of the tools")
    command = commands.add_parser("redact", help="stdin to stdout, without network or account names")
    command.add_argument("--indent", type=int, default=0)

    args = parser.parse_args(argv)
    return {
        "boards": command_boards, "release": command_release, "serial-status": command_serial_status,
        "console-status": command_console_status, "watch-seal": command_watch_seal, "ble-scan": command_ble_scan,
        "token": command_token, "outputs": command_outputs, "pydeps": command_pydeps, "redact": command_redact,
    }[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

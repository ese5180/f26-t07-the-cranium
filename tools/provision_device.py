#!/usr/bin/env python3
"""Provision a board: device ID, Wi-Fi network, device identity, and cloud settings.

    python tools/provision_device.py              do whatever is still missing
    python tools/provision_device.py --wifi       send the Wi-Fi network again
    python tools/provision_device.py --no-wifi    register the board now, add the network later
    python tools/provision_device.py --status     show what the board has
    python tools/provision_device.py --reset      factory reset the board
    python tools/provision_device.py --board nrf5340dk                 a board with Bluetooth only
    python tools/provision_device.py --board nrf5340dk --new-passkey   give it a new passkey
    python tools/provision_device.py --board nrf5340dk --no-register   give it none
    python tools/provision_device.py --via console   register it through the console, with a console token
    python tools/provision_device.py --via aws       register it with the AWS CLI, as an administrator

What it does for an nRF7002 DK (--board nrf7002dk, the default), in order:

1. If the board is in factory mode, runs first-time setup with the ID from --id, or else
   the 16 hexadecimal digits of its SoC's identifier. The board restarts.
2. Sends the network from ~/.cranium/wifi_secrets.h to the board, which stores it in
   TF-M. The file is read through sudo if it is locked. The console's echo is off for
   this, so the passphrase does not come back, and it never appears in this tool's output.
3. Asks the board to create its own key pair. The private key never leaves the board;
   the board prints a certificate signing request.
4. Registers the board in AWS IoT: a thing named after the board's hardware ID, a
   certificate issued for that request, the device policy, the device group.
5. Loads the certificate and the Amazon root CA into the board, and tells it which
   AWS IoT endpoint to use and where firmware may be downloaded from.

For an nRF5340 DK (--board nrf5340dk), which has Bluetooth and no Wi-Fi, and never reaches AWS
by itself (docs/fleet.md):

1. First-time setup, as above.
2. Registers the board in AWS IoT as a thing with the attribute board=nrf5340dk, in the device
   group, so that the console lists it. No key, no certificate, no network and no cloud settings.
3. Draws the board's own Bluetooth passkey, six digits at random, and the four hex digits of the
   name it advertises (Cranium-3F9C), and registers both with the console first, so that a phone
   gets the passkey from the console's pairing route. Then sends them to the board with BT_PASSKEY,
   which keeps them in TF-M's protected storage. The passkey is never printed, and the board never
   shows it. A board that has one already keeps it, unless --new-passkey. With --no-register it gets
   none, and shows a new passkey on its serial console for each pairing.

The console is reached with a console token (CRANIUM_TOKEN or ~/.cranium/console-token), as
scripts/firmware/check-image.sh does. See src/bt_passkey.h in the firmware for what a passkey that does not
change costs, and when to give a board a new one.

Registering the board goes one of two ways (--via, docs/new-board-setup.md):

- console: through the console's POST /api/t/devices/register, with a release manager's console token.
  The board's request goes to the console, which has AWS IoT issue the certificate and hands back the
  certificate, the root CA, the endpoint and the download address. No AWS CLI, no AWS account and no
  cloud/.deploy/outputs.json are needed. The console's address is --console, else CRANIUM_CONSOLE_URL, else
  ConsoleUrl in cloud/.deploy/outputs.json, else consoleUrl in apps/config/cranium.json.
- aws: with the AWS CLI, signed in as an administrator with --profile, and the cloud stack's outputs in
  cloud/.deploy/outputs.json (cloud/deploy.sh writes it).

The default, auto, takes aws when this computer is signed in to AWS and has the outputs, and else the
console when there is a console token. A board registered before, and wiped since, needs --new-identity
either way: the console refuses to replace a board's certificate without it, and the old one is retired.
Run from an nRF Connect SDK terminal so that pyserial is available.
"""

import argparse
import base64
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from board import BoardError, Console, ShellFirmware, crc16_ccitt_false
from check_image import console_token, console_url
from local import WIFI_SECRETS

REPO = Path(__file__).resolve().parent.parent
OUTPUTS = REPO / "cloud" / ".deploy" / "outputs.json"
ROOT_CA = REPO / "firmware" / "certs" / "AmazonRootCA1.pem"
# SHA-256 of the DER form of Amazon Root CA 1, as published by Amazon Trust Services.
ROOT_CA_SHA256 = "8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e"
# Bytes of a certificate per line: 256 base64 characters, well inside the line buffer.
CHUNK = 192
THING_PREFIX = "cranium-"
# The board types of docs/fleet.md. A board whose firmware does not say is an nRF7002 DK.
BOARD_TYPES = ("nrf7002dk", "nrf5340dk")
DEFAULT_BOARD = "nrf7002dk"
# What the board advertises as, before the four hex digits: CONFIG_BT_DEVICE_NAME.
BT_NAME_PREFIX = "Cranium-"
# The operating system's random source (os.urandom). Not the secrets module: tools/secrets.py, which
# keeps the Wi-Fi secrets file, has that name, and comes first on the path of a tool run from here.
SYSTEM_RANDOM = random.SystemRandom()
# Provisioning through the console (docs/new-board-setup.md): its route, and what its answer must look like.
REGISTER_PATH = "/devices/register"
CONSOLE_ADDRESS = re.compile(r"^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)$")
ENDPOINT = re.compile(r"^[a-z0-9]{10,20}-ats\.iot\.[a-z]{2}(-[a-z]+)+-\d{1,2}\.amazonaws\.com$")
DOWNLOAD_PREFIX = re.compile(r"^https://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z]{2}(-[a-z]+)+-\d{1,2}"
                             r"\.amazonaws\.com/firmware/$")


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def pem_to_der(pem: str) -> bytes:
    body = re.sub(r"-----(BEGIN|END) [A-Z ]+-----", "", pem)
    return base64.b64decode("".join(body.split()))


class Aws:
    def __init__(self, profile: str, region: str):
        self.base = ["aws", "--profile", profile, "--region", region, "--output", "json",
                     "--no-cli-pager"]

    def call(self, *args: str, allow: tuple[str, ...] = ()) -> dict:
        result = subprocess.run(self.base + list(args), capture_output=True, text=True)
        if result.returncode != 0:
            if any(code in result.stderr for code in allow):
                return {}
            fail(f"aws {' '.join(args[:2])} failed:\n{result.stderr.strip()}")
        return json.loads(result.stdout) if result.stdout.strip() else {}


def read_wifi_secrets() -> tuple[str, str, str]:
    if not WIFI_SECRETS.exists():
        fail(f"{WIFI_SECRETS} does not exist: run `python tools/secrets.py wifi`")
    try:
        text = WIFI_SECRETS.read_text()
    except PermissionError:
        print("The Wi-Fi secrets file is locked; sudo will ask for your password to read it.")
        text = subprocess.run(["sudo", "cat", str(WIFI_SECRETS)], check=True,
                              capture_output=True, text=True).stdout

    def define(name: str, quoted: bool) -> str:
        pattern = rf'^\s*#define\s+{name}\s+' + (r'"((?:[^"\\]|\\.)*)"' if quoted else r"(\w+)")
        match = re.search(pattern, text, re.MULTILINE)
        if not match:
            fail(f"{name} is not defined in the Wi-Fi secrets file")
        value = match.group(1)
        return re.sub(r"\\(.)", r"\1", value) if quoted else value

    ssid = define("WIFI_SECRETS_SSID", True)
    passphrase = define("WIFI_SECRETS_PASSPHRASE", True)
    security = define("WIFI_SECRETS_SECURITY", False)
    if ssid == "your-network-name":
        fail("the Wi-Fi secrets file still contains the placeholder values")
    return ssid, passphrase, security


def provision_wifi(console: Console) -> None:
    ssid, passphrase, security = read_wifi_secrets()
    if "|" in ssid:
        fail("a network whose name contains | cannot be sent over the console")
    # The name goes byte for byte: a phone's hotspot has a curly apostrophe in it.
    console.run(f"WIFI_SEC|{ssid}|{security}|{passphrase}", wait=6)
    print(f"Wi-Fi network \"{ssid}\" ({security}) stored on the board")


def load_certificate(console: Console, der: bytes, kind: str) -> None:
    chunks = [der[offset:offset + CHUNK] for offset in range(0, len(der), CHUNK)]
    console.run(f"STREAM_START|{len(der)}|{len(chunks)}|{crc16_ccitt_false(der):04x}|{kind}")
    for index, chunk in enumerate(chunks):
        console.run(f"STREAM_CHUNK|{index}|{b64(chunk)}", wait=8)


def root_ca_der() -> bytes:
    der = pem_to_der(ROOT_CA.read_text())
    if hashlib.sha256(der).hexdigest() != ROOT_CA_SHA256:
        fail(f"{ROOT_CA.relative_to(REPO)} is not Amazon Root CA 1 (fingerprint mismatch)")
    return der


def request_from_board(console: Console, replace: bool) -> str:
    lines = console.run("KEYGEN|REPLACE" if replace else "KEYGEN", wait=15)
    text = "\n".join(lines)
    match = re.search(r"-----BEGIN CERTIFICATE REQUEST-----.*?-----END CERTIFICATE REQUEST-----",
                      text, re.DOTALL)
    if not match:
        fail("the board did not print a certificate signing request:\n" + text)
    return match.group(0) + "\n"


def register_in_aws(aws: Aws, outputs: dict, thing: str, csr: str) -> bytes:
    aws.call("iot", "create-thing", "--thing-name", thing, allow=("ResourceAlreadyExistsException",))
    aws.call("iot", "add-thing-to-thing-group", "--thing-name", thing,
             "--thing-group-name", outputs["DeviceGroupName"])

    previous = aws.call("iot", "list-thing-principals", "--thing-name", thing).get("principals", [])

    with tempfile.NamedTemporaryFile("w", suffix=".csr") as file:
        file.write(csr)
        file.flush()
        created = aws.call("iot", "create-certificate-from-csr", "--set-as-active",
                           "--certificate-signing-request", f"file://{file.name}")

    arn = created["certificateArn"]
    aws.call("iot", "attach-policy", "--policy-name", outputs["DevicePolicyName"], "--target", arn)
    # Exclusive: AWS IoT refuses to attach this certificate to any other thing.
    aws.call("iot", "attach-thing-principal", "--thing-name", thing, "--principal", arn,
             "--thing-principal-type", "EXCLUSIVE_THING")

    # A board has one identity: retire certificates from earlier provisioning runs.
    for old in previous:
        if old == arn:
            continue
        old_id = old.rsplit("/", 1)[-1]
        aws.call("iot", "detach-thing-principal", "--thing-name", thing, "--principal", old)
        aws.call("iot", "detach-policy", "--policy-name", outputs["DevicePolicyName"],
                 "--target", old, allow=("ResourceNotFoundException", "InvalidRequestException"))
        aws.call("iot", "update-certificate", "--certificate-id", old_id, "--new-status", "INACTIVE")
        aws.call("iot", "delete-certificate", "--certificate-id", old_id,
                 allow=("DeleteConflictException",))
        print(f"Retired the board's previous certificate {old_id[:12]}...")

    print(f"Registered {thing} in AWS IoT with certificate {arn.rsplit('/', 1)[-1][:12]}...")
    return pem_to_der(created["certificatePem"])


def load_outputs() -> dict:
    if not OUTPUTS.exists():
        fail(f"{OUTPUTS.relative_to(REPO)} is missing: deploy the cloud stack first "
             "(cloud/deploy.sh)")
    outputs = json.loads(OUTPUTS.read_text())
    for key in ("Region", "DeviceGroupName", "DevicePolicyName", "FirmwareDownloadPrefix"):
        if key not in outputs:
            fail(f"{OUTPUTS.relative_to(REPO)} has no {key}")
    return outputs


def weak_passkey(passkey: int) -> bool:
    """A pattern a person would pick, which the board refuses too (bt_passkey_weak() in the firmware):
    one digit six times, or a run up or down such as 123456 or 987654."""
    text = f"{passkey:06d}"
    return len(set(text)) == 1 or text in "0123456789" or text in "9876543210"


def draw_passkey() -> int:
    """Six digits from the operating system's random source, none of them a pattern."""
    while True:
        passkey = SYSTEM_RANDOM.randrange(1_000_000)
        if not weak_passkey(passkey):
            return passkey


def draw_tag() -> int:
    """The four hex digits of the name a board advertises, for the console to know it by."""
    return SYSTEM_RANDOM.randrange(0x10000)


class ConsoleApi:
    """The console's API with a console token. Never prints the token, nor what is sent."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token

    def send(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
        """(HTTP status, the answer's JSON object or None). Status 0 when the console was not reached."""
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"{self.url}/api/t{path}", data=data, method=method,
                                         headers={"Authorization": f"Bearer {self.token}",
                                                  "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as answer:
                status, text = answer.status, answer.read()
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read()
        except (urllib.error.URLError, OSError, ValueError):
            return 0, None
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        return status, parsed if isinstance(parsed, dict) else None

    def call(self, method: str, path: str, body: dict | None = None) -> int:
        return self.send(method, path, body)[0]


def console_api(purpose: str = "the board's passkey", alternative: str = "pass --no-register to give the "
                "board no passkey of its own") -> ConsoleApi:
    try:
        token = console_token()
    except PermissionError as error:
        fail(str(error))
    url = console_url()
    if token is None:
        fail(f"the console is needed for {purpose}: give a console token in CRANIUM_TOKEN or "
             f"~/.cranium/console-token (the console's Developer > API tokens), or {alternative}")
    if url is None:
        fail(f"the console is needed for {purpose}, and its address is not known: pass --console "
             "https://<the console>, or set CRANIUM_CONSOLE_URL")
    if not CONSOLE_ADDRESS.match(url):
        fail("the console's address must be an https:// address")
    return ConsoleApi(url, token)


def has_token() -> bool:
    try:
        return console_token() is not None
    except PermissionError:
        return True  # It is there; console_api() says what is wrong with it.


def aws_signed_in(profile: str) -> bool:
    """Whether the AWS way can be taken: the stack's outputs, the AWS CLI, and a sign-in that holds.
    What `aws sts` says names the account, so none of it is kept."""
    if not OUTPUTS.exists() or shutil.which("aws") is None:
        return False
    try:
        region = json.loads(OUTPUTS.read_text()).get("Region") or "us-east-1"
        result = subprocess.run(["aws", "sts", "get-caller-identity", "--profile", profile, "--region", region,
                                 "--output", "json", "--no-cli-pager"], capture_output=True, text=True, timeout=60)
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def choose_way(args) -> str:
    """console or aws, by --via: auto takes aws when this computer is signed in to it, else the console."""
    if args.via != "auto":
        return args.via
    if aws_signed_in(args.profile):
        return "aws"
    if has_token():
        print("Registering the board through the console, with your console token: no AWS sign-in is needed.")
        return "console"
    fail("the board cannot be registered: this computer has no console token and is not signed in to AWS. "
         "Make a console token (the console's Developer > API tokens, as a release manager) and keep it in "
         "~/.cranium/console-token, or sign in to AWS as an administrator with cloud/.deploy/outputs.json "
         "(docs/new-board-setup.md)")


def board_id(thing: str) -> str:
    """The identifier the console registers a board by: the 16 hex digits of cranium-<id>."""
    if not re.fullmatch(r"cranium-[0-9a-f]{16}", thing):
        fail(f"the console registers boards named cranium- and 16 hex digits, and this one is {thing}: "
             "register it with --via aws")
    return thing.removeprefix(THING_PREFIX)


def register_through_console(api: ConsoleApi, thing: str, csr: str, reregister: bool) -> dict:
    """POST /api/devices/register: the board's certificate, the root CA, the endpoint and the download
    address, each checked before anything goes to the board."""
    status, answer = api.send("POST", REGISTER_PATH, {"id": board_id(thing), "csr": csr, "reregister": reregister})
    error = (answer or {}).get("error") if isinstance((answer or {}).get("error"), dict) else {}
    if status == 0:
        fail("the console could not be reached. Nothing was registered")
    if status in (404, 405):
        fail("this console cannot register boards yet (it needs console 2.6.1): use --via aws")
    if status == 409 and error.get("code") == "already_registered":
        fail(f"{thing} was registered before. If the board was wiped, run this again with --new-identity, "
             "which retires its old certificate")
    if status == 403:
        fail("the console refused: registering a board takes a release manager's console token")
    if status == 429:
        fail("the console refused: " + str(error.get("message") or "too many boards registered in the last hour"))
    if status != 200 or answer is None:
        fail(f"the console did not register the board ({status}): {error.get('message') or 'no reason given'}")
    if answer.get("thing") != thing:
        fail("the console answered for another board. Nothing was sent to this one")
    endpoint, prefix = answer.get("endpoint"), answer.get("downloadPrefix")
    if not isinstance(endpoint, str) or not ENDPOINT.match(endpoint):
        fail("the console's answer has no AWS IoT endpoint. Nothing was sent to the board")
    if not isinstance(prefix, str) or not DOWNLOAD_PREFIX.match(prefix):
        fail("the console's answer has no download address. Nothing was sent to the board")
    try:
        certificate = pem_to_der(str(answer.get("certificatePem") or ""))
        root = pem_to_der(str(answer.get("rootCa") or ""))
    except ValueError:
        fail("the console's answer is not a certificate. Nothing was sent to the board")
    if not certificate:
        fail("the console's answer has no certificate. Nothing was sent to the board")
    if hashlib.sha256(root).hexdigest() != ROOT_CA_SHA256:
        fail("the root CA from the console is not Amazon Root CA 1. Nothing was sent to the board")
    print(f"Registered {thing} through the console, with a certificate for the board's own key")
    return {"certificate": certificate, "endpoint": endpoint, "prefix": prefix}


def register_bluetooth_only_through_console(thing: str, board: str) -> None:
    api = console_api("registering the board", "register it with --via aws")
    status, answer = api.send("POST", REGISTER_PATH, {"id": board_id(thing), "board": board})
    if status != 200:
        message = ((answer or {}).get("error") or {}).get("message") if answer else None
        fail(f"the console did not register the board ({status or 'not reached'}): {message or 'no reason given'}")
    print(f"Registered {thing} through the console as a {board}, with no certificate: it never connects")


def pairing_path(thing: str) -> str:
    return f"/devices/{urllib.parse.quote(thing, safe='')}/bluetooth-pairing"


def register_passkey(api: ConsoleApi, thing: str, board: str, name: str, passkey: int) -> None:
    """The console keeps the passkey for the phone apps, and hands it out by the name the board
    advertises (GET /api/pairing/{name}). First, so that a board never has a passkey nobody knows."""
    status = api.call("PUT", pairing_path(thing), {"board": board, "name": name, "passkey": f"{passkey:06d}"})
    if status in (404, 405):
        fail("the console does not take a board's passkey yet: it needs PUT "
             "/api/devices/{thing}/bluetooth-pairing (docs/fleet.md). Nothing was sent to the board. "
             "Provision with --no-register for now: the board then shows a new passkey on its serial "
             "console for each pairing")
    if status not in (200, 201, 204):
        fail(f"the console refused the board's passkey ({status}). Nothing was sent to the board")


def forget_passkey(api: ConsoleApi, thing: str) -> None:
    status = api.call("DELETE", pairing_path(thing))
    if status not in (200, 204, 404):
        print(f"warning: the console still has a passkey for {thing} that the board does not ({status})")


def register_bluetooth_only_thing(aws: "Aws", outputs: dict, thing: str, board: str) -> None:
    """A thing with its type as an attribute, in the device group, and no certificate: it never
    connects. The console lists it from the group and its type from the attribute (docs/fleet.md)."""
    attributes = json.dumps({"attributes": {"board": board}, "merge": True})
    created = aws.call("iot", "create-thing", "--thing-name", thing, "--attribute-payload", attributes,
                       allow=("ResourceAlreadyExistsException",))
    if not created:
        aws.call("iot", "update-thing", "--thing-name", thing, "--attribute-payload", attributes)
    aws.call("iot", "add-thing-to-thing-group", "--thing-name", thing,
             "--thing-group-name", outputs["DeviceGroupName"])
    print(f"Registered {thing} in AWS IoT as a {board}, with no certificate: it never connects")


def provision_bluetooth_only(console: Console, status: dict[str, str], args) -> None:
    """An nRF5340 DK: a thing, and the board's own passkey, registered with the console first."""
    thing = status["thing name"]
    if choose_way(args) == "console":
        register_bluetooth_only_through_console(thing, args.board)
    else:
        outputs = load_outputs()
        aws = Aws(args.profile, outputs["Region"])
        register_bluetooth_only_thing(aws, outputs, thing, args.board)

    has_passkey = status.get("bt passkey") == "set"
    if args.no_register:
        print("No passkey of its own: the board shows a new one on its serial console for each pairing."
              if not has_passkey else
              "The board keeps the passkey it has: --no-register leaves it alone.")
        return
    if has_passkey and not args.new_passkey:
        print(f"The board has its own passkey already, and advertises as {status.get('bt name', '?')}. "
              "--new-passkey gives it a new one")
        return

    api = console_api()
    passkey = draw_passkey()
    name = f"{BT_NAME_PREFIX}{draw_tag():04X}"
    register_passkey(api, thing, args.board, name, passkey)
    # The console's echo is off (board.py), so the passkey does not come back, and a refusal names
    # the command only.
    try:
        _, final = console.exchange(f"BT_PASSKEY|{passkey:06d}|{name.removeprefix(BT_NAME_PREFIX)}", 6)
    except BoardError:
        forget_passkey(api, thing)
        raise
    if not final.startswith("OK"):
        forget_passkey(api, thing)
        fail(f"the board did not store its passkey: {final[4:]}")
    if name not in final:
        print(f"warning: the board says {final[3:]!r}, and the console knows it as {name}")
    print(f"The board's own passkey is stored on it and registered with the console. It advertises as "
          f"{name} while Bluetooth is open.")


def show(status: dict[str, str]) -> None:
    for key, value in status.items():
        print(f"  {key:<14} {value}")


def first_time_setup(console: Console, thing: str, device_id: str | None) -> dict[str, str]:
    """Take a board out of factory mode. It erases everything, which is nothing on such a
    board, and restarts."""
    device_id = device_id or thing.removeprefix(THING_PREFIX)
    console.run(f"INIT|{device_id}", wait=15)
    print(f"First-time setup done, device ID {device_id}. The board is restarting ...")
    console.wait_until_up()
    return console.status()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", help="serial port of the board's console (default: auto)")
    parser.add_argument("--profile", default="cranium", help="AWS CLI profile (default: cranium)")
    parser.add_argument("--wifi", action="store_true", help="only (re)send the Wi-Fi network")
    parser.add_argument("--no-wifi", action="store_true",
                        help="skip the Wi-Fi network: identity and cloud settings only")
    parser.add_argument("--status", action="store_true", help="only show the board's state")
    parser.add_argument("--reset", action="store_true", help="factory reset the board")
    parser.add_argument("--new-identity", action="store_true",
                        help="replace the board's key pair and certificate")
    parser.add_argument("--id", help="device ID for a board in factory mode: 1-32 letters or "
                                     "digits (default: its SoC's identifier)")
    parser.add_argument("--connect-timeout", type=float, default=90,
                        help="seconds to wait for the board to reach AWS IoT (default: 90)")
    parser.add_argument("--board", choices=BOARD_TYPES, default=DEFAULT_BOARD,
                        help="the board type (docs/fleet.md): nrf7002dk (default), or nrf5340dk, which "
                             "has Bluetooth only")
    parser.add_argument("--new-passkey", action="store_true",
                        help="nrf5340dk: give the board a new passkey, and register it with the console")
    parser.add_argument("--no-register", action="store_true",
                        help="nrf5340dk: give the board no passkey of its own, and leave the console be")
    parser.add_argument("--via", choices=("auto", "console", "aws"), default="auto",
                        help="register the board through the console with a console token, or with the AWS CLI "
                             "(default auto: AWS when signed in to it, else the console)")
    parser.add_argument("--console", help="the console's address, https://... (default: CRANIUM_CONSOLE_URL, "
                                          "cloud/.deploy/outputs.json, apps/config/cranium.json)")
    args = parser.parse_args()
    if args.console:
        os.environ["CRANIUM_CONSOLE_URL"] = args.console
    if args.board == DEFAULT_BOARD and (args.new_passkey or args.no_register):
        fail("--new-passkey and --no-register are for a board with Bluetooth only: --board nrf5340dk")
    if args.new_passkey and args.no_register:
        fail("--new-passkey registers the passkey with the console, and --no-register does not: pick one")
    if args.board != DEFAULT_BOARD and (args.wifi or args.no_wifi or args.new_identity):
        fail(f"a {args.board} has no Wi-Fi and no identity in AWS IoT: --wifi, --no-wifi and "
             "--new-identity are for an nrf7002dk")

    try:
        with Console(args.port) as console:
            status = console.status()
            thing = status["thing name"]
            print(f"Board {thing} on {console.port}, firmware {status.get('firmware', '?')}")

            if args.status:
                show(status)
                return

            if "state" not in status:
                raise ShellFirmware("old firmware")

            if args.reset:
                if status.get("state") == "FACTORY":
                    print("The board is in factory mode already: nothing to reset.")
                    return
                console.run("FACTORY_RESET", wait=15)
                print("Board erased and restarted in factory mode. Its AWS IoT certificate "
                      "is still registered; provisioning again replaces it.")
                return

            if status.get("state") == "FACTORY":
                status = first_time_setup(console, thing, args.id)

            # STATUS says what the board is, once out of factory mode. Before it did, every board was
            # an nRF7002 DK.
            board = status.get("board", DEFAULT_BOARD)
            if board != args.board:
                fail(f"the board on {console.port} says it is a {board}, not a {args.board}: pass "
                     f"--board {board}, or put the {args.board}'s firmware on it")

            if args.board != DEFAULT_BOARD:
                provision_bluetooth_only(console, status, args)
                print(f"Done: {thing} is provisioned as a {args.board}.")
                return

            has_network = status.get("wifi password") == "set"
            if args.wifi or (not has_network and not args.no_wifi):
                provision_wifi(console)
                has_network = True
                if args.wifi:
                    return

            needs_identity = (args.new_identity or status.get("private key") != "set"
                              or status.get("certificate") != "set")
            if choose_way(args) == "console":
                api = console_api("registering the board", "register it with --via aws")
                if not needs_identity and status.get("endpoint", "unset") == "unset":
                    fail("the board has its certificate and no cloud settings, which the console gives only with "
                         "a new certificate: run this again with --new-identity")
                if needs_identity:
                    replace = status.get("private key") == "set"
                    # Checked before the board makes a key, so that a refusal changes nothing on it.
                    board_id(thing)
                    csr = request_from_board(console, replace)
                    given = register_through_console(api, thing, csr, reregister=args.new_identity)
                    load_certificate(console, given["certificate"], "CERT")
                    print("Device certificate stored on the board")
                    load_certificate(console, root_ca_der(), "CA")
                    print("Amazon Root CA 1 stored on the board")
                    console.run(f"CLOUD|{given['endpoint']}|{given['prefix']}", wait=5)
                    print("Cloud settings stored on the board")
                elif status.get("root CA") != "set":
                    load_certificate(console, root_ca_der(), "CA")
                    print("Amazon Root CA 1 stored on the board")
            else:
                outputs = load_outputs()
                aws = Aws(args.profile, outputs["Region"])

                if needs_identity:
                    # A key without its certificate cannot be reused: the request is only
                    # printed when the key is created.
                    replace = status.get("private key") == "set"
                    csr = request_from_board(console, replace)
                    certificate = register_in_aws(aws, outputs, thing, csr)
                    load_certificate(console, certificate, "CERT")
                    print("Device certificate stored on the board")

                if needs_identity or status.get("root CA") != "set":
                    load_certificate(console, root_ca_der(), "CA")
                    print("Amazon Root CA 1 stored on the board")

                endpoint = aws.call("iot", "describe-endpoint", "--endpoint-type",
                                    "iot:Data-ATS")["endpointAddress"]
                console.run(f"CLOUD|{endpoint}|{outputs['FirmwareDownloadPrefix']}", wait=5)
                print("Cloud settings stored on the board")

            if not has_network:
                print("The board is registered and has its certificate. It connects once it "
                      "has a network:\n  python tools/secrets.py wifi\n"
                      "  python tools/provision_device.py --wifi")
                return

            print("Waiting for the board to connect ...")
            deadline = time.time() + args.connect_timeout
            while time.time() < deadline:
                try:
                    status = console.status()
                except BoardError:
                    # It is busy for a moment. The deadline is what counts.
                    time.sleep(5)
                    continue
                if status.get("cloud") == "connected":
                    break
                time.sleep(5)
            show(status)
            if status.get("cloud") != "connected":
                fail("the board is provisioned but has not connected yet; check the Wi-Fi "
                     "network and watch the console")
            print("Done: the board is connected to AWS IoT.")
    except ShellFirmware:
        fail("this board runs firmware from before the console. Update it first with "
             "scripts/firmware/ota.sh or tools/recover.py")
    except BoardError as error:
        fail(str(error))


if __name__ == "__main__":
    main()

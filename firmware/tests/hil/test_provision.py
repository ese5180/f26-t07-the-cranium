#!/usr/bin/env python3
"""Tests of tools/provision_device.py: a board with Bluetooth only (--board nrf5340dk), and registering a
board through the console with a console token, in place of the AWS CLI (--via console).

With no board, no AWS and no console: a fake serial port answers as the firmware's console does,
and fakes of the AWS CLI and of the console's API record what they are asked. They show the order
(the console gets the passkey before the board does), what the board is sent and never sent, that
the passkey is drawn at random and never printed, what the console is sent when it registers a board
(the board's request, never a key), and what happens when a step fails.

    python3 firmware/tests/hil/test_provision.py
"""

import base64
import contextlib
import hashlib
import io
import json
import re
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import provision_device  # noqa: E402
from board import Console  # noqa: E402

THING = "cranium-fe5b26c0c5b1dcd7"


CSR = "-----BEGIN CERTIFICATE REQUEST-----\nMIIBAzCBqgIBADAj\n-----END CERTIFICATE REQUEST-----"
ROOT_CA = (REPO / "firmware/certs/AmazonRootCA1.pem").read_text()
CERTIFICATE = "-----BEGIN CERTIFICATE-----\n" + base64.b64encode(b"\x30\x82" + b"\x11" * 300).decode() + \
    "\n-----END CERTIFICATE-----\n"
ENDPOINT = "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"
PREFIX = "https://cranium-firmware-0123.s3.us-east-1.amazonaws.com/firmware/"


def status_reply(board="nrf5340dk", passkey="unset", name="a new one for each window", state="OPERATING",
                 identity=None):
    lines = [("state", state), ("id", "CRVIHAAN01"), ("thing name", THING), ("firmware", "1.12.0+0"),
             ("board", board), ("stuck count", "0")]
    if board == "nrf5340dk":
        lines += [("bt passkey", passkey), ("bt failures", "0 of 3"), ("bt name", name),
                  ("bt window", "closed")]
    else:
        identity = identity or {}
        lines += [("wifi password", "set"), ("root CA", identity.get("root CA", "unset")),
                  ("private key", identity.get("private key", "unset")),
                  ("certificate", identity.get("certificate", "unset")),
                  ("endpoint", identity.get("endpoint", "unset")), ("cloud", "connected")]
    lines.append(("update", "idle (last: none)"))
    return "".join(f"{key:<14} {value}\r\n" for key, value in lines) + "OK\r\n"


class FakeBoard:
    """The serial port of a board running the console, as test_board.py's, with BT_PASSKEY."""

    def __init__(self, board="nrf5340dk", passkey="unset", refuse=None, identity=None):
        self.board = board
        self.passkey = passkey
        self.refuse = refuse
        self.identity = dict(identity or {})
        self.streams = []
        self.lines = []
        self.incoming = b""
        self.outgoing = b""
        self.stored = None

    def write(self, data):
        self.incoming += data
        while b"\r" in self.incoming:
            line, self.incoming = self.incoming.split(b"\r", 1)
            self.answer(line.decode())

    def answer(self, line):
        if not line:
            return
        self.lines.append(line)
        if line == "ECHO|OFF":
            reply = "OK echo off\r\n"
        elif line == "STATUS":
            reply = status_reply(self.board, self.passkey, identity=self.identity)
        elif line in ("KEYGEN", "KEYGEN|REPLACE"):
            self.identity["private key"] = "set"
            reply = CSR.replace("\n", "\r\n") + "\r\nOK key pair made\r\n"
        elif line.startswith("STREAM_START|"):
            self.streams.append(line.split("|")[-1])
            reply = "OK ready\r\n"
        elif line.startswith("STREAM_CHUNK|"):
            reply = "OK chunk\r\n"
        elif line.startswith("CLOUD|"):
            self.identity["endpoint"] = line.split("|")[1]
            reply = "OK cloud settings stored\r\n"
        elif line.startswith("BT_PASSKEY|"):
            found = re.fullmatch(r"BT_PASSKEY\|(\d{6})\|([0-9A-F]{4})", line)
            if self.refuse is not None:
                reply = f"ERR {self.refuse}\r\n"
            elif found is None:
                reply = "ERR usage: BT_PASSKEY|<6 digits>|<4 hex digits> or BT_PASSKEY|CLEAR\r\n"
            else:
                self.stored = (found[1], found[2])
                self.passkey = "set"
                reply = f"OK passkey stored, advertising as Cranium-{found[2]}\r\n"
        else:
            reply = f"ERR unknown command {line.split('|')[0]}, type HELP\r\n"
        self.outgoing += reply.encode()

    def read(self, size):
        data, self.outgoing = self.outgoing[:size], self.outgoing[size:]
        if not data:
            time.sleep(0.002)
        return data

    def close(self):
        pass


class FakeAws:
    def __init__(self, exists=False):
        self.calls = []
        self.exists = exists

    def call(self, *args, allow=()):
        self.calls.append(args)
        if args[:2] == ("iot", "create-thing") and self.exists and "ResourceAlreadyExistsException" in allow:
            return {}
        if args[:2] == ("iot", "create-certificate-from-csr"):
            return {"certificateArn": "arn:aws:iot:us-east-1:000000000000:cert/" + "a" * 64,
                    "certificatePem": CERTIFICATE}
        if args[:2] == ("iot", "list-thing-principals"):
            return {"principals": []}
        if args[:2] == ("iot", "describe-endpoint"):
            return {"endpointAddress": ENDPOINT}
        return {"thingName": THING}


class FakeApi:
    def __init__(self, put=204, delete=204, order=None, post=None):
        self.calls = []
        self.put = put
        self.delete = delete
        self.order = order if order is not None else []
        # What POST /devices/register answers: (status, body).
        self.post = post or (200, {"thing": THING, "certificatePem": CERTIFICATE, "rootCa": ROOT_CA,
                                   "endpoint": ENDPOINT, "downloadPrefix": PREFIX})

    def send(self, method, path, body=None):
        self.calls.append((method, path, body))
        self.order.append(f"console {method}")
        if method == "POST":
            return self.post
        return (self.put if method == "PUT" else self.delete), None

    def call(self, method, path, body=None):
        return self.send(method, path, body)[0]


OUTPUTS = {"Region": "us-east-1", "DeviceGroupName": "cranium-devices", "DevicePolicyName": "cranium-device",
           "FirmwareDownloadPrefix": "https://bucket.s3.us-east-1.amazonaws.com/firmware/"}


class ProvisionRun:
    """provision_device.main() against the fakes. Returns what was printed and the exit code."""

    def __init__(self, fake, *argv, api=None, aws=None, signed_in=True, token=True):
        self.fake = fake
        self.api = api if api is not None else FakeApi()
        self.aws = aws if aws is not None else FakeAws()
        self.out = io.StringIO()
        self.code = None
        order = self.api.order
        original_answer = fake.answer

        def answer(line):
            if line.startswith("BT_PASSKEY"):
                order.append("board BT_PASSKEY")
            original_answer(line)

        fake.answer = answer
        with mock.patch.object(sys, "argv", ["provision_device.py", *argv]), \
                mock.patch.object(provision_device, "Console", lambda port: Console("/dev/fake", fake)), \
                mock.patch.object(provision_device, "Aws", lambda profile, region: self.aws), \
                mock.patch.object(provision_device, "load_outputs", lambda: OUTPUTS), \
                mock.patch.object(provision_device, "console_api", lambda *_: self.api), \
                mock.patch.object(provision_device, "aws_signed_in", lambda profile: signed_in), \
                mock.patch.object(provision_device, "has_token", lambda: token), \
                contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.out):
            try:
                provision_device.main()
                self.code = 0
            except SystemExit as stop:
                self.code = stop.code if isinstance(stop.code, int) else 1
                print(stop.code)

    @property
    def text(self):
        return self.out.getvalue()


class PasskeyTest(unittest.TestCase):
    def test_a_pattern_is_weak_as_the_board_has_it(self):
        weak = [key for key in range(1_000_000) if provision_device.weak_passkey(key)]
        self.assertEqual(len(weak), 20)
        for key in (0, 111111, 999999, 123456, 12345, 456789, 987654, 543210):
            self.assertTrue(provision_device.weak_passkey(key), key)
        for key in (123457, 284913, 1, 999998):
            self.assertFalse(provision_device.weak_passkey(key), key)

    def test_it_is_drawn_from_the_system_and_never_a_pattern(self):
        with mock.patch.object(provision_device.SYSTEM_RANDOM, "randrange",
                               side_effect=[123456, 111111, 284913]) as draw:
            self.assertEqual(provision_device.draw_passkey(), 284913)
        draw.assert_called_with(1_000_000)
        # The operating system's source.
        self.assertIsInstance(provision_device.SYSTEM_RANDOM, provision_device.random.SystemRandom)
        for _ in range(200):
            key = provision_device.draw_passkey()
            self.assertTrue(0 <= key <= 999999)
            self.assertFalse(provision_device.weak_passkey(key))
        with mock.patch.object(provision_device.SYSTEM_RANDOM, "randrange", return_value=0x3f9c) as draw:
            self.assertEqual(provision_device.draw_tag(), 0x3f9c)
        draw.assert_called_with(0x10000)


class BluetoothOnlyTest(unittest.TestCase):
    def test_a_new_board_gets_a_thing_and_a_passkey_the_console_has_first(self):
        fake = FakeBoard()
        with mock.patch.object(provision_device, "draw_passkey", return_value=284913), \
                mock.patch.object(provision_device, "draw_tag", return_value=0x3f9c):
            run = ProvisionRun(fake, "--board", "nrf5340dk")
        self.assertEqual(run.code, 0, run.text)

        # The console first, then the board, with the same passkey and name.
        self.assertEqual(run.api.order, ["console PUT", "board BT_PASSKEY"])
        method, path, body = run.api.calls[0]
        self.assertEqual(path, f"/devices/{THING}/bluetooth-pairing")
        self.assertEqual(body, {"board": "nrf5340dk", "name": "Cranium-3F9C", "passkey": "284913"})
        self.assertEqual(fake.stored, ("284913", "3F9C"))

        # A thing of its type in the group, and no certificate: it never connects.
        create = [c for c in run.aws.calls if c[:2] == ("iot", "create-thing")][0]
        self.assertEqual(json.loads(create[create.index("--attribute-payload") + 1]),
                         {"attributes": {"board": "nrf5340dk"}, "merge": True})
        self.assertIn(("iot", "add-thing-to-thing-group"), [c[:2] for c in run.aws.calls])
        self.assertNotIn("create-certificate-from-csr", [c[1] for c in run.aws.calls])

        # Nothing of Wi-Fi or the cloud goes to the board, and the passkey is never printed.
        sent = " ".join(fake.lines)
        for word in ("WIFI", "KEYGEN", "CLOUD", "STREAM", "MQTT"):
            self.assertNotIn(word, sent)
        self.assertNotIn("284913", run.text)
        self.assertIn("Cranium-3F9C", run.text)

    def test_an_existing_thing_gets_its_type(self):
        run = ProvisionRun(FakeBoard(), "--board", "nrf5340dk", aws=FakeAws(exists=True))
        self.assertEqual(run.code, 0, run.text)
        self.assertIn(("iot", "update-thing"), [c[:2] for c in run.aws.calls])

    def test_a_console_without_the_route_stops_it_before_the_board(self):
        fake = FakeBoard()
        run = ProvisionRun(fake, "--board", "nrf5340dk", api=FakeApi(put=404))
        self.assertNotEqual(run.code, 0)
        self.assertIn("does not take a board's passkey yet", run.text)
        self.assertIn("--no-register", run.text)
        self.assertIsNone(fake.stored)
        self.assertNotIn("board BT_PASSKEY", run.api.order)

        run = ProvisionRun(FakeBoard(), "--board", "nrf5340dk", api=FakeApi(put=403))
        self.assertNotEqual(run.code, 0)
        self.assertIn("refused", run.text)

    def test_a_board_that_does_not_store_it_is_taken_out_of_the_console_again(self):
        fake = FakeBoard(refuse="Bluetooth is open: close it with Button 2 first")
        run = ProvisionRun(fake, "--board", "nrf5340dk")
        self.assertNotEqual(run.code, 0)
        self.assertEqual([c[0] for c in run.api.calls], ["PUT", "DELETE"])
        self.assertIn("Bluetooth is open", run.text)

    def test_a_board_with_one_keeps_it_unless_asked(self):
        fake = FakeBoard(passkey="set")
        run = ProvisionRun(fake, "--board", "nrf5340dk")
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(run.api.calls, [])
        self.assertIsNone(fake.stored)
        self.assertIn("--new-passkey", run.text)

        fake = FakeBoard(passkey="set")
        run = ProvisionRun(fake, "--board", "nrf5340dk", "--new-passkey")
        self.assertEqual(run.code, 0, run.text)
        self.assertIsNotNone(fake.stored)
        self.assertEqual(run.api.order, ["console PUT", "board BT_PASSKEY"])

        # A locked one is no passkey: it gets a new one.
        fake = FakeBoard(passkey="locked")
        run = ProvisionRun(fake, "--board", "nrf5340dk")
        self.assertIsNotNone(fake.stored)

    def test_no_register_gives_it_none(self):
        fake = FakeBoard()
        run = ProvisionRun(fake, "--board", "nrf5340dk", "--no-register")
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(run.api.calls, [])
        self.assertIsNone(fake.stored)
        self.assertIn("a new one on its serial console", run.text)

    def test_the_board_must_be_what_it_is_said_to_be(self):
        run = ProvisionRun(FakeBoard(board="nrf5340dk"))
        self.assertNotEqual(run.code, 0)
        self.assertIn("says it is a nrf5340dk, not a nrf7002dk", run.text)

        run = ProvisionRun(FakeBoard(board="nrf7002dk"), "--board", "nrf5340dk")
        self.assertNotEqual(run.code, 0)
        self.assertIn("says it is a nrf7002dk", run.text)

    def test_what_is_not_for_this_board_is_refused_at_once(self):
        for argv, words in ((["--board", "nrf5340dk", "--wifi"], "no Wi-Fi"),
                            (["--board", "nrf5340dk", "--new-identity"], "no Wi-Fi"),
                            (["--new-passkey"], "Bluetooth only"),
                            (["--board", "nrf5340dk", "--new-passkey", "--no-register"], "pick one")):
            fake = FakeBoard()
            run = ProvisionRun(fake, *argv)
            self.assertNotEqual(run.code, 0)
            self.assertIn(words, run.text)
            self.assertEqual(fake.lines, [])


class ThroughTheConsoleTest(unittest.TestCase):
    """--via console, and auto with a console token and no AWS sign-in: no AWS CLI, no outputs.json."""

    def test_a_new_board_is_registered_through_the_console_with_its_own_request(self):
        fake = FakeBoard(board="nrf7002dk")
        aws = FakeAws()
        with mock.patch.object(provision_device, "load_outputs", side_effect=AssertionError("outputs.json")):
            run = ProvisionRun(fake, aws=aws, signed_in=False)
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(aws.calls, [])
        [(method, path, body)] = run.api.calls
        self.assertEqual((method, path), ("POST", "/devices/register"))
        self.assertEqual(body, {"id": THING.removeprefix("cranium-"), "csr": CSR + "\n", "reregister": False})
        self.assertNotIn("PRIVATE", json.dumps(body))
        # The certificate, the root CA, then the endpoint and the download address the console gave.
        self.assertEqual(fake.streams, ["CERT", "CA"])
        self.assertIn(f"CLOUD|{ENDPOINT}|{PREFIX}", fake.lines)
        self.assertIn("through the console", run.text)

    def test_new_identity_asks_the_console_to_register_it_again(self):
        fake = FakeBoard(board="nrf7002dk", identity={"private key": "set", "certificate": "set",
                                                      "root CA": "set", "endpoint": ENDPOINT})
        run = ProvisionRun(fake, "--via", "console", "--new-identity")
        self.assertEqual(run.code, 0, run.text)
        self.assertIn("KEYGEN|REPLACE", fake.lines)
        self.assertTrue(run.api.calls[0][2]["reregister"])

    def test_a_board_registered_before_says_how_to_go_on_and_gets_nothing(self):
        fake = FakeBoard(board="nrf7002dk")
        api = FakeApi(post=(409, {"error": {"code": "already_registered", "message": "has a certificate"}}))
        run = ProvisionRun(fake, "--via", "console", api=api)
        self.assertNotEqual(run.code, 0)
        self.assertIn("--new-identity", run.text)
        self.assertEqual(fake.streams, [])
        self.assertFalse(any(line.startswith("CLOUD") for line in fake.lines))

    def test_what_the_console_answers_is_checked_before_the_board_gets_it(self):
        for answer, words in (({"certificatePem": CERTIFICATE, "rootCa": CERTIFICATE}, "not Amazon Root CA 1"),
                              ({"endpoint": "evil.example.com"}, "no AWS IoT endpoint"),
                              ({"downloadPrefix": "https://example.com/"}, "no download address"),
                              ({"thing": "cranium-0000000000000000"}, "another board")):
            body = {"thing": THING, "certificatePem": CERTIFICATE, "rootCa": ROOT_CA, "endpoint": ENDPOINT,
                    "downloadPrefix": PREFIX, **answer}
            fake = FakeBoard(board="nrf7002dk")
            run = ProvisionRun(fake, "--via", "console", api=FakeApi(post=(200, body)))
            self.assertNotEqual(run.code, 0, words)
            self.assertIn(words, run.text)
            self.assertEqual(fake.streams, [], words)

    def test_refusals_say_why(self):
        for status, words in ((403, "release manager"), (404, "--via aws"), (0, "could not be reached"),
                              (429, "too many")):
            run = ProvisionRun(FakeBoard(board="nrf7002dk"), "--via", "console",
                               api=FakeApi(post=(status, None)))
            self.assertNotEqual(run.code, 0)
            self.assertIn(words, run.text)

    def test_auto_takes_aws_when_signed_in_and_says_what_is_missing_with_neither(self):
        fake = FakeBoard(board="nrf7002dk")
        run = ProvisionRun(fake, signed_in=True)
        self.assertEqual(run.code, 0, run.text)
        self.assertIn(("iot", "create-certificate-from-csr"), [c[:2] for c in run.aws.calls])
        self.assertEqual(run.api.calls, [])

        fake = FakeBoard(board="nrf7002dk")
        run = ProvisionRun(fake, signed_in=False, token=False)
        self.assertNotEqual(run.code, 0)
        self.assertIn("no console token and is not signed in to AWS", run.text)
        self.assertNotIn("KEYGEN", " ".join(fake.lines))

    def test_an_nrf5340dk_is_registered_through_the_console_too(self):
        fake = FakeBoard()
        run = ProvisionRun(fake, "--board", "nrf5340dk", "--via", "console", "--no-register")
        self.assertEqual(run.code, 0, run.text)
        self.assertEqual(run.aws.calls, [])
        self.assertEqual(run.api.calls[0], ("POST", "/devices/register",
                                            {"id": THING.removeprefix("cranium-"), "board": "nrf5340dk"}))


class ConsoleApiTest(unittest.TestCase):
    def test_it_asks_the_token_route_with_the_token_and_says_nothing(self):
        seen = {}

        class Answer:
            status = 204

            def read(self):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        def urlopen(request, timeout):
            seen["url"] = request.full_url
            seen["method"] = request.get_method()
            seen["auth"] = request.get_header("Authorization")
            seen["body"] = json.loads(request.data)
            return Answer()

        api = provision_device.ConsoleApi("https://console.example.org/", "secret-token")
        out = io.StringIO()
        with mock.patch.object(provision_device.urllib.request, "urlopen", urlopen), contextlib.redirect_stdout(out):
            self.assertEqual(api.call("PUT", provision_device.pairing_path(THING), {"passkey": "284913"}), 204)
        self.assertEqual(seen["url"], f"https://console.example.org/api/t/devices/{THING}/bluetooth-pairing")
        self.assertEqual(seen["method"], "PUT")
        self.assertEqual(seen["auth"], "Bearer secret-token")
        self.assertEqual(seen["body"], {"passkey": "284913"})
        self.assertEqual(out.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

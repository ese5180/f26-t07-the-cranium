/**
 * Tests for Board setup (setup.js) and the serial recovery it speaks (recovery.js): the very files the
 * browser loads. The board is a stand-in for a port as navigator.serial hands it out, with a model of
 * the firmware's console and of MCUboot's serial recovery behind it, and the console's API is a fake,
 * the register route's included. Nothing here touches a real port.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CORE, RECOVERY, SETUP, VIEWS, all, click, createDocument, one, textOf } from './page.mjs';

const recovery = await import(RECOVERY);
const setup = await import(SETUP);
const views = await import(VIEWS);
const core = await import(CORE);

globalThis.document = createDocument();

const REPO = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const GOLDEN_BYTES = new Uint8Array(read('binaries/golden/cranium-1.5.0-0.signed.bin'));
const ROOT_CA_PEM = read('firmware/certs/AmazonRootCA1.pem').toString('utf8');

const SSID = 'Lab’s hotspot';
const PASSPHRASE = 'correct-horse-battery-9';
const THING = 'cranium-fe5b26c0c5b1dcd7';
const ENDPOINT = 'example-ats.iot.us-east-1.example.test';
const PREFIX = 'https://firmware.example.test/releases/';

// Short waits: the fake board answers at once.
const FAST = Object.freeze({
  handshake: 150,
  listening: 300,
  restart: 1500,
  swap: 1500,
  comeBack: 3000,
  status: 1000,
  init: 1000,
  wifi: 1000,
  keygen: 1000,
  chunk: 1000,
  store: 1000,
  poll: 20,
  online: 400,
  seal: 1500,
});

async function until(condition, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Images.

/** A signed-looking MCUboot image: header, body, and a TLV area with the SHA-256 of both. */
function makeImage(version, bodySize = 3000) {
  const [major, minor, revision, build] = version.split(/[.+]/).map(Number);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x96f3b83d, 0);
  header.writeUInt16LE(32, 8);
  header.writeUInt32LE(bodySize, 12);
  header.writeUInt8(major, 20);
  header.writeUInt8(minor, 21);
  header.writeUInt16LE(revision, 22);
  header.writeUInt32LE(build, 24);
  const body = randomBytes(bodySize);
  const digest = createHash('sha256')
    .update(Buffer.concat([header, body]))
    .digest();
  const tlv = Buffer.alloc(4 + 4 + 32);
  tlv.writeUInt16LE(0x6907, 0);
  tlv.writeUInt16LE(tlv.length, 2);
  tlv.writeUInt8(0x10, 4);
  tlv.writeUInt16LE(32, 6);
  digest.copy(tlv, 8);
  return new Uint8Array(Buffer.concat([header, body, tlv]));
}

// The board.

const TEXT = new TextEncoder();

/**
 * A board on its console port. `mode` is what listens: 'app' (the firmware's console), 'bootloader'
 * (serial recovery), or 'dead' (nothing: a blank chip, or the other port).
 */
function fakeBoard({ mode = 'app', firmware = '1.14.0+0', state = 'FACTORY', enterWorks = true } = {}) {
  let source = null;
  let pending = [];
  const requests = recovery.createSmpReader();
  const board = {
    mode,
    firmware,
    state,
    id: '',
    enterWorks,
    echo: true,
    text: [],
    smp: [],
    wifi: null,
    key: false,
    stream: null,
    loaded: {},
    cloud: null,
    slot: null,
    port: null,
    closed: false,
  };
  const say = (text) => source.enqueue(TEXT.encode(text));
  const sayLines = (lines) => say(lines.map((line) => `${line}\r\n`).join(''));

  function status() {
    const row = (key, value) => `${key.padEnd(14)} ${value}`;
    return [
      row('state', board.state),
      row('id', board.id),
      row('thing name', THING),
      row('firmware', board.firmware),
      row('stuck count', 0),
      row('wifi network', board.wifi ? board.wifi.ssid : 'unset'),
      row('wifi password', board.wifi ? 'set' : 'unset'),
      row('wifi link', board.wifi ? 'up' : 'down'),
      row('endpoint', board.cloud ? board.cloud.endpoint : 'unset'),
      row('cloud', board.cloud ? 'connected' : 'not connected'),
      row('root CA', board.loaded.CA ? 'set' : 'unset'),
      row('private key', board.key ? 'set' : 'unset'),
      row('certificate', board.loaded.CERT ? 'set' : 'unset'),
    ];
  }

  function restart(into = 'app') {
    board.mode = 'restarting';
    setTimeout(() => {
      board.mode = into;
      board.echo = true;
      if (into === 'app') sayLines(['[BOOT] started']);
    }, 5);
  }

  function console(line) {
    board.text.push(line);
    if (board.echo) sayLines([line]);
    const [name, ...args] = line.split('|');
    const reply = (...lines) => sayLines(lines);
    switch (name) {
      case 'ECHO':
        board.echo = args[0] !== 'OFF';
        return reply(`OK echo ${args[0].toLowerCase()}`);
      case 'GET_ID':
        return reply(`OK ${board.id}|${board.firmware}`);
      case 'THING':
        return reply(`OK ${THING}`);
      case 'STATUS':
        if (board.state === 'FACTORY') return reply('ERR factory mode: run INIT|<id> first');
        return reply(...status(), 'OK');
      case 'ENTER_BOOTLOADER':
        reply('OK rebooting, the bootloader listens for half a second: use tools/recover.py --console');
        return restart(board.enterWorks ? 'bootloader' : 'app');
      case 'INIT':
        board.id = args[0];
        board.state = 'OPERATING';
        reply(`OK initialized as ${args[0]}, restarting`);
        return restart();
      case 'WIFI_SEC':
        board.wifi = { ssid: args[0], security: args[1], passphrase: args[2] };
        return reply(`OK saved, connecting to ${args[0]}`);
      case 'KEYGEN':
        board.key = true;
        return reply(
          '-----BEGIN CERTIFICATE REQUEST-----',
          'MIIBHjCBxAIBADBiMQswCQYDVQQGEwJVUzEQMA4GA1UECgwHQ3Jhbml1bTEhMB8G',
          '-----END CERTIFICATE REQUEST-----',
          'OK key created'
        );
      case 'STREAM_START':
        board.stream = { size: Number(args[0]), count: Number(args[1]), crc: args[2], kind: args[3], parts: [] };
        return reply('OK ready');
      case 'STREAM_CHUNK': {
        board.stream.parts.push(Buffer.from(args[1], 'base64'));
        if (board.stream.parts.length === board.stream.count) {
          const whole = new Uint8Array(Buffer.concat(board.stream.parts));
          const crc = recovery.crc16CcittFalse(whole).toString(16).padStart(4, '0');
          if (whole.length !== board.stream.size || crc !== board.stream.crc) return reply('ERR crc mismatch');
          board.loaded[board.stream.kind] = whole;
        }
        return reply('OK chunk');
      }
      case 'CLOUD':
        board.cloud = { endpoint: args[0], prefix: args[1] };
        return reply('OK cloud settings saved');
      default:
        return reply('ERR unknown command');
    }
  }

  function bootloader(request) {
    board.smp.push(request);
    const answer = (body) => {
      const packet = recovery.smpPacket({
        op: request.op + 1,
        group: request.group,
        id: request.id,
        sequence: request.sequence,
        body,
      });
      for (const line of recovery.frameLines(packet)) source.enqueue(line);
    };
    if (request.group === 0 && request.id === 0) return answer({ r: request.body.d });
    if (request.group === 1 && request.id === 1) {
      const { off, data } = request.body;
      if (off === 0) board.slot = new Uint8Array(request.body.len);
      board.slot.set(data, off);
      return answer({ rc: 0, off: off + data.length });
    }
    if (request.group === 0 && request.id === 5) {
      answer({ rc: 0 });
      board.firmware = recovery.parseImage(board.slot).version;
      return restart();
    }
    return answer({ rc: 8 });
  }

  function take(bytes) {
    if (bytes.length === 0) return;
    const smp = bytes[0] === 0x06 || bytes[0] === 0x04;
    if (smp) {
      if (board.mode !== 'bootloader') return;
      const request = requests.feed(new Uint8Array(bytes));
      if (request) bootloader(request);
      return;
    }
    if (board.mode === 'app') console(new TextDecoder().decode(new Uint8Array(bytes)));
  }

  board.port = {
    readable: new ReadableStream({
      start(controller) {
        source = controller;
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        for (const byte of chunk) {
          if (byte === 0x0a || byte === 0x0d) {
            take(pending);
            pending = [];
          } else pending.push(byte);
        }
      },
    }),
    open: async () => {},
    close: async () => {
      board.closed = true;
    },
  };
  return board;
}

/** The board's other port, where the bootloader logs. The test says what it says. */
function fakeLogPort() {
  let source = null;
  const log = {
    opened: false,
    say: (text) => source.enqueue(TEXT.encode(`${text}\r\n`)),
    port: {
      readable: new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
      writable: new WritableStream({ write() {} }),
      open: async () => {
        log.opened = true;
      },
      close: async () => {},
    },
  };
  return log;
}

function fakeSerial(ports) {
  const asked = [];
  return {
    asked,
    requestPort: async (options) => {
      asked.push(options);
      if (ports.length === 0) throw new DOMException('No port selected by the user.', 'NotFoundError');
      return ports.shift();
    },
  };
}

// The console's API.

function fakeApi({ releaseImage, golden = GOLDEN_BYTES, register = null } = {}) {
  const calls = [];
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${randomBytes(600).toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`;
  const api = {
    calls,
    certificatePem,
    firmware: async () => ({
      releases: [
        {
          version: '1.14.5+0',
          status: 'active',
          sha256: sha256(releaseImage),
          size: releaseImage.length,
          board: 'nrf7002dk',
          layout: 1,
        },
        { version: '1.14.9+0', status: 'revoked', sha256: 'a'.repeat(64), size: 10, board: 'nrf7002dk', layout: 1 },
        { version: '1.20.0+0', status: 'active', sha256: 'b'.repeat(64), size: 10, board: 'nrf5340dk', layout: 1 },
        { version: '1.11.0+0', status: 'active', sha256: 'c'.repeat(64), size: 10 },
      ],
    }),
    image: async (version) => {
      calls.push(['image', version]);
      return releaseImage.slice();
    },
    golden: async (file) => {
      calls.push(['golden', file]);
      return golden.slice();
    },
    registerDevice: async (body) => {
      calls.push(['register', body]);
      if (register) return register(body);
      return { thing: THING, certificatePem, rootCa: ROOT_CA_PEM, endpoint: ENDPOINT, downloadPrefix: PREFIX };
    },
    device: async (thing) => {
      calls.push(['device', thing]);
      return { device: { thing, online: true } };
    },
  };
  return api;
}

function makeFlow({
  board = fakeBoard(),
  log = fakeLogPort(),
  api = fakeApi({ releaseImage: makeImage('1.14.5+0') }),
} = {}) {
  const serial = fakeSerial([board.port, log.port]);
  const box = document.createElement('div');
  document.body.appendChild(box);
  const ctx = { state: { me: { canWrite: true } }, actions: {} };
  let flow = null;
  const draw = () => views.render(box, setup.setupView(ctx, flow));
  flow = setup.createSetupFlow({ serial, api, subtle: globalThis.crypto.subtle, onChange: draw, timing: FAST });
  draw();
  return { flow, board, log, api, serial, box, draw };
}

// SMP: the framing, against tools/recover.py.

// What recover.py's Link.send writes for three requests (made by the script below, with cbor2).
const RECOVER_PY = {
  echo: '0609414255434141414c41414142414b46685a47646a636d46756158567451776b3d0a',
  reset: '06094141734341414142414141444261435169413d3d0a',
  // The first upload request (384 bytes 0, 1, 2 ...), as the SHA-256 of its hex.
  uploadSha256: '66707f55f0b8965064423e8ccf8896835b548360f35a2dd84d59499d041b473d',
};
const PY_SCRIPT = `
import sys, types, json
sys.path.insert(0, sys.argv[1])
class FakeSerial:
    def __init__(self, *a, **k): self.out = b""
    def write(self, b): self.out += b
    def close(self): pass
fake = types.ModuleType("serial"); fake.Serial = FakeSerial
tools = types.ModuleType("serial.tools"); lp = types.ModuleType("serial.tools.list_ports"); lp.comports = lambda: []
fake.tools = tools; tools.list_ports = lp
sys.modules["serial"] = fake; sys.modules["serial.tools"] = tools; sys.modules["serial.tools.list_ports"] = lp
import recover
link = recover.Link("fake")
out = {}
link.send(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_ECHO, {"d": "cranium"})
out["echo"] = link.serial.out.hex(); link.serial.out = b""
data = bytes(i & 0xff for i in range(384))
link.send(recover.OP_WRITE, recover.GROUP_IMAGE, recover.ID_IMAGE_UPLOAD, {"off": 0, "data": data, "image": 0, "len": 759058})
out["upload"] = link.serial.out.hex(); link.serial.out = b""
link.send(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_RESET, {})
out["reset"] = link.serial.out.hex()
print(json.dumps(out))
`;

function ours() {
  const lines = (request) => hex(Buffer.concat(recovery.frameLines(recovery.smpPacket(request))));
  const data = Uint8Array.from({ length: 384 }, (_, index) => index & 0xff);
  return {
    echo: lines({ op: 2, group: 0, id: 0, sequence: 1, body: { d: 'cranium' } }),
    upload: lines({ op: 2, group: 1, id: 1, sequence: 2, body: { off: 0, data, image: 0, len: 759058 } }),
    reset: lines({ op: 2, group: 0, id: 5, sequence: 3, body: {} }),
  };
}

test('SMP requests are framed byte for byte as recover.py frames them', () => {
  const mine = ours();
  assert.equal(mine.echo, RECOVER_PY.echo);
  assert.equal(mine.reset, RECOVER_PY.reset);
  assert.equal(sha256(mine.upload), RECOVER_PY.uploadSha256);
  // The upload's first request takes five lines: 93 bytes each, the first behind 06 09, the rest behind 04 14.
  const lines = recovery.frameLines(
    recovery.smpPacket({
      op: 2,
      group: 1,
      id: 1,
      sequence: 2,
      body: { off: 0, data: new Uint8Array(384), image: 0, len: 759058 },
    })
  );
  assert.equal(lines.length, 5);
  assert.deepEqual([...lines[0].subarray(0, 2)], [0x06, 0x09]);
  for (const line of lines.slice(1)) assert.deepEqual([...line.subarray(0, 2)], [0x04, 0x14]);
  for (const line of lines.slice(0, -1)) assert.equal(line.length, 2 + 124 + 1);
});

test('SMP framing matches tools/recover.py itself, where a Python with cbor2 is at hand', (t) => {
  const python = process.env.CRANIUM_PYTHON || 'python3';
  const run = spawnSync(python, ['-I', '-c', PY_SCRIPT, fileURLToPath(new URL('tools/', REPO))], { encoding: 'utf8' });
  if (run.status !== 0) {
    t.skip('no Python with cbor2: the recorded framing above stands in for it');
    return;
  }
  const theirs = JSON.parse(run.stdout);
  assert.deepEqual(ours(), theirs);
});

test('the constants of serial recovery are recover.py’s', () => {
  const source = read('tools/recover.py').toString('utf8');
  const value = (name) => Number(new RegExp(`^${name} = (\\d+)`, 'm').exec(source)[1]);
  assert.equal(recovery.LINE_BYTES, value('LINE_BYTES'));
  assert.equal(recovery.CHUNK, value('CHUNK'));
  assert.equal(recovery.MAX_LOST, value('MAX_LOST'));
  assert.equal(recovery.REPLY_MS, value('REPLY_TIMEOUT') * 1000);
  assert.equal(recovery.ENTER_AFTER_RESTART_MS, value('ENTER_AFTER_RESTART') * 1000);
  assert.equal(recovery.ENTER_THROUGH_A_SWAP_MS, value('ENTER_THROUGH_A_SWAP') * 1000);
  assert.match(source, /OP_READ, OP_WRITE = 0, 2/);
  assert.match(source, /GROUP_OS, GROUP_IMAGE = 0, 1/);
  assert.match(source, /ID_OS_ECHO, ID_OS_RESET = 0, 5/);
  assert.match(source, /ID_IMAGE_STATE, ID_IMAGE_UPLOAD = 0, 1/);
  assert.match(source, /ENTER_BOOTLOADER = b"\\rENTER_BOOTLOADER\\r"/);
  assert.equal(recovery.ENTER_BOOTLOADER, '\rENTER_BOOTLOADER\r');
});

test('the checksums are the ones each side uses', () => {
  const check = TEXT.encode('123456789');
  assert.equal(recovery.crc16Xmodem(check), 0x31c3);
  assert.equal(recovery.crc16CcittFalse(check), 0x29b1);
});

test('a reply is put back together from its lines, and a damaged one is dropped', () => {
  const body = {
    images: [{ slot: 0, version: '1.5.0', hash: new Uint8Array(32).fill(7) }],
    rc: 0,
    note: 'x'.repeat(300),
  };
  const lines = recovery.frameLines(recovery.smpPacket({ op: 1, group: 1, id: 0, sequence: 9, body }));
  assert.ok(lines.length > 2);
  const reader = recovery.createSmpReader();
  let reply = null;
  for (const line of lines) reply = reader.feed(line.subarray(0, -1)) ?? reply;
  assert.equal(reply.sequence, 9);
  assert.equal(reply.body.images[0].version, '1.5.0');
  assert.deepEqual([...reply.body.images[0].hash], new Array(32).fill(7));

  const damaged = lines.map((line) => line.slice(0, -1));
  damaged[1][10] = damaged[1][10] === 0x41 ? 0x42 : 0x41;
  const again = recovery.createSmpReader();
  assert.equal(damaged.map((line) => again.feed(line)).filter(Boolean).length, 0);
});

// The golden image and the other constants.

test('the page’s golden image is firmware/golden.json’s, and the web function serves the same file', () => {
  const manifest = JSON.parse(read('firmware/golden.json'));
  assert.deepEqual(
    { ...setup.GOLDEN },
    {
      version: manifest.version,
      file: manifest.file,
      sha256: manifest.file_sha256,
      hashTlv: manifest.hash_tlv,
      size: manifest.size,
    }
  );
  assert.equal(sha256(GOLDEN_BYTES), manifest.file_sha256);
  const served = read(`cloud/web/src/golden/${manifest.file}`);
  assert.equal(sha256(served), manifest.file_sha256);
  const parsed = recovery.parseImage(GOLDEN_BYTES);
  assert.equal(parsed.version, manifest.version);
  assert.equal(parsed.hashTlv, manifest.hash_tlv);
  assert.equal(parsed.keyHashTlv, manifest.key_hash_tlv);
  assert.equal(sha256(parsed.covered), manifest.hash_tlv);
  assert.equal(parsed.board, 'nrf7002dk');
});

test('the root CA the page accepts is provision_device.py’s Amazon Root CA 1', () => {
  const tool = read('tools/provision_device.py').toString('utf8');
  assert.equal(setup.ROOT_CA_SHA256, /ROOT_CA_SHA256 = "([0-9a-f]{64})"/.exec(tool)[1]);
  const der = Buffer.from(ROOT_CA_PEM.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  assert.equal(sha256(der), setup.ROOT_CA_SHA256);
});

test('a release image of the repository reads as one, with its board type', () => {
  const parsed = recovery.parseImage(new Uint8Array(read('binaries/cranium-1.14.5-0.signed.bin')));
  assert.equal(parsed.version, '1.14.5+0');
  assert.equal(parsed.board, 'nrf7002dk');
  assert.equal(parsed.layout, 1);
  assert.equal(sha256(parsed.covered), parsed.hashTlv);
  assert.throws(() => recovery.parseImage(new Uint8Array(64)), /not a firmware image/);
});

test('the newest release is the newest active one for the board’s type and layout', () => {
  const releases = [
    { version: '1.14.5+0', status: 'active', sha256: 'a'.repeat(64) },
    { version: '1.14.10+0', status: 'active', sha256: 'b'.repeat(64), board: 'nrf7002dk', layout: 1 },
    { version: '1.15.0+0', status: 'revoked', sha256: 'c'.repeat(64) },
    { version: '1.16.0+0', status: 'active', sha256: 'd'.repeat(64), board: 'nrf5340dk' },
    { version: '1.17.0+0', status: 'active', sha256: 'e'.repeat(64), layout: 2 },
  ];
  assert.equal(setup.newestRelease(releases, 'nrf7002dk').version, '1.14.10+0');
  assert.equal(setup.newestRelease(releases, 'nrf5340dk').version, '1.16.0+0');
  assert.equal(setup.newestRelease(releases, 'nrf7002dk', 2).version, '1.17.0+0');
  assert.equal(setup.newestRelease([], 'nrf7002dk'), null);
});

test('the register route’s answer is checked before anything goes to the board', () => {
  const good = {
    thing: THING,
    certificatePem: fakeApi({ releaseImage: makeImage('1.0.0+0') }).certificatePem,
    rootCa: ROOT_CA_PEM,
    endpoint: ENDPOINT,
    downloadPrefix: PREFIX,
  };
  assert.equal(setup.checkRegistration(good, THING), good);
  assert.throws(() => setup.checkRegistration({ ...good, thing: 'cranium-other' }, THING), /registered cranium-other/);
  assert.throws(() => setup.checkRegistration({ ...good, certificatePem: 'nope' }, THING), /no certificate/);
  assert.throws(() => setup.checkRegistration({ ...good, endpoint: 'a|b' }, THING), /no AWS IoT endpoint/);
  assert.throws(
    () => setup.checkRegistration({ ...good, downloadPrefix: 'http://x.test/' }, THING),
    /no download address/
  );
  assert.throws(() => setup.checkRegistration(null, THING), /no board/);
});

test('the seal’s result is read from the bootloader’s words, as watch-seal reads them', () => {
  assert.equal(setup.sealResult('[00:00:01.000] <inf> golden: sealed, restarting'), 'sealed');
  assert.equal(setup.sealResult('golden: nothing to do'), 'nothing to do');
  assert.equal(setup.sealResult('golden: refused'), 'refused');
  assert.equal(setup.sealResult('golden: gesture completed'), null);
  const tool = read('tools/new_board.py').toString('utf8');
  assert.match(tool, /"golden: sealed, restarting": "sealed", "golden: nothing to do": "nothing to do"/);
  assert.match(tool, /SEAL_REFUSED = "golden: refused"/);
});

// The stepper, end to end.

test('a factory board goes from connect to online: golden, sealed, newest release, set up, online', async () => {
  const { flow, board, log, api, serial, box } = makeFlow();

  await flow.connect();
  assert.equal(flow.steps.connect.status, 'done', flow.steps.connect.error);
  assert.deepEqual(serial.asked[0], { filters: [{ usbVendorId: 0x1366 }] });
  assert.equal(flow.board.state, 'FACTORY');
  assert.equal(flow.board.firmware, '1.14.0+0');
  assert.equal(flow.board.type, 'nrf7002dk');
  const facts = textOf(one(box, 'section.setup-board'));
  for (const words of ['nRF7002 DK', THING, '1.14.0+0', 'FACTORY', 'This project’s'])
    assert.ok(facts.includes(words), words);
  assert.equal(flow.current, 'golden');

  // The golden image: checked, sent, and the board back on 1.5.0, waiting for the gesture.
  await flow.run('golden');
  assert.equal(flow.steps.golden.status, 'waiting', flow.steps.golden.error);
  assert.deepEqual(api.calls[0], ['golden', 'cranium-1.5.0-0.signed.bin']);
  assert.equal(sha256(board.slot), setup.GOLDEN.sha256);
  assert.equal(board.firmware, '1.5.0+0');
  assert.ok(board.text.includes('ENTER_BOOTLOADER'));
  const gesture = textOf(one(box, 'div.setup-seal'));
  assert.ok(gesture.includes('Press and hold RESET.'));
  assert.ok(gesture.includes('Only on a board flashed with this project’s bootloader'));

  // The seal, on the log port: only the bootloader's golden lines are kept.
  const watching = flow.watchSeal();
  await until(() => log.opened && flow.seal.watching);
  log.say('[00:00:00.100,000] <inf> mcuboot: Starting bootloader');
  log.say('[00:00:05.100,000] <inf> golden: gesture completed');
  log.say('[00:00:50.100,000] <inf> golden: sealed, restarting');
  await watching;
  assert.equal(flow.steps.golden.status, 'done');
  assert.deepEqual(flow.seal.lines, ['golden: gesture completed', 'golden: sealed, restarting']);
  assert.equal(flow.current, 'firmware');

  // The newest release for its type: 1.14.5, not the revoked or the other board's.
  await flow.run('firmware');
  assert.equal(flow.steps.firmware.status, 'done', flow.steps.firmware.error);
  assert.deepEqual(api.calls.at(-1), ['image', '1.14.5+0']);
  assert.equal(board.firmware, '1.14.5+0');
  assert.equal(flow.current, 'setup');

  // Set up, from the form: the ID, the network typed in, and the board's own key.
  document.getElementById('setup-id').value = 'Bench7';
  document.getElementById('setup-ssid').value = SSID;
  document.getElementById('setup-security').value = 'WPA3_SAE';
  const passphraseField = document.getElementById('setup-passphrase');
  passphraseField.value = PASSPHRASE;
  click(one(box, 'button', 'Set it up'));
  assert.equal(passphraseField.value, '', 'the passphrase leaves its field at once');
  await until(() => !flow.busy && flow.steps.setup.status !== 'running');
  assert.equal(flow.steps.setup.status, 'done', flow.steps.setup.error);
  assert.equal(board.id, 'Bench7');
  assert.deepEqual(board.wifi, { ssid: SSID, security: 'WPA3_SAE', passphrase: PASSPHRASE });
  // The echo was turned off right before the line with the passphrase.
  const at = board.text.findIndex((line) => line.startsWith('WIFI_SEC|'));
  assert.equal(board.text[at - 1], 'ECHO|OFF');

  const registered = api.calls.find(([name]) => name === 'register')[1];
  assert.deepEqual(Object.keys(registered).sort(), ['csr', 'id', 'reregister']);
  assert.equal(registered.id, 'fe5b26c0c5b1dcd7');
  assert.equal(registered.reregister, false);
  assert.match(registered.csr, /^-----BEGIN CERTIFICATE REQUEST-----\n[\s\S]+-----END CERTIFICATE REQUEST-----\n$/);
  const pemBody = (pem) => Buffer.from(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  assert.deepEqual(Buffer.from(board.loaded.CERT), pemBody(api.certificatePem));
  assert.deepEqual(Buffer.from(board.loaded.CA), pemBody(ROOT_CA_PEM));
  assert.deepEqual(board.cloud, { endpoint: ENDPOINT, prefix: PREFIX });
  assert.equal(flow.current, 'online');

  await flow.run('online');
  assert.equal(flow.steps.online.status, 'done', flow.steps.online.error);
  assert.deepEqual(api.calls.at(-1), ['device', THING]);
  assert.equal(flow.current, null);

  // The network's name and passphrase went to the board only: not to the API, not into the page's state.
  const kept = JSON.stringify({ ...flow, calls: api.calls });
  assert.equal(kept.includes(PASSPHRASE), false);
  assert.equal(kept.includes('hotspot'), false);
  assert.equal(textOf(box).includes(PASSPHRASE), false);
  for (const input of all(box, 'input')) assert.notEqual(input.value, PASSPHRASE);

  await flow.disconnect();
  assert.equal(board.closed, true);
});

test('a board where nothing answers is said to be blank or the other port, and to need the probe', async () => {
  const { flow, box } = makeFlow({ board: fakeBoard({ mode: 'dead' }) });
  await flow.connect();
  assert.equal(flow.steps.connect.status, 'failed');
  assert.equal(flow.steps.connect.error, setup.WORDS.blank);
  const shown = textOf(box);
  assert.ok(shown.includes('scripts/board/new-board.sh'));
  assert.ok(shown.includes('Try again'));
  assert.equal(
    all(box, 'button').some((el) => textOf(el).startsWith('Skip')),
    false
  );
});

test('a board whose bootloader listens with no firmware goes straight to serial recovery', async () => {
  const board = fakeBoard({ mode: 'bootloader' });
  const { flow } = makeFlow({ board });
  await flow.connect();
  assert.equal(flow.steps.connect.status, 'done', flow.steps.connect.error);
  assert.equal(flow.board.bootloader, 'listening');
  await flow.run('golden');
  assert.equal(flow.steps.golden.status, 'waiting', flow.steps.golden.error);
  assert.equal(board.text.includes('ENTER_BOOTLOADER'), false);
});

test('when the bootloader is missed, the page says which button to hold, and Try again goes on', async () => {
  const board = fakeBoard({ enterWorks: false, state: 'OPERATING', firmware: '1.14.5+0' });
  const { flow, box } = makeFlow({ board });
  await flow.connect();
  await flow.run('golden');
  assert.equal(flow.steps.golden.status, 'failed');
  assert.equal(flow.steps.golden.error, setup.WORDS.enter);
  assert.ok(textOf(box).includes('hold Button 1, press and let go of RESET'));
  assert.equal(board.slot, null);

  // The person held Button 1 through a reset: the bootloader stays.
  board.mode = 'bootloader';
  click(one(box, 'button', 'Try again'));
  await until(() => !flow.busy && flow.steps.golden.status !== 'running');
  assert.equal(flow.steps.golden.status, 'waiting', flow.steps.golden.error);
});

test('an image that is not the frozen golden image never reaches the board', async () => {
  const tampered = GOLDEN_BYTES.slice();
  tampered[1000] ^= 1;
  const board = fakeBoard();
  const { flow } = makeFlow({ board, api: fakeApi({ releaseImage: makeImage('1.14.5+0'), golden: tampered }) });
  await flow.connect();
  await flow.run('golden');
  assert.equal(flow.steps.golden.status, 'failed');
  assert.match(flow.steps.golden.error, /not the frozen golden image/);
  assert.equal(board.smp.length, 0);
  assert.equal(board.text.includes('ENTER_BOOTLOADER'), false);
});

test('a release whose bytes are not its SHA-256 never reaches the board', async () => {
  const board = fakeBoard({ state: 'OPERATING' });
  const api = fakeApi({ releaseImage: makeImage('1.14.5+0') });
  const real = api.image;
  api.image = async (version) => {
    const bytes = await real(version);
    bytes[100] ^= 1;
    return bytes;
  };
  const { flow } = makeFlow({ board, api });
  await flow.connect();
  flow.skip('golden');
  await flow.run('firmware');
  assert.equal(flow.steps.firmware.status, 'failed');
  assert.match(flow.steps.firmware.error, /SHA-256 differs/);
  assert.equal(board.smp.length, 0);
});

test('a refused seal stops the step; a board on the newest release passes Newest firmware by itself', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.5.0+0' });
  const { flow, log } = makeFlow({ board });
  await flow.connect();
  await flow.run('golden');
  const watching = flow.watchSeal();
  await until(() => log.opened);
  log.say('golden: refused');
  await watching;
  assert.equal(flow.steps.golden.status, 'failed');
  assert.match(flow.steps.golden.error, /refused/);
  flow.skip('golden');
  assert.equal(flow.steps.golden.status, 'skipped');
  board.firmware = '1.14.5+0';
  await flow.run('firmware');
  assert.equal(flow.steps.firmware.status, 'done');
  assert.match(flow.steps.firmware.note, /already/);
  assert.equal(board.smp.length > 0, true);
});

test('when the console registers another thing, nothing is loaded onto the board', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  const api = fakeApi({
    releaseImage: makeImage('1.14.5+0'),
    register: () => ({
      thing: 'cranium-0000',
      certificatePem: '',
      rootCa: ROOT_CA_PEM,
      endpoint: ENDPOINT,
      downloadPrefix: PREFIX,
    }),
  });
  const { flow } = makeFlow({ board, api });
  await flow.connect();
  flow.skip('golden');
  flow.skip('firmware');
  await flow.runSetup({ ssid: SSID, passphrase: PASSPHRASE });
  assert.equal(flow.steps.setup.status, 'failed');
  assert.match(flow.steps.setup.error, /Nothing was loaded/);
  assert.equal(
    board.text.some((line) => line.startsWith('STREAM_START')),
    false
  );
  assert.equal(board.cloud, null);
});

test('a refusal from the register route reads in plain words', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  const api = fakeApi({
    releaseImage: makeImage('1.14.5+0'),
    register: () => {
      throw Object.assign(new Error('Forbidden'), { name: 'ApiError', status: 403 });
    },
  });
  const { flow } = makeFlow({ board, api });
  await flow.connect();
  flow.skip('golden');
  flow.skip('firmware');
  await flow.runSetup({ ssid: SSID, passphrase: PASSPHRASE });
  assert.equal(flow.steps.setup.error, 'The console refused: only a release manager may do this.');
});

test('a network that the firmware would refuse is not sent', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  const { flow } = makeFlow({ board });
  await flow.connect();
  flow.skip('golden');
  flow.skip('firmware');
  await flow.runSetup({ ssid: 'a|b', passphrase: PASSPHRASE });
  assert.match(flow.steps.setup.error, /cannot be sent over the console/);
  await flow.runSetup({ ssid: SSID, passphrase: 'short' });
  assert.match(flow.steps.setup.error, /8 to 63 characters/);
  assert.equal(board.wifi, null);
});

test('a board that does not come online says so, with what it says itself', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  const api = fakeApi({ releaseImage: makeImage('1.14.5+0') });
  api.device = async (thing) => ({ device: { thing, online: false } });
  const { flow } = makeFlow({ board, api });
  await flow.connect();
  for (const key of ['golden', 'firmware', 'setup']) flow.skip(key);
  await flow.run('online');
  assert.equal(flow.steps.online.status, 'failed');
  assert.match(flow.steps.online.error, /has not seen it online yet/);
  assert.match(flow.steps.online.error, /its cloud is not connected/);
});

// The page around it.

test('a viewer gets an explanation, and so does a browser without Web Serial', () => {
  const box = document.createElement('div');
  views.render(box, setup.setupView({ state: { me: { canWrite: false } }, actions: {} }));
  assert.ok(textOf(box).includes('Board setup is for release managers.'));
  assert.equal(all(box, 'button').length, 0);

  views.render(box, setup.setupView({ state: { me: { canWrite: true } }, actions: {} }));
  assert.ok(textOf(box).includes('This browser cannot reach a serial port.'));
  assert.ok(textOf(box).includes('iPhones and Safari do not have it.'));
});

test('the page says what needs the probe, and the stepper offers Connect first', () => {
  const { box } = makeFlow();
  const shown = textOf(box);
  assert.ok(shown.includes('A board with nothing on it needs the debug probe once.'));
  assert.ok(shown.includes('The desktop app does not do this either'));
  assert.deepEqual(
    all(box, 'li.setup-step').map((el) => el.getAttribute('class')),
    [
      'setup-step is-todo is-current',
      'setup-step is-todo',
      'setup-step is-todo',
      'setup-step is-todo',
      'setup-step is-todo',
    ]
  );
  assert.ok(one(box, 'button', 'Connect'));
  assert.ok(one(box, 'a', 'Board setup'));
});

// The console's API, as core.js asks it.

function apiAnswering(answers, token = 'TOKEN-1') {
  const calls = [];
  const api = core.createApi({
    auth: { accessToken: () => token },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async () => {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      return answers.shift();
    },
  });
  return { api, calls };
}

test('the register route is asked once, same-origin, with the token, the ID, the request and nothing else', async () => {
  const answer = { thing: THING, certificatePem: 'x', rootCa: 'y', endpoint: ENDPOINT, downloadPrefix: PREFIX };
  const { api, calls } = apiAnswering([new Response(JSON.stringify(answer), { status: 201 })]);
  const csr = '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----\n';
  assert.deepEqual(await api.registerDevice({ id: 'fe5b26c0c5b1dcd7', csr, reregister: true }), answer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/devices/register');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer TOKEN-1');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'fe5b26c0c5b1dcd7', csr, reregister: true });

  // A gateway's hiccup is not tried again: a second try would make a second certificate.
  const busy = apiAnswering([new Response('{}', { status: 503 }), new Response('{}', { status: 201 })]);
  await assert.rejects(busy.api.registerDevice({ id: 'abc', csr }));
  assert.equal(busy.calls.length, 1);

  // What is not an ID or a request is not sent at all.
  const none = apiAnswering([]);
  await assert.rejects(none.api.registerDevice({ id: 'a|b', csr }));
  await assert.rejects(none.api.registerDevice({ id: 'abc', csr: 'WIFI_SEC|x' }));
  assert.equal(none.calls.length, 0);
});

test('the golden image is fetched beside the page, with no token, by its file name only', async () => {
  const { api, calls } = apiAnswering([new Response(GOLDEN_BYTES.slice(0, 64), { status: 200 })], null);
  const bytes = await api.golden('cranium-1.5.0-0.signed.bin');
  assert.deepEqual([...bytes], [...GOLDEN_BYTES.slice(0, 64)]);
  assert.equal(calls[0].path, '/golden/cranium-1.5.0-0.signed.bin');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.credentials, 'omit');
  await assert.rejects(api.golden('../server.mjs'));
  assert.equal(calls.length, 1);
});

// 2.6.3: the Wi-Fi defaults, the hardening for a real board, the self-check and the phone apps.

test('the self-check runs every step against the simulated board, within its line limits', async () => {
  const results = await setup.runSelfCheck({ golden: async () => GOLDEN_BYTES.slice() });
  for (const row of results) assert.equal(row.ok, true, `${row.name}: ${row.detail}`);
  assert.ok(results.length >= 6);
});

test('the simulated board refuses what the real one refuses: a long console line, a long recovery line', async () => {
  const board = setup.simulatedBoard({ state: 'OPERATING' });
  const writer = board.port.writable.getWriter();
  await writer.write(new TextEncoder().encode(`CLOUD|${'a'.repeat(400)}\r`));
  assert.deepEqual(board.problems, ['a console line of 406 bytes']);
  board.mode = 'bootloader';
  await writer.write(Uint8Array.from([0x06, 0x09, ...new Array(130).fill(0x41), 0x0a]));
  assert.equal(board.problems[1], 'a recovery line of 133 bytes');
  // The page's own lines fit: 2 start bytes, 124 base64 characters, the newline.
  const packet = recovery.smpPacket({
    op: 2,
    group: 1,
    id: 1,
    sequence: 1,
    body: { off: 0, data: new Uint8Array(recovery.CHUNK), len: 999999, image: 0 },
  });
  assert.ok(packet.length + 2 <= recovery.BOOT_RECEIVE_MAX);
  for (const line of recovery.frameLines(packet)) assert.ok(line.length <= recovery.BOOT_LINE_MAX, `${line.length}`);
});

test('the embedded root CA is firmware/certs/AmazonRootCA1.pem, so the self-check checks the real one', () => {
  assert.equal(setup.AMAZON_ROOT_CA1.trim(), ROOT_CA_PEM.trim());
});

test('a command longer than the console takes is never sent', async () => {
  const board = fakeBoard({ state: 'OPERATING' });
  const link = recovery.createLink(board.port, { handshakeMs: 150 });
  await assert.rejects(link.command(`CLOUD|${'a'.repeat(400)}|https://x.example.test/`), (error) => {
    assert.equal(error.code, 'too-long');
    return true;
  });
  assert.equal(
    board.text.some((line) => line.startsWith('CLOUD')),
    false
  );
  await link.close();
});

test('the port is opened with a buffer larger than Web Serial’s 255 bytes', async () => {
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  const opened = [];
  const open = board.port.open;
  board.port.open = async (options) => {
    opened.push(options);
    return open();
  };
  const { flow } = makeFlow({ board });
  await flow.connect();
  assert.deepEqual(opened[0], { baudRate: 115200, bufferSize: recovery.SERIAL_BUFFER_BYTES });
  assert.ok(recovery.SERIAL_BUFFER_BYTES >= 4096);
  await flow.disconnect();
});

test('a port that only prints is named as the log port, not as a blank board', async () => {
  const log = fakeLogPort();
  const flow = setup.createSetupFlow({
    serial: fakeSerial([log.port]),
    api: fakeApi({ releaseImage: makeImage('1.14.5+0') }),
    subtle: globalThis.crypto.subtle,
    timing: FAST,
  });
  const chatter = setInterval(() => log.say('[00:00:01.000,000] <inf> wifi: scanning'), 20);
  await flow.connect();
  clearInterval(chatter);
  assert.equal(flow.steps.connect.error, setup.WORDS.logPort);
  await flow.disconnect();
});

function setupReady(api) {
  // The fields are found by their ids: no other test's form may be on the page.
  for (const child of [...document.body.childNodes]) child.remove();
  const board = fakeBoard({ state: 'OPERATING', firmware: '1.14.5+0' });
  return { board, ...makeFlow({ board, api }) };
}

test('the Wi-Fi fields start with the console’s defaults, which the page keeps nowhere else', async () => {
  const api = fakeApi({ releaseImage: makeImage('1.14.5+0') });
  const FAKE = { ssid: 'Fake’s defaults', passphrase: 'fake-default-pass-1', security: 'WPA3_SAE' };
  api.wifiDefaults = async () => ({ ...FAKE });
  const { flow, box, board } = setupReady(api);
  await flow.connect();
  flow.skip('golden');
  flow.skip('firmware');
  await until(() => flow.wifiDefaults.state === 'filled');
  assert.equal(document.getElementById('setup-ssid').value, FAKE.ssid);
  const pass = document.getElementById('setup-passphrase');
  assert.equal(pass.value, FAKE.passphrase);
  assert.equal(pass.getAttribute('type'), 'password');
  assert.equal(document.getElementById('setup-security').value, 'WPA3_SAE');
  assert.ok(textOf(box).includes(setup.WORDS.wifiFilled));
  assert.equal(JSON.stringify(flow).includes(FAKE.passphrase), false);
  assert.equal(textOf(box).includes(FAKE.passphrase), false);
  // The person may change them.
  document.getElementById('setup-ssid').value = 'Typed network';
  click(one(box, 'button', 'Set it up'));
  await until(() => !flow.busy && flow.steps.setup.status !== 'running');
  assert.equal(flow.steps.setup.status, 'done', flow.steps.setup.error);
  assert.deepEqual(board.wifi, { ssid: 'Typed network', security: 'WPA3_SAE', passphrase: FAKE.passphrase });
  await flow.disconnect();
});

test('the page says when the console has no defaults, or would not give them', async () => {
  const cases = [
    [async () => null, setup.WORDS.wifiNone],
    [
      async () => {
        throw Object.assign(new Error('no'), { name: 'ApiError', status: 403 });
      },
      'only a release manager',
    ],
  ];
  for (const [answer, words] of cases) {
    const api = fakeApi({ releaseImage: makeImage('1.14.5+0') });
    api.wifiDefaults = answer;
    const { flow, box } = setupReady(api);
    await flow.connect();
    flow.skip('golden');
    flow.skip('firmware');
    await until(() => ['none', 'failed'].includes(flow.wifiDefaults.state));
    assert.ok(textOf(box).includes(words), words);
    assert.equal(document.getElementById('setup-ssid').value, '');
    await flow.disconnect();
  }
});

test('the API client reads the defaults from their one route, with the token', async () => {
  const wifi = { ssid: 'S', passphrase: 'fake-pass-9', security: 'WPA2_PSK' };
  const { api, calls } = apiAnswering([new Response(JSON.stringify({ wifi }), { status: 200 })]);
  assert.deepEqual(await api.wifiDefaults(), wifi);
  assert.equal(calls[0].path, '/api/setup/wifi-defaults');
  assert.equal(calls[0].options.headers.authorization, 'Bearer TOKEN-1');
  const none = apiAnswering([new Response(JSON.stringify({ wifi: null }), { status: 200 })]);
  assert.equal(await none.api.wifiDefaults(), null);
});

test('the Android classic screens say where Board setup is', () => {
  assert.equal(setup.appPlatform, undefined);
  assert.equal(setup.APP_WORDS.ios, undefined);
  assert.ok(setup.APP_WORDS.android.includes('Developer'));
  assert.ok(setup.APP_WORDS.android.includes('Chrome or Edge'));
});

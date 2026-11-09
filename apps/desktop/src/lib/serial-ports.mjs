/**
 * The serial port chooser's list (main.mjs chooseSerialPort): the ports Electron offers, with a J-Link's two
 * virtual COM ports named for what they are. On the nRF7002 DK and the nRF5340 DK the application's console
 * is the second, VCOM1, and the log the first, VCOM0: the higher ttyACM on Linux and, with one J-Link
 * plugged in, the higher COM port on Windows (docs/new-board-setup.md, "From the console: Board setup").
 * The console port comes first, so it is the chooser's default; Board setup asks for the log port second,
 * when it seals the golden image, and the person chooses it by its name.
 *
 * No dependencies.
 */

export const SEGGER_VENDOR_ID = 0x1366;

const number = (name) => {
  const match = /(\d+)$/.exec(String(name ?? ''));
  return match ? Number(match[1]) : Number.NaN;
};

const isJLink = (port) => {
  const vendor = port?.vendorId;
  return (typeof vendor === 'string' ? Number.parseInt(vendor, 16) : vendor) === SEGGER_VENDOR_ID;
};

/** [{ portId, label, role }] with role 'console', 'log' or null, the console ports first. */
export function orderPorts(ports) {
  const list = Array.isArray(ports) ? ports.filter((port) => port && typeof port.portId === 'string') : [];
  const roles = new Map();
  const probes = new Map();
  for (const port of list.filter(isJLink)) {
    const key = port.serialNumber ?? '';
    probes.set(key, [...(probes.get(key) ?? []), port]);
  }
  for (const group of probes.values()) {
    if (group.length !== 2) continue;
    const [low, high] = [...group].sort((a, b) => number(a.portName) - number(b.portName));
    if (Number.isNaN(number(low.portName)) || number(low.portName) === number(high.portName)) continue;
    roles.set(high.portId, 'console');
    roles.set(low.portId, 'log');
  }
  const rank = { console: 0, log: 1 };
  return list
    .map((port, index) => {
      const role = roles.get(port.portId) ?? null;
      const name = port.displayName || port.portName || port.portId;
      const shown = port.portName && port.displayName ? `${port.displayName} (${port.portName})` : name;
      const said = role === 'console' ? ': the console port' : role === 'log' ? ': the log port' : '';
      return { portId: port.portId, label: `${shown}${said}`, role, index };
    })
    .sort((a, b) => (rank[a.role] ?? 2) - (rank[b.role] ?? 2) || a.index - b.index)
    .map(({ portId, label, role }) => ({ portId, label, role }));
}

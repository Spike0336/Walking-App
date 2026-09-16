/*
 * protocol.js
 *
 * JavaScript port of fitshow_protocol.py, for use with the Web Bluetooth
 * API instead of Python's `bleak`. Same frame format, same commands,
 * same known unknowns -- see the comments carried over from the
 * original file.
 *
 * FRAME FORMAT
 *   STX  CMD  [payload bytes...]  CHECKSUM  ETX
 *   0x02  ..   ...                  ..       0x03
 * Checksum = XOR of every byte between STX and the checksum byte.
 *
 * NOTE ON THE AUTH HANDSHAKE (0xab): exactly as in the Python version,
 * this module does NOT attempt it -- the response algorithm was never
 * reverse engineered. If your pad refuses to respond after connecting,
 * this is the likely reason.
 */

const STX = 0x02;
const ETX = 0x03;

function checksum(bytes) {
  let cs = 0;
  for (const b of bytes) cs ^= b;
  return cs;
}

function buildFrame(cmd, payload = []) {
  const body = [cmd, ...payload];
  const cs = checksum(body);
  return new Uint8Array([STX, ...body, cs, ETX]);
}

/** Validate a raw notification and return the cmd+payload bytes, or null. */
function parseFrame(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length < 4) return null;
  if (bytes[0] !== STX || bytes[bytes.length - 1] !== ETX) return null;
  const body = bytes.slice(1, bytes.length - 2);
  const cs = bytes[bytes.length - 2];
  if (checksum(body) !== cs) return null;
  return body;
}

// ---- Command builders ----------------------------------------------

function cmdQueryInfo() { return buildFrame(0x50, [0x02]); }
function cmdQueryStatus() { return buildFrame(0x50, [0x03]); }
function cmdPoll() { return buildFrame(0x51); }
function cmdStart() { return buildFrame(0x53, [0x01, 0, 0, 0, 0, 0, 0, 0]); }
function cmdStop() { return buildFrame(0x53, [0x03]); }

/** kmh in 0.1 km/h steps, e.g. 5.0 -> byte 0x32. */
function cmdSetSpeed(kmh) {
  const speedByte = Math.max(0, Math.min(255, Math.round(kmh * 10)));
  return buildFrame(0x53, [0x02, speedByte, 0x00]);
}

// ---- Response parsing -------------------------------------------------

/**
 * Parse a 0x51 (poll) reply. Same two confirmed shapes as the Python
 * version: short idle form (51 <mode>) and the long running/stopping
 * form carrying speed/time/distance/calories.
 */
function parseStatus(body) {
  if (!body || body.length < 1) return null;
  const cmd = body[0];
  if (cmd !== 0x51) {
    return { raw: body, cmd, extra: body.slice(1) };
  }

  if (body.length < 3) {
    const mode = body.length >= 2 ? body[1] : null;
    return { raw: body, cmd, mode, speedKmh: null, timeSeconds: null, distanceM: null, calories: null, extra: new Uint8Array() };
  }

  const mode = body[1];
  const speedKmh = body[2] / 10.0;

  let timeSeconds = null, distanceM = null, calories = null;
  if (body.length >= 5) timeSeconds = (body[3] << 8) | body[4];
  if (body.length >= 7) distanceM = (body[5] << 8) | body[6];
  if (body.length >= 9) calories = ((body[7] << 8) | body[8]) / 10.0;

  return {
    raw: body, cmd, mode, speedKmh, timeSeconds, distanceM, calories,
    extra: body.slice(3),
  };
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Exported as a plain object so it can be loaded with a normal <script> tag.
window.FitshowProtocol = {
  buildFrame, parseFrame, cmdQueryInfo, cmdQueryStatus, cmdPoll,
  cmdStart, cmdStop, cmdSetSpeed, parseStatus, toHex,
};

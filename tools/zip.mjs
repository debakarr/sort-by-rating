/**
 * Minimal, dependency-free ZIP writer.
 *
 * We ship release archives (Chrome Web Store, AMO and GitHub releases all take
 * a zip) without depending on the system `zip` binary.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function collect(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, base, out);
    } else {
      out.push({ full, name: relative(base, full).split(sep).join('/') });
    }
  }
  return out;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * Zip every file under `dir`, storing paths relative to `dir` (so the manifest
 * ends up at the archive root, as the stores require).
 * @returns {number} number of files written
 */
export function makeZip(dir, outFile) {
  const files = collect(dir, dir, []).sort((a, b) => a.name.localeCompare(b.name));
  const { time, day } = dosDateTime(new Date());

  const localChunks = [];
  const centralEntries = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.full);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(file.name, 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);      // version needed
    header.writeUInt16LE(0x0800, 6);  // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    localChunks.push(header, nameBuf, body);
    centralEntries.push({ nameBuf, method, crc, csize: body.length, usize: data.length, offset });
    offset += header.length + nameBuf.length + body.length;
  }

  const centralChunks = [];
  let centralSize = 0;

  for (const entry of centralEntries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);      // version made by
    header.writeUInt16LE(20, 6);      // version needed
    header.writeUInt16LE(0x0800, 8);  // UTF-8 names
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.csize, 20);
    header.writeUInt32LE(entry.usize, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);      // extra length
    header.writeUInt16LE(0, 32);      // comment length
    header.writeUInt16LE(0, 34);      // disk number
    header.writeUInt16LE(0, 36);      // internal attributes
    header.writeUInt32LE(0, 38);      // external attributes
    header.writeUInt32LE(entry.offset, 42);

    centralChunks.push(header, entry.nameBuf);
    centralSize += header.length + entry.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralEntries.length, 8);
  eocd.writeUInt16LE(centralEntries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...localChunks, ...centralChunks, eocd]));
  return files.length;
}

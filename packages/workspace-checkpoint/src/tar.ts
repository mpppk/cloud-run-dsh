/**
 * Minimal in-package ustar (POSIX tar) writer/reader.
 * No external dependency; format is the classic 512-byte-block ustar
 * described by 仕様書 section 7 / 実装手順書 section 20
 * (manifest field `untracked: "untracked.tar"` promises real tar format).
 */

export interface TarEntry {
  path: string;
  content: Uint8Array;
}

const BLOCK = 512;

function isAllZero(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Write a right-aligned octal number into a fixed-size header field, NUL terminated. */
function writeOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  const padded = "0".repeat(Math.max(0, length - 1 - digits.length)) + digits;
  const bytes = new TextEncoder().encode(padded);
  if (bytes.length !== length - 1) throw new Error(`ustar: value ${value} does not fit in ${length}-byte field`);
  buf.set(bytes, offset);
  buf[offset + length - 1] = 0;
}

function writeString(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error(`ustar: string "${value}" exceeds ${length}-byte field`);
  buf.set(bytes, offset);
}

/** Compute the ustar checksum: byte sum with the chksum field treated as 8 spaces. */
function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = header[i] ?? 0;
    sum += i >= 148 && i < 156 ? 0x20 : byte;
  }
  return sum;
}

function parseOctal(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if (first & 0x80) {
    throw new Error("ustar: GNU base-256 numeric fields are not supported");
  }
  let s = "";
  for (let i = 0; i < length; i++) {
    const b = block[offset + i];
    if (b === undefined || b === 0 || b === 0x20) break;
    s += String.fromCharCode(b);
  }
  if (s.length === 0) return 0;
  const value = parseInt(s, 8);
  if (Number.isNaN(value)) throw new Error(`ustar: invalid octal field "${s}"`);
  return value;
}

/** Read a NUL-terminated fixed-size string field. */
function readString(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** Split a long path into (prefix, name) per ustar rules; returns null if impossible. */
function splitUstarPath(path: string): { prefix: string; name: string } | null {
  if (path.length <= 100) return { prefix: "", name: path };
  const slash = path.lastIndexOf("/", path.length - 1);
  if (slash === -1) return null; // basename itself > 100 chars
  const name = path.slice(slash + 1);
  const prefix = path.slice(0, slash);
  if (name.length === 0 || name.length > 100 || prefix.length > 155) return null;
  return { prefix, name };
}

export function createUntrackedTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/");
    if (path.length === 0 || path.endsWith("/")) {
      throw new Error(`ustar: invalid entry path "${entry.path}"`);
    }
    const split = splitUstarPath(path);
    if (!split) {
      throw new Error(`ustar: path too long for ustar format: "${entry.path}"`);
    }

    const dataBlocks = Math.ceil(entry.content.length / BLOCK) * BLOCK;
    const padded = new Uint8Array(dataBlocks);
    padded.set(entry.content, 0);

    const header = new Uint8Array(BLOCK);
    writeString(header, 0, 100, split.name);
    writeOctal(header, 100, 8, 0o644); // mode
    writeOctal(header, 108, 8, 0); // uid
    writeOctal(header, 116, 8, 0); // gid
    writeOctal(header, 124, 12, entry.content.length); // size
    writeOctal(header, 136, 12, 0); // mtime (deterministic)
    header.fill(0x20, 148, 156); // chksum placeholder: 8 spaces
    header[156] = 0x30; // typeflag: '0' regular file
    writeString(header, 257, 6, "ustar\0"); // magic
    writeString(header, 263, 2, "00"); // version
    writeString(header, 265, 32, ""); // uname
    writeString(header, 297, 32, ""); // gname
    if (split.prefix) writeString(header, 345, 155, split.prefix);

    writeOctal(header, 148, 8, computeChecksum(header));

    chunks.push(header, padded);
  }
  // ustar archive ends with two zero blocks.
  chunks.push(new Uint8Array(BLOCK * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function extractUntrackedTar(data: Uint8Array): TarEntry[] {
  if (data.length === 0) return [];
  if (data.length % BLOCK !== 0) {
    throw new Error("ustar: archive size is not a multiple of 512 bytes");
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (isAllZero(header)) break; // end-of-archive marker
    const magic = new TextDecoder().decode(header.subarray(257, 263));
    // POSIX ustar: "ustar\0" + version "00"; GNU ustar: "ustar " + version " \0".
    if (magic !== "ustar\0" && magic !== "ustar ") {
      throw new Error("ustar: not a ustar archive (bad magic)");
    }
    const storedChksum = parseOctal(header, 148, 8);
    if (storedChksum !== computeChecksum(header)) {
      throw new Error("ustar: header checksum mismatch");
    }
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!path) throw new Error("ustar: entry with empty path");
    offset += BLOCK;
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + paddedSize > data.length) {
      throw new Error("ustar: truncated entry data");
    }
    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ path, content: new Uint8Array(data.subarray(offset, offset + size)) });
    }
    // Non-regular entries (directories, pax headers, links) are skipped but
    // their data (if any) is still consumed.
    offset += paddedSize;
  }
  return entries;
}

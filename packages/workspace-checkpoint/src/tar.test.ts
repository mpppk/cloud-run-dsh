import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUntrackedTar, extractUntrackedTar } from "./tar.js";

function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function parseOctal(block: Uint8Array, offset: number, length: number): number {
  let s = "";
  for (let i = 0; i < length; i++) {
    const b = block[offset + i];
    if (b === 0 || b === 0x20) break;
    s += String.fromCharCode(b);
  }
  return parseInt(s, 8);
}

describe("ustar tar", () => {
  test("round-trip: create then extract yields identical entries", () => {
    const entries = [
      { path: "a.txt", content: new TextEncoder().encode("hello world") },
      { path: "dir/nested/b.bin", content: new Uint8Array([0, 1, 2, 255, 254, 0x0d, 0x0a]) },
      { path: "empty.txt", content: new Uint8Array([]) },
    ];
    const tar = createUntrackedTar(entries);
    const extracted = extractUntrackedTar(tar);
    expect(extracted.length).toBe(3);
    for (let i = 0; i < entries.length; i++) {
      expect(extracted[i].path).toBe(entries[i].path);
      expect([...extracted[i].content]).toEqual([...entries[i].content]);
    }
  });

  test("round-trip: long paths (>100 chars) survive via ustar prefix splitting", () => {
    const longPath = `${"very-long-directory-name/".repeat(5)}leaf.txt`;
    expect(longPath.length).toBeGreaterThan(100);
    const content = new TextEncoder().encode("deep");
    const tar = createUntrackedTar([{ path: longPath, content }]);
    const extracted = extractUntrackedTar(tar);
    expect(extracted.length).toBe(1);
    expect(extracted[0].path).toBe(longPath);
    expect(new TextDecoder().decode(extracted[0].content)).toBe("deep");
  });

  test("header block is valid ustar: magic, checksum, 512-byte blocks", () => {
    const content = new TextEncoder().encode("x".repeat(600)); // spans 2 data blocks
    const tar = createUntrackedTar([{ path: "file.txt", content }]);

    // Archive is a whole number of 512-byte blocks (header + 2 data + 2 end)
    expect(tar.length % 512).toBe(0);
    expect(tar.length).toBe(512 * 5);

    const header = tar.subarray(0, 512);
    // magic "ustar\0" at offset 257, version "00" at 263
    expect(new TextDecoder().decode(header.subarray(257, 263))).toBe("ustar\0");
    expect(new TextDecoder().decode(header.subarray(263, 265))).toBe("00");
    // typeflag '0' (regular file)
    expect(String.fromCharCode(header[156])).toBe("0");
    // size field matches content length
    expect(parseOctal(header, 124, 12)).toBe(content.length);
    // stored checksum field matches independent recomputation
    const storedChksum = parseOctal(header, 148, 8);
    expect(storedChksum).toBe(computeChecksum(header));
    // end-of-archive: two zero blocks
    const end = tar.subarray(tar.length - 1024);
    expect(end.every((b) => b === 0)).toBe(true);
  });

  test("archive is readable by standard tooling: tar -tf lists entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ustar-test-"));
    try {
      const tar = createUntrackedTar([
        { path: "alpha.txt", content: new TextEncoder().encode("A") },
        { path: "sub/beta.txt", content: new TextEncoder().encode("B") },
      ]);
      const tarPath = join(dir, "untracked.tar");
      writeFileSync(tarPath, tar);
      const proc = Bun.spawnSync(["tar", "-tf", tarPath]);
      expect(proc.exitCode).toBe(0);
      const listing = new TextDecoder().decode(proc.stdout);
      expect(listing).toContain("alpha.txt");
      expect(listing).toContain("sub/beta.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extract rejects non-ustar data (JSON legacy or garbage)", () => {
    const json = new TextEncoder().encode('{"legacy.json":"dGVzdA=="}');
    expect(() => extractUntrackedTar(json)).toThrow();
    expect(() => extractUntrackedTar(new TextEncoder().encode("not a tar at all"))).toThrow();
  });

  test("extract rejects corrupted checksum", () => {
    const tar = createUntrackedTar([{ path: "a.txt", content: new TextEncoder().encode("hi") }]);
    const corrupted = new Uint8Array(tar);
    corrupted[10] ^= 0xff; // flip a byte inside the name field
    expect(() => extractUntrackedTar(corrupted)).toThrow(/checksum/);
  });
});

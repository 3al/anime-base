// core module — vision-gate probe asset generator.
//
// Generates a tiny deterministic PNG used as a *pre-flight multimodality probe*
// by image-handling skills: before any poster download, a skill opens this
// asset with Read. If Read returns visual content → the model is multimodal and
// real image work proceeds; if Read errors / yields only metadata → the model
// is blind and the whole image part is skipped (zero network attempts). This
// decouples the modality probe from a real poster download (B-009).
//
// Why generated, not shipped as a committed binary:
//   - stays in the framework's "text-in-bundle → artifact-on-install" idiom
//     (B-008 was about binary/materialize fragility);
//   - deterministic + self-healing: a corrupted probe is rewritten on install;
//   - the pixel content lives only here, in install-time code that the *runtime*
//     model never reads — so a non-multimodal model cannot "parrot" the probe's
//     content from a template. The PRIMARY signal is Read-tool behaviour, not
//     whether the model names the shape; "name the shape/colour" is secondary.
//
// The probe is a red filled circle on a white background — a distinct
// shape+colour a multimodal model can describe.

import { deflateSync } from 'node:zlib';
import { writeFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Path of the probe relative to the vault root. Skills run with cwd = vault
// root, so they reference this literal path. Single source of truth.
export const VISION_PROBE_REL = '.claude/assets/vision_probe.png';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Standard CRC-32 (IEEE 802.3). Node's zlib.crc32 isn't available on every
// supported runtime, so compute it locally.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Build a SIZE×SIZE truecolour PNG: white background, centred red filled circle.
function buildProbePng() {
  const SIZE = 32;
  const c = (SIZE - 1) / 2;
  const r2 = 11 * 11;

  // Raw scanlines: each row prefixed with filter byte 0, then RGB triples.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
  let o = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r2) { raw[o++] = 255; raw[o++] = 0; raw[o++] = 0; }     // red
      else { raw[o++] = 255; raw[o++] = 255; raw[o++] = 255; }                          // white
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); // width
  ihdr.writeUInt32BE(SIZE, 4); // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A valid probe is a PNG (signature match) of plausible size. Used for
// self-heal: a truncated/corrupted probe is rewritten.
function isValidProbe(path) {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size < 8) return false;
    return readFileSync(path).subarray(0, 8).equals(PNG_SIG);
  } catch {
    return false;
  }
}

/**
 * Ensure <vaultRoot>/.claude/assets/vision_probe.png exists and is valid.
 * Write-if-absent-or-invalid (self-heal).
 * @returns {{ action: 'probe_generated' | 'probe_present', path: string }}
 */
export function writeVisionProbe(vaultRoot) {
  const path = join(vaultRoot, VISION_PROBE_REL);
  if (isValidProbe(path)) return { action: 'probe_present', path };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildProbePng());
  return { action: 'probe_generated', path };
}

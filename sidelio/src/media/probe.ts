/**
 * Image header probing.
 *
 * Reads dimensions and format from the first bytes of a file, without decoding
 * pixels and without a dependency. That is all the ingestion pipeline needs:
 * `smartCrop`, `planDerivatives` and `responsiveImage` are pure geometry over
 * width and height, so a header read unlocks the whole media module.
 *
 * Pixel-level work (perceptual hashing, actual transformation) genuinely needs
 * a decoder and is left to a worker that has one.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg';

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  mimeType: string;
}

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const u16be = (b: Uint8Array, i: number) => ((b[i] as number) << 8) | (b[i + 1] as number);
const u32be = (b: Uint8Array, i: number) =>
  (((b[i] as number) << 24) | ((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number)) >>> 0;
const u16le = (b: Uint8Array, i: number) => (b[i] as number) | ((b[i + 1] as number) << 8);
const u32le = (b: Uint8Array, i: number) =>
  ((b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16) | ((b[i + 3] as number) << 24)) >>> 0;

/** PNG: 8-byte signature, then an IHDR chunk carrying width and height. */
function probePng(b: Uint8Array): ImageInfo | null {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (b.length < 24) return null;
  // Bytes 12..16 must spell "IHDR" for the dimensions to be where we expect.
  if (!startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return null;
  return { format: 'png', width: u32be(b, 16), height: u32be(b, 20), mimeType: MIME.png };
}

/**
 * JPEG: walk the marker segments to the first Start-Of-Frame. Dimensions are
 * not at a fixed offset — EXIF and ICC segments commonly precede the frame, so
 * a naive fixed read gets the wrong numbers on most camera output.
 */
function probeJpeg(b: Uint8Array): ImageInfo | null {
  if (!startsWith(b, [0xff, 0xd8])) return null;

  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      i++;               // resynchronise on fill bytes rather than giving up
      continue;
    }
    const marker = b[i + 1] as number;

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;  // end of image / scan data

    const length = u16be(b, i + 2);
    if (length < 2) return null;

    // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 >= b.length) return null;
      return {
        format: 'jpeg',
        height: u16be(b, i + 5),
        width: u16be(b, i + 7),
        mimeType: MIME.jpeg,
      };
    }
    i += 2 + length;
  }
  return null;
}

/** GIF: dimensions live in the logical screen descriptor, little-endian. */
function probeGif(b: Uint8Array): ImageInfo | null {
  if (!startsWith(b, [0x47, 0x49, 0x46, 0x38])) return null;
  if (b.length < 10) return null;
  return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), mimeType: MIME.gif };
}

/** WebP: a RIFF container whose three sub-formats each store size differently. */
function probeWebp(b: Uint8Array): ImageInfo | null {
  if (!startsWith(b, [0x52, 0x49, 0x46, 0x46])) return null;       // "RIFF"
  if (!startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return null;    // "WEBP"
  if (b.length < 30) return null;

  const chunk = String.fromCharCode(b[12] as number, b[13] as number, b[14] as number, b[15] as number);

  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit dimensions.
    return {
      format: 'webp',
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
      mimeType: MIME.webp,
    };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit width and height packed across four bytes, minus one.
    const bits = u32le(b, 21);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      mimeType: MIME.webp,
    };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas size minus one, little-endian.
    const width = ((b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16)) + 1;
    const height = ((b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16)) + 1;
    return { format: 'webp', width, height, mimeType: MIME.webp };
  }
  return null;
}

/** BMP: DIB header holds signed 32-bit dimensions; height may be negative. */
function probeBmp(b: Uint8Array): ImageInfo | null {
  if (!startsWith(b, [0x42, 0x4d])) return null;
  if (b.length < 26) return null;
  const width = u32le(b, 18) | 0;
  const height = u32le(b, 22) | 0;
  return { format: 'bmp', width: Math.abs(width), height: Math.abs(height), mimeType: MIME.bmp };
}

/**
 * SVG has no intrinsic raster size. Read the width/height attributes, falling
 * back to the viewBox, and report 0 when neither is present rather than
 * inventing a number — the library audit treats 0 as "unknown", not "tiny".
 */
function probeSvg(b: Uint8Array): ImageInfo | null {
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 2048)));
  if (!/<svg[\s>]/i.test(head)) return null;

  const attr = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)`, 'i').exec(head);
    return m ? Math.round(Number(m[1])) : 0;
  };
  let width = attr('width');
  let height = attr('height');

  if (!width || !height) {
    const vb = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i.exec(head);
    if (vb) {
      width = width || Math.round(Number(vb[1]));
      height = height || Math.round(Number(vb[2]));
    }
  }
  return { format: 'svg', width, height, mimeType: MIME.svg };
}

const PROBES = [probePng, probeJpeg, probeGif, probeWebp, probeBmp, probeSvg];

/** Returns null for anything that is not a recognizable image. */
export function probeImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 8) return null;
  for (const probe of PROBES) {
    const info = probe(bytes);
    // Guard against a signature match that yields nonsense dimensions.
    if (info && (info.format === 'svg' || (info.width > 0 && info.height > 0))) return info;
  }
  return null;
}

/** File extension for a stored object, derived from the detected format. */
export function extensionFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * Minimal QR Code encoder — byte mode, ECC level M (15% recovery),
 * versions 1..10 (21×21 to 57×57). Pure-TS, zero dependencies.
 *
 * Implementation distilled from ISO/IEC 18004 + Project Nayuki's reference
 * design (MIT). Just enough to encode share codes (~12 chars) and deep-link
 * URLs (~100 chars). Renders to a boolean matrix; the caller converts to SVG.
 */

const ECC_CODEWORDS_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
];

const NUM_ERROR_CORRECTION_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
];

const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
];

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export function encodeQr(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length);
  const size = 17 + 4 * version;
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[version - 1]!;
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version - 1]!;
  const totalCodewords = TOTAL_CODEWORDS[version - 1]!;
  const totalDataCodewords = totalCodewords - eccPerBlock * numBlocks;

  // 1. Build bit stream: mode (0100 byte) + char count + payload + terminator.
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, data.length, version < 10 ? 8 : 16);
  for (const b of data) appendBits(bits, b, 8);

  // Terminator (up to 4 zero bits) then byte-align.
  for (let i = 0; i < 4 && bits.length < totalDataCodewords * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad bytes alternating 0xEC, 0x11.
  const padBytes = [0xec, 0x11];
  for (let i = 0; bits.length < totalDataCodewords * 8; i++) {
    appendBits(bits, padBytes[i % 2]!, 8);
  }

  // 2. Pack into codeword bytes.
  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    dataCodewords.push(byte);
  }

  // 3. Reed-Solomon ECC per block, then interleave.
  const allCodewords = buildEccAndInterleave(
    dataCodewords,
    numBlocks,
    totalDataCodewords,
    eccPerBlock,
  );

  // 4. Draw modules.
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array(size).fill(false),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array(size).fill(false),
  );

  drawFunctionPatterns(modules, reserved, version, size);
  drawCodewords(modules, reserved, allCodewords, size);

  // 5. Pick best mask (lowest penalty) and apply + write format info.
  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = modules;
  for (let mask = 0; mask < 8; mask++) {
    const trial = modules.map((row) => row.slice());
    applyMask(trial, reserved, mask, size);
    drawFormatBits(trial, mask, size);
    const score = penalty(trial, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestMatrix = trial;
    }
  }
  void bestMask;

  return { size, modules: bestMatrix };
}

function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[v - 1]!;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[v - 1]!;
    const totalDataCodewords = TOTAL_CODEWORDS[v - 1]! - eccPerBlock * numBlocks;
    const headerBits = 4 + (v < 10 ? 8 : 16);
    const capacityBits = totalDataCodewords * 8 - headerBits;
    if (byteLen * 8 <= capacityBits) return v;
  }
  throw new Error(`QR payload too long: ${byteLen} bytes`);
}

function appendBits(out: number[], value: number, n: number): void {
  for (let i = n - 1; i >= 0; i--) out.push((value >>> i) & 1);
}

/* ─── Reed-Solomon over GF(256), primitive polynomial 0x11D ─── */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next: number[] = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ gfMul(poly[j]!, 1);
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], generator: number[]): number[] {
  const remainder: number[] = new Array(generator.length - 1).fill(0);
  for (const b of data) {
    const factor = b ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < remainder.length; i++) {
      remainder[i] = remainder[i]! ^ gfMul(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

function buildEccAndInterleave(
  data: number[],
  numBlocks: number,
  totalDataCodewords: number,
  eccPerBlock: number,
): number[] {
  const shortBlockLen = Math.floor(totalDataCodewords / numBlocks);
  const numLongBlocks = totalDataCodewords % numBlocks;
  const generator = rsGeneratorPoly(eccPerBlock);

  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortBlockLen + (i >= numBlocks - numLongBlocks ? 1 : 0);
    const blockData = data.slice(offset, offset + len);
    offset += len;
    blocks.push(blockData);
    eccBlocks.push(rsRemainder(blockData, generator));
  }

  // Interleave: data block-major, then ecc block-major.
  const result: number[] = [];
  const maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b]!.length) result.push(blocks[b]![i]!);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) result.push(eccBlocks[b]![i]!);
  }
  return result;
}

/* ─── Matrix drawing ─── */

function drawFunctionPatterns(
  m: boolean[][],
  r: boolean[][],
  version: number,
  size: number,
): void {
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setMod(m, r, 6, i, i % 2 === 0);
    setMod(m, r, i, 6, i % 2 === 0);
  }

  // Three finder patterns at corners.
  drawFinder(m, r, 0, 0);
  drawFinder(m, r, size - 7, 0);
  drawFinder(m, r, 0, size - 7);

  // Alignment patterns (versions 2+).
  const alignmentCoords = alignmentPositions(version);
  for (const x of alignmentCoords) {
    for (const y of alignmentCoords) {
      if (
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6)
      )
        continue;
      drawAlignment(m, r, x, y);
    }
  }

  // Reserve format info area.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserve(r, 8, i);
      reserve(r, i, 8);
    }
  }
  for (let i = 0; i < 8; i++) {
    reserve(r, 8, size - 1 - i);
    reserve(r, size - 1 - i, 8);
  }
  setMod(m, r, size - 8, 8, true); // dark module
}

function drawFinder(m: boolean[][], r: boolean[][], x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= m.length || yy >= m.length) continue;
      const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const on = dist !== 2 && dist !== 4 && dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      setMod(m, r, xx, yy, on);
    }
  }
}

function drawAlignment(m: boolean[][], r: boolean[][], cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const on = dist !== 1;
      setMod(m, r, cx + dx, cy + dy, on);
    }
  }
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  // Lookup table from ISO/IEC 18004 Annex E (subset for v2..10).
  const table: Record<number, number[]> = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };
  return table[version]!;
}

function setMod(m: boolean[][], r: boolean[][], x: number, y: number, on: boolean): void {
  m[y]![x] = on;
  r[y]![x] = true;
}

function reserve(r: boolean[][], x: number, y: number): void {
  r[y]![x] = true;
}

function drawCodewords(
  m: boolean[][],
  reserved: boolean[][],
  codewords: number[],
  size: number,
): void {
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip vertical timing column
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - v : v;
        if (!reserved[y]![x]) {
          const byte = codewords[bitIdx >>> 3];
          const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIdx & 7))) & 1;
          m[y]![x] = bit === 1;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }
}

function applyMask(m: boolean[][], reserved: boolean[][], mask: number, size: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y]![x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
      }
      if (invert) m[y]![x] = !m[y]![x];
    }
  }
}

function drawFormatBits(m: boolean[][], mask: number, size: number): void {
  // ECC level M = 0b00; combine with mask, BCH-encode (15,5).
  const eccBits = 0b00;
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) m[8]![i] = ((bits >>> i) & 1) === 1;
  m[8]![7] = ((bits >>> 6) & 1) === 1;
  m[8]![8] = ((bits >>> 7) & 1) === 1;
  m[7]![8] = ((bits >>> 8) & 1) === 1;
  for (let i = 9; i < 15; i++) m[14 - i]![8] = ((bits >>> i) & 1) === 1;

  for (let i = 0; i < 8; i++) m[size - 1 - i]![8] = ((bits >>> i) & 1) === 1;
  for (let i = 8; i < 15; i++) m[8]![size - 15 + i] = ((bits >>> i) & 1) === 1;
  m[size - 8]![8] = true;
}

/* ─── Mask penalty scoring (ISO/IEC 18004 §8.8.2) ─── */

function penalty(m: boolean[][], size: number): number {
  let score = 0;

  // N1: rows/cols with 5+ consecutive same color → 3 + (run - 5).
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m[y]![x] === m[y]![x - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m[y]![x] === m[y - 1]![x]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else run = 1;
    }
  }

  // N2: 2×2 blocks of same color → 3 per block.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) {
        score += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns → 40 each.
  const target = [true, false, true, true, true, false, true];
  const matchAt = (vals: boolean[], i: number): boolean => {
    if (i + 7 > vals.length) return false;
    for (let k = 0; k < 7; k++) if (vals[i + k] !== target[k]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    const row = m[y]!;
    for (let x = 0; x <= size - 7; x++) if (matchAt(row, x)) score += 40;
  }
  for (let x = 0; x < size; x++) {
    const col: boolean[] = [];
    for (let y = 0; y < size; y++) col.push(m[y]![x]!);
    for (let y = 0; y <= size - 7; y++) if (matchAt(col, y)) score += 40;
  }

  // N4: imbalance of dark vs light.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y]![x]) dark++;
  const ratio = (dark * 20) / (size * size);
  const k = Math.floor(Math.abs(ratio - 10));
  score += k * 10;

  return score;
}

/* ─── SVG rendering ─── */

export interface QrSvgOptions {
  size?: number;
  margin?: number;
  fg?: string;
  bg?: string;
  rounded?: boolean;
}

export function qrToSvg(matrix: QrMatrix, opts: QrSvgOptions = {}): string {
  const margin = opts.margin ?? 2;
  const total = matrix.size + margin * 2;
  const fg = opts.fg ?? "#0a0b10";
  const bg = opts.bg ?? "#ffffff";
  const rounded = opts.rounded ?? true;

  let path = "";
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y]![x]) {
        path += `M${x + margin} ${y + margin}h1v1h-1z`;
      }
    }
  }

  const px = opts.size ?? 240;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="${rounded ? "geometricPrecision" : "crispEdges"}">`,
    `<rect width="100%" height="100%" fill="${bg}" rx="${rounded ? 3 : 0}"/>`,
    `<path d="${path}" fill="${fg}"/>`,
    `</svg>`,
  ].join("");
}

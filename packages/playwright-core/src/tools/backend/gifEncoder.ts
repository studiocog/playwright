/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type GifFrame = {
  width: number;
  height: number;
  // RGBA pixels, row by row, 4 bytes per pixel.
  rgba: Buffer | Uint8Array;
  delayMs: number;
};

// Global palette: a 6x7x6 RGB cube (252 colors) plus 4 greys that the cube does not have.
const kRedLevels = 6;
const kGreenLevels = 7;
const kBlueLevels = 6;
const kGreys = [51, 102, 153, 204];
const kCubeSize = kRedLevels * kGreenLevels * kBlueLevels;

function buildPalette(): Buffer {
  const palette = Buffer.alloc(256 * 3);
  let i = 0;
  for (let r = 0; r < kRedLevels; r++) {
    for (let g = 0; g < kGreenLevels; g++) {
      for (let b = 0; b < kBlueLevels; b++) {
        palette[i++] = Math.round(r * 255 / (kRedLevels - 1));
        palette[i++] = Math.round(g * 255 / (kGreenLevels - 1));
        palette[i++] = Math.round(b * 255 / (kBlueLevels - 1));
      }
    }
  }
  for (const grey of kGreys) {
    palette[i++] = grey;
    palette[i++] = grey;
    palette[i++] = grey;
  }
  return palette;
}

const kPalette = buildPalette();

function levelTable(levels: number): Uint8Array {
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++)
    table[v] = Math.round(v * (levels - 1) / 255);
  return table;
}

const kRedIndex = levelTable(kRedLevels);
const kGreenIndex = levelTable(kGreenLevels);
const kBlueIndex = levelTable(kBlueLevels);

function colorDistance(index: number, r: number, g: number, b: number): number {
  const dr = kPalette[index * 3] - r;
  const dg = kPalette[index * 3 + 1] - g;
  const db = kPalette[index * 3 + 2] - b;
  return dr * dr + dg * dg + db * db;
}

export function paletteIndex(r: number, g: number, b: number): number {
  const cube = (kRedIndex[r] * kGreenLevels + kGreenIndex[g]) * kBlueLevels + kBlueIndex[b];
  // Only near-grey pixels can be closer to one of the extra greys.
  if (Math.max(r, g, b) - Math.min(r, g, b) > 48)
    return cube;
  let best = cube;
  let bestDistance = colorDistance(cube, r, g, b);
  for (let i = 0; i < kGreys.length; i++) {
    const distance = colorDistance(kCubeSize + i, r, g, b);
    if (distance < bestDistance) {
      best = kCubeSize + i;
      bestDistance = distance;
    }
  }
  return best;
}

export function paletteColor(index: number): [number, number, number] {
  return [kPalette[index * 3], kPalette[index * 3 + 1], kPalette[index * 3 + 2]];
}

function toIndexedPixels(frame: GifFrame): Uint8Array {
  const count = frame.width * frame.height;
  if (frame.rgba.length < count * 4)
    throw new Error(`Frame data is too short for ${frame.width}x${frame.height} pixels.`);
  const indexed = new Uint8Array(count);
  const rgba = frame.rgba;
  for (let i = 0, p = 0; i < count; i++, p += 4)
    indexed[i] = paletteIndex(rgba[p], rgba[p + 1], rgba[p + 2]);
  return indexed;
}

// Collects variable-length codes, least significant bit first, into GIF data sub-blocks.
class BitWriter {
  private _bytes: number[] = [];
  private _current = 0;
  private _bitCount = 0;

  write(code: number, size: number) {
    this._current |= code << this._bitCount;
    this._bitCount += size;
    while (this._bitCount >= 8) {
      this._bytes.push(this._current & 0xff);
      this._current >>>= 8;
      this._bitCount -= 8;
    }
  }

  subBlocks(): Buffer {
    if (this._bitCount > 0) {
      this._bytes.push(this._current & 0xff);
      this._current = 0;
      this._bitCount = 0;
    }
    const blockCount = Math.ceil(this._bytes.length / 255);
    const out = Buffer.alloc(this._bytes.length + blockCount + 1);
    let o = 0;
    for (let i = 0; i < this._bytes.length; i += 255) {
      const size = Math.min(255, this._bytes.length - i);
      out[o++] = size;
      for (let j = 0; j < size; j++)
        out[o++] = this._bytes[i + j];
    }
    out[o] = 0;
    return out;
  }
}

const kMinCodeSize = 8;
const kMaxCode = 4096;

export function lzwEncode(indexed: Uint8Array): Buffer {
  const clearCode = 1 << kMinCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();
  let codeSize = kMinCodeSize + 1;
  let nextCode = endCode + 1;
  // Maps (prefix code << 8 | next index) to the code of that string.
  const table = new Map<number, number>();

  writer.write(clearCode, codeSize);
  if (!indexed.length) {
    writer.write(endCode, codeSize);
    return writer.subBlocks();
  }

  let prefix = indexed[0];
  for (let i = 1; i < indexed.length; i++) {
    const k = indexed[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    writer.write(prefix, codeSize);
    if (nextCode === kMaxCode) {
      writer.write(clearCode, codeSize);
      table.clear();
      codeSize = kMinCodeSize + 1;
      nextCode = endCode + 1;
    } else {
      if (nextCode >= (1 << codeSize))
        codeSize++;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  writer.write(prefix, codeSize);
  writer.write(endCode, codeSize);
  return writer.subBlocks();
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(Math.max(0, Math.min(0xffff, Math.round(value))));
  return buffer;
}

function delayCentiseconds(delayMs: number): number {
  // Most viewers replace delays below 2 centiseconds with a slow default.
  return Math.max(2, Math.min(0xffff, Math.round(delayMs / 10)));
}

// Encodes frames one by one, so that the caller does not need to keep all RGBA frames in memory.
export class GifEncoder {
  private _chunks: Buffer[] = [];
  private _width = 0;
  private _height = 0;
  private _frameCount = 0;

  addFrame(frame: GifFrame) {
    if (frame.width <= 0 || frame.height <= 0 || frame.width > 0xffff || frame.height > 0xffff)
      throw new Error(`Invalid frame size ${frame.width}x${frame.height}.`);
    this._width = Math.max(this._width, frame.width);
    this._height = Math.max(this._height, frame.height);
    this._frameCount++;
    this._chunks.push(
        // Graphic control extension: no disposal, no transparency, delay in centiseconds.
        Buffer.from([0x21, 0xf9, 0x04, 0x00]), u16(delayCentiseconds(frame.delayMs)), Buffer.from([0x00, 0x00]),
        // Image descriptor at (0, 0), no local color table, not interlaced.
        Buffer.from([0x2c]), u16(0), u16(0), u16(frame.width), u16(frame.height), Buffer.from([0x00]),
        Buffer.from([kMinCodeSize]), lzwEncode(toIndexedPixels(frame)),
    );
  }

  frameCount(): number {
    return this._frameCount;
  }

  finish(): Buffer {
    if (!this._frameCount)
      throw new Error('Cannot encode a GIF without frames.');
    const header = Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      // Logical screen descriptor: global color table of 256 entries, 8 bits per channel.
      u16(this._width), u16(this._height), Buffer.from([0xf7, 0x00, 0x00]),
      kPalette,
      // NETSCAPE2.0 application extension: loop forever.
      Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from([0x03, 0x01]), u16(0), Buffer.from([0x00]),
    ]);
    return Buffer.concat([header, ...this._chunks, Buffer.from([0x3b])]);
  }
}

export function encodeGif(frames: GifFrame[]): Buffer {
  const encoder = new GifEncoder();
  for (const frame of frames)
    encoder.addFrame(frame);
  return encoder.finish();
}

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

import fs from 'fs';

import { test, expect } from './fixtures';
import { encodeGif } from '../../packages/playwright-core/src/tools/backend/gifEncoder';

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

type ParsedFrame = { width: number, height: number, delayCs: number, pixels: number[] };

function lzwDecode(data: Buffer, minCodeSize: number, pixelCount: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out: number[] = [];
  let dict: number[][] = [];
  let codeSize = minCodeSize + 1;
  let previous: number[] | undefined;
  let bits = 0;
  let bitCount = 0;
  let pos = 0;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++)
      dict[i] = [i];
    dict[clearCode] = [];
    dict[endCode] = [];
    codeSize = minCodeSize + 1;
    previous = undefined;
  };
  reset();
  while (true) {
    while (bitCount < codeSize) {
      if (pos >= data.length)
        throw new Error('Unexpected end of LZW data');
      bits |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    bitCount -= codeSize;
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === endCode)
      break;
    let entry: number[];
    if (code < dict.length)
      entry = dict[code];
    else if (code === dict.length && previous)
      entry = [...previous, previous[0]];
    else
      throw new Error(`Invalid LZW code ${code}`);
    out.push(...entry);
    if (previous && dict.length < 4096)
      dict.push([...previous, entry[0]]);
    if (dict.length === (1 << codeSize) && codeSize < 12)
      codeSize++;
    previous = entry;
  }
  expect(out.length).toBe(pixelCount);
  return out;
}

function parseGif(buffer: Buffer): { width: number, height: number, palette: Buffer, loops: boolean, frames: ParsedFrame[] } {
  expect(buffer.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  expect(packed & 0x80).toBeTruthy();
  const paletteSize = 3 * (1 << ((packed & 7) + 1));
  const palette = buffer.subarray(13, 13 + paletteSize);
  let pos = 13 + paletteSize;
  let loops = false;
  let delayCs = 0;
  const frames: ParsedFrame[] = [];
  const readSubBlocks = () => {
    const chunks: Buffer[] = [];
    while (buffer[pos] !== 0) {
      chunks.push(buffer.subarray(pos + 1, pos + 1 + buffer[pos]));
      pos += buffer[pos] + 1;
    }
    pos++;
    return Buffer.concat(chunks);
  };
  while (pos < buffer.length) {
    const block = buffer[pos++];
    if (block === 0x3b)
      return { width, height, palette, loops, frames };
    if (block === 0x21) {
      const label = buffer[pos++];
      if (label === 0xff && buffer.subarray(pos + 1, pos + 12).toString('ascii') === 'NETSCAPE2.0')
        loops = true;
      if (label === 0xf9)
        delayCs = buffer.readUInt16LE(pos + 2);
      readSubBlocks();
      continue;
    }
    expect(block).toBe(0x2c);
    const frameWidth = buffer.readUInt16LE(pos + 4);
    const frameHeight = buffer.readUInt16LE(pos + 6);
    expect(buffer[pos + 8] & 0x80).toBe(0);
    pos += 9;
    const minCodeSize = buffer[pos++];
    const pixels = lzwDecode(readSubBlocks(), minCodeSize, frameWidth * frameHeight);
    frames.push({ width: frameWidth, height: frameHeight, delayCs, pixels });
  }
  throw new Error('Missing GIF trailer');
}

function solidFrame(width: number, height: number, rgb: [number, number, number], delayMs: number) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++)
    rgba.set([...rgb, 255], i * 4);
  return { width, height, rgba, delayMs };
}

test('encodeGif writes a looping 2-frame GIF', async () => {
  const gif = encodeGif([
    solidFrame(4, 4, [255, 0, 0], 200),
    solidFrame(4, 4, [0, 0, 255], 300),
  ]);
  const parsed = parseGif(gif);
  expect(parsed.loops).toBe(true);
  expect(parsed.width).toBe(4);
  expect(parsed.height).toBe(4);
  expect(parsed.frames.map(f => f.delayCs)).toEqual([20, 30]);
  const colorOf = (index: number) => [...parsed.palette.subarray(index * 3, index * 3 + 3)];
  expect(parsed.frames[0].pixels.map(colorOf)).toEqual(new Array(16).fill([255, 0, 0]));
  expect(parsed.frames[1].pixels.map(colorOf)).toEqual(new Array(16).fill([0, 0, 255]));
});

test('encodeGif round-trips noise through LZW table resets', async () => {
  const width = 128;
  const height = 96;
  const rgba = Buffer.alloc(width * height * 4);
  let seed = 7;
  for (let i = 0; i < rgba.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba[i] = seed >> 16;
  }
  const parsed = parseGif(encodeGif([{ width, height, rgba, delayMs: 100 }]));
  const pixels = parsed.frames[0].pixels;
  let maxDistance = 0;
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = parsed.palette.subarray(pixels[i] * 3, pixels[i] * 3 + 3);
    const distance = (r - rgba[i * 4]) ** 2 + (g - rgba[i * 4 + 1]) ** 2 + (b - rgba[i * 4 + 2]) ** 2;
    // Never worse than the nearest color of the 6x7x6 cube.
    maxDistance = Math.max(maxDistance, distance);
  }
  expect(maxDistance).toBeLessThanOrEqual(26 ** 2 + 22 ** 2 + 26 ** 2);
});

test('browser_start_gif and browser_stop_gif record an animated GIF', async ({ client, server }, testInfo) => {
  server.setContent('/', `
    <title>Colors</title>
    <body style="margin: 0; background: red">
    <script>
      const colors = ['red', 'lime', 'blue', 'yellow'];
      let i = 0;
      setInterval(() => document.body.style.background = colors[++i % colors.length], 150);
    </script>
    </body>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const start = await client.callTool({ name: 'browser_start_gif', arguments: { intervalMs: 100, maxWidth: 200 } });
  expect(start.isError).toBeFalsy();
  expect(allText(start)).toContain('GIF recording started');

  const again = await client.callTool({ name: 'browser_start_gif', arguments: {} });
  expect(again.isError).toBe(true);
  expect(allText(again)).toContain('already running');

  await new Promise(f => setTimeout(f, 1500));

  const stop = await client.callTool({ name: 'browser_stop_gif', arguments: { filename: 'recording.gif' } });
  expect(stop.isError).toBeFalsy();
  const text = allText(stop);
  expect(text).toContain('recording.gif');
  expect(text).toMatch(/Recorded \d+ frames over \d+\.\ds\./);

  const gif = await fs.promises.readFile(testInfo.outputPath('recording.gif'));
  expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  expect(gif.includes(Buffer.from('NETSCAPE2.0', 'ascii'))).toBe(true);
  const parsed = parseGif(gif);
  expect(parsed.loops).toBe(true);
  expect(parsed.width).toBe(200);
  expect(parsed.frames.length).toBeGreaterThan(1);
  for (const frame of parsed.frames)
    expect(frame.width).toBeLessThanOrEqual(200);
});

test('browser_stop_gif without a recording', async ({ client }) => {
  const result = await client.callTool({ name: 'browser_stop_gif', arguments: {} });
  expect(result.isError).toBe(true);
  expect(allText(result)).toContain('No GIF recording is running');
});

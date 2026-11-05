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

import jpegjs from 'jpeg-js';
import * as z from 'zod';

import { defineTool } from './tool';
import { GifEncoder } from './gifEncoder';

import type { Tab } from './tab';

const kMaxFrames = 300;

type CapturedFrame = {
  // Frames are kept as JPEG and decoded only when the GIF is written, to keep memory low.
  jpeg: Buffer;
  time: number;
};

export class GifRecorder {
  readonly tab: Tab;
  readonly intervalMs: number;
  readonly maxWidth: number;
  readonly startTime: number;
  private _frames: CapturedFrame[] = [];
  private _timer: NodeJS.Timeout | undefined;
  private _pendingCapture: Promise<void> | undefined;
  private _limitReached = false;
  private _stopped = false;

  constructor(tab: Tab, options: { intervalMs: number, maxWidth: number }) {
    this.tab = tab;
    this.intervalMs = options.intervalMs;
    this.maxWidth = options.maxWidth;
    this.startTime = Date.now();
  }

  async start() {
    await this._tick();
    this._timer = setInterval(() => void this._tick(), this.intervalMs);
  }

  private _tick(): Promise<void> {
    // Skip this tick when the previous capture is still running.
    if (this._stopped || this._pendingCapture)
      return this._pendingCapture ?? Promise.resolve();
    if (this._frames.length >= kMaxFrames) {
      this._limitReached = true;
      return Promise.resolve();
    }
    this._pendingCapture = this._capture().finally(() => this._pendingCapture = undefined);
    return this._pendingCapture;
  }

  private async _capture() {
    const page = this.tab.page;
    if (page.isClosed())
      return;
    const time = Date.now();
    // The page may close or navigate while the screenshot is taken, skip the frame then.
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 80, scale: 'css' }).catch(() => undefined);
    if (!jpeg || this._stopped)
      return;
    const last = this._frames[this._frames.length - 1];
    // An identical frame extends the delay of the previous frame.
    if (last && last.jpeg.equals(jpeg))
      return;
    this._frames.push({ jpeg, time });
  }

  async stop(): Promise<{ frames: CapturedFrame[], endTime: number, limitReached: boolean }> {
    if (this._timer)
      clearInterval(this._timer);
    this._timer = undefined;
    await this._pendingCapture;
    // Capture the final state of the page, unless the frame limit is reached.
    if (!this._stopped)
      await this._tick();
    this._stopped = true;
    return { frames: this._frames, endTime: Date.now(), limitReached: this._limitReached };
  }

  async dispose() {
    this._stopped = true;
    if (this._timer)
      clearInterval(this._timer);
    this._timer = undefined;
    await this._pendingCapture;
  }
}

function downscale(width: number, height: number, rgba: Uint8Array, maxWidth: number): { width: number, height: number, rgba: Uint8Array } {
  if (width <= maxWidth)
    return { width, height, rgba };
  const scale = maxWidth / width;
  const outWidth = maxWidth;
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outWidth * outHeight * 4);
  // Box filter: every output pixel is the average of the source pixels that it covers.
  for (let y = 0; y < outHeight; y++) {
    const y0 = Math.floor(y * height / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const x0 = Math.floor(x * width / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / outWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * width + sx) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = 255;
    }
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

function encodeFrames(frames: CapturedFrame[], endTime: number, maxWidth: number): Buffer {
  const encoder = new GifEncoder();
  for (let i = 0; i < frames.length; i++) {
    const nextTime = i + 1 < frames.length ? frames[i + 1].time : endTime;
    const decoded = jpegjs.decode(frames[i].jpeg, { useTArray: true, formatAsRGBA: true });
    const scaled = downscale(decoded.width, decoded.height, decoded.data, maxWidth);
    encoder.addFrame({ ...scaled, delayMs: nextTime - frames[i].time });
  }
  return encoder.finish();
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const startGif = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_start_gif',
    title: 'Start GIF recording',
    description: 'Start recording the current tab as an animated GIF. Viewport screenshots are taken on an interval until browser_stop_gif is called.',
    inputSchema: z.object({
      intervalMs: z.number().min(100).default(500).describe('Time between frames in milliseconds. Defaults to 500, minimum 100.'),
      maxWidth: z.number().min(1).default(800).describe('Frames wider than this are scaled down to this width in pixels. Defaults to 800.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    if (context.gifRecording)
      throw new Error('A GIF recording is already running. Call browser_stop_gif first.');
    const tab = await context.ensureTab();
    const recorder = new GifRecorder(tab, { intervalMs: params.intervalMs, maxWidth: Math.round(params.maxWidth) });
    context.gifRecording = recorder;
    await recorder.start();
    response.addTextResult(`GIF recording started, one frame every ${params.intervalMs}ms, up to ${kMaxFrames} frames.`);
  },
});

const stopGif = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_stop_gif',
    title: 'Stop GIF recording',
    description: 'Stop the GIF recording started with browser_start_gif and save it as an animated GIF file.',
    inputSchema: z.object({
      filename: z.string().optional().describe('File name to save the GIF to. Relative file names are resolved against the workspace root. If not specified, the GIF is saved into the output directory as `recording-{timestamp}.gif`.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const recorder = context.gifRecording;
    if (!recorder)
      throw new Error('No GIF recording is running. Call browser_start_gif first.');
    context.gifRecording = undefined;
    const { frames, endTime, limitReached } = await recorder.stop();
    if (!frames.length)
      throw new Error('No frames were captured, the page was closed during the recording.');
    const data = encodeFrames(frames, endTime, recorder.maxWidth);
    const resolvedFile = await response.resolveClientOutputFile({ prefix: 'recording', ext: 'gif', suggestedFilename: params.filename }, 'GIF recording');
    await response.addFileResult(resolvedFile, data);
    response.addTextResult(`Recorded ${frames.length} frame${frames.length === 1 ? '' : 's'} over ${formatDuration(endTime - recorder.startTime)}.`);
    if (limitReached)
      response.addTextResult(`The recording reached the limit of ${kMaxFrames} frames, later changes were not captured.`);
  },
});

export default [
  startGif,
  stopGif,
];

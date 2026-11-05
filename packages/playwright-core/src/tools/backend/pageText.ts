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

import * as z from 'zod';

import { defineTabTool } from './tool';

const getText = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_get_text',
    title: 'Get page text',
    description: 'Get the readable text of the current page: the main article or main region when the page has one, otherwise the whole body. Use it to read content; use browser_snapshot to find elements to act on.',
    inputSchema: z.object({
      maxChars: z.number().int().positive().optional().describe('Maximum number of characters to return. Defaults to 50000.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const maxChars = params.maxChars ?? 50000;
    const { title, url, source, text } = await tab.page.evaluate(() => {
      const candidates = ['article', 'main', '[role="main"]'];
      let root: HTMLElement = document.body;
      let source = 'body';
      for (const selector of candidates) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element && element.innerText.trim().length > 200) {
          root = element;
          source = selector;
          break;
        }
      }
      return { title: document.title, url: location.href, source, text: root?.innerText ?? '' };
    });
    const normalized = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = normalized.length > maxChars;
    const lines = [
      `Title: ${title}`,
      `URL: ${url}`,
      `Source: ${source}`,
      '',
      truncated ? normalized.slice(0, maxChars) : normalized,
    ];
    if (truncated)
      lines.push('', `[Truncated: ${normalized.length - maxChars} more characters. Pass a larger maxChars to read more.]`);
    response.addTextResult(lines.join('\n'));
  },
});

const zoom = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_zoom',
    title: 'Zoom into a region',
    description: 'Take a high-resolution screenshot of a rectangular region of the viewport, to read small text or inspect small icons. Coordinates are CSS pixels, the same frame as browser_take_screenshot.',
    inputSchema: z.object({
      x0: z.number().describe('Left edge of the region.'),
      y0: z.number().describe('Top edge of the region.'),
      x1: z.number().describe('Right edge of the region.'),
      y1: z.number().describe('Bottom edge of the region.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const width = params.x1 - params.x0;
    const height = params.y1 - params.y0;
    if (width <= 0 || height <= 0)
      throw new Error('The region must have x1 > x0 and y1 > y0.');
    const clip = { x: params.x0, y: params.y0, width, height };
    const data = await tab.page.screenshot({ type: 'png', clip, scale: 'device', ...tab.actionTimeoutOptions });
    response.addTextResult(`Zoomed region (${params.x0}, ${params.y0}) to (${params.x1}, ${params.y1}), ${width}x${height} CSS pixels.`);
    await response.registerImageResult(data, 'png');
  },
});

export default [
  getText,
  zoom,
];

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
import path from 'path';

import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';
import { defineTabTool } from './tool';
import { optionalElementSchema } from './snapshot';

const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

type PastePayload = {
  base64: string;
  name: string;
  type: string;
  mode: 'paste' | 'drop';
};

type PasteResult = {
  description: string;
  defaultPrevented: boolean;
};

// Runs in the page: builds a File from the bytes and dispatches the paste or drop events.
function dispatchImage(element: Element, payload: PastePayload): PasteResult {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], payload.name, { type: payload.type });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  let defaultPrevented = false;
  if (payload.mode === 'paste') {
    (element as HTMLElement).focus?.();
    const event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true, composed: true });
    element.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
  } else {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { dataTransfer, clientX, clientY, bubbles: true, cancelable: true, composed: true });
      element.dispatchEvent(event);
      if (type === 'drop')
        defaultPrevented = event.defaultPrevented;
    }
  }

  let description = element.tagName.toLowerCase();
  if (element.id)
    description += `#${element.id}`;
  return { description, defaultPrevented };
}

const pasteImage = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_paste_image',
    title: 'Paste or drop an image',
    description: 'Paste an image into an element, or drop it onto an element, the way a user pastes from the clipboard or drags a file in. Use it for chat boxes, editors and post composers that accept pasted or dropped images. Without a target, the image is pasted into the focused element.',
    inputSchema: optionalElementSchema.extend({
      filename: z.string().describe('Path of the PNG, JPEG, GIF or WebP image to paste.'),
      mode: z.enum(['paste', 'drop']).optional().describe('"paste" dispatches a paste event with the image on the clipboard; "drop" dispatches dragenter, dragover and drop events at the center of the element. Defaults to "paste".'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const mode = params.mode ?? 'paste';
    const extension = path.extname(params.filename).toLowerCase();
    const mimeType = imageMimeTypes[extension];
    if (!mimeType)
      throw new Error(`Unsupported image type "${extension || params.filename}". Supported extensions: ${Object.keys(imageMimeTypes).join(', ')}.`);

    response.setIncludeSnapshot();
    const fileName = await response.resolveClientFilename(params.filename);
    const data = await fs.promises.readFile(fileName);
    const target = params.target ? await tab.targetLocator({ element: params.element, target: params.target }) : null;

    const payload: PastePayload = { base64: data.toString('base64'), name: path.basename(fileName), type: mimeType, mode };
    let result: PasteResult | undefined;
    await tab.waitForCompletion(async () => {
      if (target) {
        result = await target.locator.evaluate(dispatchImage, payload, tab.actionTimeoutOptions);
        return;
      }
      const focused = await tab.page.evaluateHandle(() => document.activeElement ?? document.body);
      try {
        result = await focused.evaluate(dispatchImage, payload);
      } finally {
        focused.dispose().catch(() => {});
      }
    });
    if (!result)
      return;

    const where = target ? target.resolved : `the focused element <${result.description}>`;
    const verb = mode === 'paste' ? 'Pasted' : 'Dropped';
    const preposition = mode === 'paste' ? 'into' : 'onto';
    response.addTextResult(`${verb} ${payload.name} (${mimeType}, ${data.length} bytes) ${preposition} ${where}.`);
    if (!result.defaultPrevented)
      response.addTextResult(`The page did not call preventDefault() on the ${mode} event, so it may have ignored the image.`);

    if (mode === 'paste') {
      response.addCode(`// Paste ${payload.name} into ${target ? target.resolved : 'the focused element'}: dispatch a ClipboardEvent('paste') whose clipboardData holds the image as a File`);
      if (target)
        response.addCode(`await page.${target.resolved}.focus();`);
    } else if (target) {
      response.addCode(`await page.${target.resolved}.drop(${formatObject({ files: fileName })});`);
    } else {
      response.addCode(`// Drop ${payload.name} onto the focused element: dispatch dragenter, dragover and drop events whose dataTransfer holds the image as a File`);
    }
  },
});

export default [
  pasteImage,
];

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

// A 1x1 transparent PNG.
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const pageContent = `
  <div id="editor" contenteditable
       onpaste="event.preventDefault(); const f = event.clipboardData.files[0]; document.getElementById('out').textContent = 'paste:' + f.name + ':' + f.type + ':' + f.size">Message</div>
  <div id="zone" style="width: 200px; height: 100px; border: 1px solid black"
       ondragover="event.preventDefault()"
       ondrop="event.preventDefault(); const f = event.dataTransfer.files[0]; document.getElementById('out').textContent = 'drop:' + f.name + ':' + f.type + ':' + f.size">Drop here</div>
  <div id="out"></div>
`;

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

async function readOutput(client: any): Promise<string> {
  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => document.getElementById('out').textContent` },
  });
  return allText(result);
}

test('browser_paste_image pastes into the focused element', async ({ client, server }, testInfo) => {
  server.setContent('/', pageContent, 'text/html');
  const filename = testInfo.outputPath('tiny.png');
  await fs.promises.writeFile(filename, tinyPng);

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => document.getElementById('editor').focus()` } });

  const result = await client.callTool({
    name: 'browser_paste_image',
    arguments: { filename },
  });
  expect(result.isError).toBeFalsy();
  const text = allText(result);
  expect(text).toContain(`Pasted tiny.png (image/png, ${tinyPng.length} bytes) into the focused element <div#editor>.`);
  expect(text).toContain(`ClipboardEvent('paste')`);
  expect(await readOutput(client)).toContain(`paste:tiny.png:image/png:${tinyPng.length}`);
});

test('browser_paste_image drops onto a target', async ({ client, server }, testInfo) => {
  server.setContent('/', pageContent, 'text/html');
  const filename = testInfo.outputPath('tiny.png');
  await fs.promises.writeFile(filename, tinyPng);

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_paste_image',
    arguments: { filename, target: '#zone', element: 'Drop zone', mode: 'drop' },
  });
  expect(result.isError).toBeFalsy();
  const text = allText(result);
  expect(text).toContain(`Dropped tiny.png (image/png, ${tinyPng.length} bytes) onto`);
  expect(text).toContain(`.drop(`);
  expect(text).not.toContain('did not call preventDefault()');
  expect(await readOutput(client)).toContain(`drop:tiny.png:image/png:${tinyPng.length}`);
});

test('browser_paste_image rejects unsupported image types', async ({ client, server }, testInfo) => {
  server.setContent('/', pageContent, 'text/html');
  const filename = testInfo.outputPath('image.bmp');
  await fs.promises.writeFile(filename, tinyPng);

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_paste_image',
    arguments: { filename },
  });
  expect(result.isError).toBe(true);
  expect(allText(result)).toContain('Unsupported image type ".bmp". Supported extensions: .png, .jpg, .jpeg, .gif, .webp.');
});

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

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

test('browser_batch runs steps in order', async ({ client, server }) => {
  server.setContent('/', `
    <title>Form</title>
    <input aria-label="Name" oninput="document.getElementById('out').textContent = this.value">
    <div id="out"></div>
  `, 'text/html');

  const result = await client.callTool({
    name: 'browser_batch',
    arguments: {
      actions: [
        { name: 'browser_navigate', arguments: { url: server.PREFIX } },
        { name: 'browser_evaluate', arguments: { function: `() => { const i = document.querySelector('input'); i.value = 'Ada'; i.dispatchEvent(new Event('input')); }` } },
        { name: 'browser_evaluate', arguments: { function: `() => document.getElementById('out').textContent` } },
      ],
    },
  });
  expect(result.isError).toBeFalsy();
  const text = allText(result);
  expect(text).toContain('## Step 1 of 3: browser_navigate');
  expect(text).toContain('## Step 3 of 3: browser_evaluate');
  expect(text).toContain('"Ada"');
});

test('browser_batch stops at the first error', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_batch',
    arguments: {
      actions: [
        { name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
        { name: 'no_such_tool' },
        { name: 'browser_evaluate', arguments: { function: '() => 1' } },
      ],
    },
  });
  expect(result.isError).toBe(true);
  const text = allText(result);
  expect(text).toContain('Tool "no_such_tool" not found');
  expect(text).toContain('Stopped after step 2; 1 step(s) not run.');
  expect(text).not.toContain('Step 3 of 3');
});

test('browser_batch refuses nested batches', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_batch',
    arguments: { actions: [{ name: 'browser_batch', arguments: { actions: [] } }] },
  });
  expect(result.isError).toBe(true);
  expect(allText(result)).toContain('browser_batch cannot run inside a batch or shortcut.');
});

test('browser_get_text reads the main region', async ({ client, server }) => {
  const article = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
  server.setContent('/', `
    <title>News</title>
    <nav>Home About Contact</nav>
    <main><h1>Headline</h1><p>${article}</p></main>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const text = allText(await client.callTool({ name: 'browser_get_text', arguments: {} }));
  expect(text).toContain('Title: News');
  expect(text).toContain('Source: main');
  expect(text).toContain('Headline');
  expect(text).not.toContain('Home About Contact');

  const truncated = allText(await client.callTool({ name: 'browser_get_text', arguments: { maxChars: 20 } }));
  expect(truncated).toContain('[Truncated:');
});

test('browser_zoom returns an image of the region', async ({ client, server }) => {
  server.setContent('/', `<body style="margin:0"><div style="width:100px;height:50px;background:red"></div></body>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({ name: 'browser_zoom', arguments: { x0: 0, y0: 0, x1: 100, y1: 50 } });
  expect(allText(result)).toContain('100x50 CSS pixels');
  expect(result.content.some((c: any) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);

  const bad = await client.callTool({ name: 'browser_zoom', arguments: { x0: 10, y0: 10, x1: 5, y1: 20 } });
  expect(bad.isError).toBe(true);
});

test('browser shortcuts save, list, run and delete', async ({ startClient, server }, testInfo) => {
  const file = testInfo.outputPath('shortcuts.json');
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_SHORTCUTS_FILE: file } });

  const saved = await client.callTool({
    name: 'browser_shortcut_save',
    arguments: {
      name: 'open-hello',
      description: 'Open the hello page and read its title',
      actions: [
        { name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
        { name: 'browser_evaluate', arguments: { function: '() => document.title' } },
      ],
    },
  });
  expect(allText(saved)).toContain('Saved shortcut "open-hello" with 2 step(s)');
  expect(JSON.parse(await fs.promises.readFile(file, 'utf-8'))['open-hello'].actions).toHaveLength(2);

  const listed = allText(await client.callTool({ name: 'browser_shortcut_list', arguments: {} }));
  expect(listed).toContain('- open-hello: Open the hello page and read its title');

  const run = await client.callTool({ name: 'browser_shortcut_run', arguments: { name: 'open-hello' } });
  expect(run.isError).toBeFalsy();
  expect(allText(run)).toContain('"Title"');

  const missing = await client.callTool({ name: 'browser_shortcut_run', arguments: { name: 'nope' } });
  expect(missing.isError).toBe(true);

  expect(allText(await client.callTool({ name: 'browser_shortcut_delete', arguments: { name: 'open-hello' } }))).toContain('Deleted shortcut "open-hello".');
  expect(allText(await client.callTool({ name: 'browser_shortcut_list', arguments: {} }))).toContain('No shortcuts saved yet.');
});

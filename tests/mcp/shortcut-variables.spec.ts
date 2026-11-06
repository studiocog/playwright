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

test('browser shortcuts with variables', async ({ startClient, server }, testInfo) => {
  const file = testInfo.outputPath('shortcuts.json');
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_SHORTCUTS_FILE: file } });

  const actions = [
    { name: 'browser_navigate', arguments: { url: '{{base}}/hello-world' } },
    { name: 'browser_evaluate', arguments: { function: `() => '{{greeting}}, ' + document.title` } },
  ];

  const rejected = await client.callTool({
    name: 'browser_shortcut_save',
    arguments: { name: 'greet', actions, variables: { other: 'Not used by any action' } },
  });
  expect(rejected.isError).toBe(true);
  expect(allText(rejected)).toContain('No action uses the documented variable(s): other.');

  const saved = await client.callTool({
    name: 'browser_shortcut_save',
    arguments: { name: 'greet', description: 'Greet the page', actions, variables: { base: 'Server origin' } },
  });
  expect(allText(saved)).toContain('Saved shortcut "greet" with 2 step(s) and variable(s) base, greeting');
  expect(JSON.parse(await fs.promises.readFile(file, 'utf-8'))['greet'].variables).toEqual(['base', 'greeting']);

  const listed = allText(await client.callTool({ name: 'browser_shortcut_list', arguments: {} }));
  expect(listed).toContain('- {{base}}: Server origin');
  expect(listed).toContain('- {{greeting}}');

  const run = await client.callTool({
    name: 'browser_shortcut_run',
    arguments: { name: 'greet', variables: { base: server.PREFIX, greeting: 'Hello', extra: 'x' } },
  });
  expect(run.isError).toBeFalsy();
  const runText = allText(run);
  expect(runText).toContain('"Hello, Title"');
  expect(runText).toContain('Ignored variable(s) the shortcut does not use: extra.');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.EMPTY_PAGE } });
  const missing = await client.callTool({ name: 'browser_shortcut_run', arguments: { name: 'greet', variables: { greeting: 'Hi' } } });
  expect(missing.isError).toBe(true);
  expect(allText(missing)).toContain('missing variable(s): base.');
  expect(allText(missing)).not.toContain('Step 1');
  const url = allText(await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => location.href' } }));
  expect(url).toContain(server.EMPTY_PAGE);
});

test('browser shortcuts saved without variables still run', async ({ startClient, server }, testInfo) => {
  const file = testInfo.outputPath('shortcuts.json');
  await fs.promises.writeFile(file, JSON.stringify({
    old: { actions: [{ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } }] },
  }));
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_SHORTCUTS_FILE: file } });

  expect(allText(await client.callTool({ name: 'browser_shortcut_list', arguments: {} }))).toContain('- old');
  const run = await client.callTool({ name: 'browser_shortcut_run', arguments: { name: 'old' } });
  expect(run.isError).toBeFalsy();
  expect(allText(run)).toContain('## Step 1 of 1: browser_navigate');
});

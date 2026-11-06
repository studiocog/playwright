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

const formPage = `
  <title>Form</title>
  <input aria-label="Message">
  <button onclick="document.getElementById('out').textContent = 'Sent: ' + document.querySelector('input').value">Send</button>
  <div id="out"></div>
`;

test('record a shortcut and run it with a new value', async ({ startClient, server }, testInfo) => {
  const file = testInfo.outputPath('shortcuts.json');
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_SHORTCUTS_FILE: file } });
  server.setContent('/form.html', formPage, 'text/html');
  const url = server.PREFIX + '/form.html';
  await client.callTool({ name: 'browser_navigate', arguments: { url } });

  expect(allText(await client.callTool({ name: 'browser_shortcut_record_start', arguments: {} }))).toContain('Recording started.');

  // The user's actions are simulated with input tools, which the recorder captures like real input.
  await client.callTool({ name: 'browser_type', arguments: { element: 'Message textbox', target: `getByRole('textbox', { name: 'Message' })`, text: 'Hello world' } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'Send button', target: `getByRole('button', { name: 'Send' })` } });

  const stopped = await client.callTool({
    name: 'browser_shortcut_record_stop',
    arguments: { name: 'send-message', description: 'Send a message', variables: { 'Hello world': 'text' } },
  });
  expect(stopped.isError).toBeFalsy();
  const stoppedText = allText(stopped);
  expect(stoppedText).toContain('Saved shortcut "send-message" with 3 step(s) and variable(s) text');
  expect(stoppedText).toContain('"text":"{{text}}"');

  const saved = JSON.parse(await fs.promises.readFile(file, 'utf-8'))['send-message'];
  expect(saved.description).toBe('Send a message');
  expect(saved.variables).toEqual(['text']);
  expect(saved.actions.map((action: any) => action.name)).toEqual(['browser_navigate', 'browser_type', 'browser_click']);
  expect(saved.actions[0].arguments).toEqual({ url });
  expect(saved.actions[1].arguments).toEqual(expect.objectContaining({ text: '{{text}}' }));
  // Targets are locators, not snapshot refs, so that they work on a fresh page.
  expect(saved.actions[1].arguments.target).toContain('getBy');
  expect(saved.actions[2].arguments.target).toContain('Send');

  await client.callTool({ name: 'browser_navigate', arguments: { url } });
  const run = await client.callTool({ name: 'browser_shortcut_run', arguments: { name: 'send-message', variables: { text: 'Goodbye' } } });
  expect(run.isError).toBeFalsy();
  const out = await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => document.getElementById('out').textContent` } });
  expect(allText(out)).toContain('Sent: Goodbye');
});

test('shortcut recording errors and empty recordings', async ({ startClient, server }, testInfo) => {
  const file = testInfo.outputPath('shortcuts.json');
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_SHORTCUTS_FILE: file } });
  server.setContent('/form.html', formPage, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/form.html' } });

  const notStarted = await client.callTool({ name: 'browser_shortcut_record_stop', arguments: { name: 'x' } });
  expect(notStarted.isError).toBe(true);
  expect(allText(notStarted)).toContain('No shortcut recording in progress');

  await client.callTool({ name: 'browser_shortcut_record_start', arguments: {} });
  const twice = await client.callTool({ name: 'browser_shortcut_record_start', arguments: {} });
  expect(twice.isError).toBe(true);
  expect(allText(twice)).toContain('Recording is already in progress');

  const empty = await client.callTool({ name: 'browser_shortcut_record_stop', arguments: { name: 'empty' } });
  expect(allText(empty)).toContain('No actions were recorded, so no shortcut was saved.');
  expect(fs.existsSync(file)).toBe(false);
});

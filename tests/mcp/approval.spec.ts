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

import { test, expect } from './fixtures';

import type { TestServer } from '../config/testserver';

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

function setPage(server: TestServer) {
  server.setContent('/', `
    <title>Mail</title>
    <script>window.clicks = [];</script>
    <button id="send" onclick="window.clicks.push('Send')">Send</button>
    <button id="next" onclick="window.clicks.push('Next')">Next</button>
  `, 'text/html');
}

const clicksFunction = `() => window.clicks.join(',') + ';' + !!document.querySelector('x-pw-approval')`;

test('approval gate times out when the user does not answer', async ({ startClient, server }) => {
  setPage(server);
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_APPROVAL_GATES: '1', PLAYWRIGHT_MCP_APPROVAL_TIMEOUT_MS: '1500' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const status = await client.callTool({ name: 'browser_approval_status', arguments: {} });
  expect(allText(status)).toContain('Approval gates: on');

  const next = await client.callTool({ name: 'browser_click', arguments: { element: 'Next', target: '#next' } });
  expect(next.isError).toBeFalsy();

  const send = await client.callTool({ name: 'browser_click', arguments: { element: 'Send', target: '#send' } });
  expect(send.isError).toBe(true);
  expect(allText(send)).toContain('The user did not answer the request to click: "Send"');

  // Steps inside a batch go through the same gate.
  const batch = await client.callTool({
    name: 'browser_batch',
    arguments: { actions: [{ name: 'browser_click', arguments: { target: '#send' } }] },
  });
  expect(batch.isError).toBe(true);
  expect(allText(batch)).toContain('did not answer');

  expect(await client.callTool({ name: 'browser_evaluate', arguments: { function: clicksFunction } })).toHaveResponse({
    result: '"Next;false"',
  });
});

test('approval gate runs the tool when the user allows it', async ({ startClient, server }) => {
  setPage(server);
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_APPROVAL_GATES: '1', PLAYWRIGHT_MCP_APPROVAL_TIMEOUT_MS: '5000', PWTEST_MCP_APPROVAL_ANSWER_FOR_TEST: 'allow' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const send = await client.callTool({ name: 'browser_click', arguments: { element: 'Send', target: '#send' } });
  expect(send.isError).toBeFalsy();
  expect(await client.callTool({ name: 'browser_evaluate', arguments: { function: clicksFunction } })).toHaveResponse({
    result: '"Send;false"',
  });
});

test('approval gate stops the tool when the user denies it', async ({ startClient, server }) => {
  setPage(server);
  const { client } = await startClient({ env: { PLAYWRIGHT_MCP_APPROVAL_GATES: '1', PLAYWRIGHT_MCP_APPROVAL_TIMEOUT_MS: '5000', PWTEST_MCP_APPROVAL_ANSWER_FOR_TEST: 'deny' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const send = await client.callTool({ name: 'browser_click', arguments: { element: 'Send', target: '#send' } });
  expect(send.isError).toBe(true);
  expect(allText(send)).toContain('The user denied the request to click: "Send"');
  expect(await client.callTool({ name: 'browser_evaluate', arguments: { function: clicksFunction } })).toHaveResponse({
    result: '";false"',
  });
});

test('approval gates are off by default', async ({ client, server }) => {
  setPage(server);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const status = await client.callTool({ name: 'browser_approval_status', arguments: {} });
  expect(allText(status)).toContain('Approval gates: off');

  const send = await client.callTool({ name: 'browser_click', arguments: { element: 'Send', target: '#send' } });
  expect(send.isError).toBeFalsy();
  expect(await client.callTool({ name: 'browser_evaluate', arguments: { function: clicksFunction } })).toHaveResponse({
    result: '"Send;false"',
  });
});

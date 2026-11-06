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

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

test('browser_snapshot_compact lists controls with usable refs and reports diffs', async ({ client, server }) => {
  server.setContent('/', `
    <title>Compact</title>
    <h1>Welcome</h1>
    <p>First paragraph of long text.</p>
    <p>Second paragraph of long text.</p>
    <a href="/other">Read more</a>
    <button onclick="document.getElementById('out').textContent = 'clicked'">Go</button>
    <input aria-label="Name">
    <div id="out"></div>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const interactive = allText(await client.callTool({ name: 'browser_snapshot_compact', arguments: {} }));
  expect(interactive).toContain(`Page URL: ${server.PREFIX}`);
  expect(interactive).toContain('Page Title: Compact');
  expect(interactive).toContain('# Welcome');
  expect(interactive).toMatch(/link "Read more" \[ref=e\d+\]/);
  expect(interactive).toMatch(/button "Go" \[ref=e\d+\]/);
  expect(interactive).toMatch(/textbox "Name" \[ref=e\d+\]/);
  expect(interactive).not.toContain('paragraph');
  expect(interactive).toMatch(/\[Compact snapshot: 4 lines \(3 interactive elements\) versus about \d+ lines in the full browser_snapshot\.\]/);

  const ref = interactive.match(/button "Go" \[ref=(e\d+)\]/)![1];
  const click = await client.callTool({ name: 'browser_click', arguments: { element: 'Go button', target: ref } });
  expect(click.isError).toBeFalsy();
  expect(await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => document.getElementById('out').textContent` } })).toHaveResponse({
    result: '"clicked"',
  });

  await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => { const b = document.createElement('button'); b.textContent = 'Added'; document.body.appendChild(b); }` } });
  const diff = allText(await client.callTool({ name: 'browser_snapshot_compact', arguments: { mode: 'diff' } }));
  expect(diff).toMatch(/^\+ button "Added" \[ref=e\d+\]$/m);
  expect(diff).not.toMatch(/^[-~] /m);
  expect(diff.match(/^\+ /gm)).toHaveLength(1);

  const again = allText(await client.callTool({ name: 'browser_snapshot_compact', arguments: { mode: 'diff' } }));
  expect(again).toContain('No changes');
});

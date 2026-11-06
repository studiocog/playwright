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

// The JSON output is pretty-printed, so the top-level array opens with "[" and closes with "]" on their own lines.
function jsonOutput(result: any): any {
  const text = allText(result);
  const start = text.indexOf('\n[\n');
  const end = text.indexOf('\n]', start);
  return JSON.parse(text.slice(start + 1, end + 2));
}

const pageContent = `
  <title>Shop</title>
  <table id="prices">
    <caption>Prices</caption>
    <thead><tr><th>Name</th><th>Price</th><th></th><th>Price</th></tr></thead>
    <tbody>
      <tr><td>Apple</td><td>1</td><td>x</td><td>2</td></tr>
      <tr><td colspan="2">Merged</td><td>y</td><td>3</td></tr>
    </tbody>
  </table>
  <table id="single"><tr><td>Only one row</td></tr></table>
  <div class="card"><h3>Widget, "Pro"</h3><span class="price">$10</span><a href="/p/1">View</a></div>
  <div class="card"><h3>Gadget</h3><span class="price">$20</span><a href="/p/2">View</a></div>
  <div class="card"><h3>Gizmo</h3><a href="/p/3">View</a></div>
`;

const productFields = {
  name: { selector: 'h3' },
  price: { selector: '.price' },
  link: { selector: 'a', attribute: 'href' },
};

test.beforeEach(async ({ client, server }) => {
  server.setContent('/', pageContent, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
});

test('browser_extract reads tables as JSON', async ({ client }) => {
  const result = await client.callTool({ name: 'browser_extract', arguments: {} });
  expect(result.isError).toBeFalsy();
  const text = allText(result);
  expect(text).toContain('Found 1 table(s).');
  expect(text).toContain('Table 1 "Prices": 2 row(s). Columns: Name, Price, column_3, Price_2.');
  expect(jsonOutput(result)).toEqual([{
    table: 'Prices',
    rows: [
      { 'Name': 'Apple', 'Price': '1', 'column_3': 'x', 'Price_2': '2' },
      { 'Name': 'Merged', 'Price': 'Merged', 'column_3': 'y', 'Price_2': '3' },
    ],
  }]);
});

test('browser_extract reads a one-row table when tableSelector targets it', async ({ client }) => {
  const result = await client.callTool({ name: 'browser_extract', arguments: { tableSelector: '#single' } });
  expect(result.isError).toBeFalsy();
  expect(allText(result)).toContain('Table 1 "single": 0 row(s). Columns: Only one row.');
});

test('browser_extract reads items as JSON', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_extract',
    arguments: { mode: 'items', itemSelector: '.card', fields: productFields },
  });
  expect(result.isError).toBeFalsy();
  expect(allText(result)).toContain('Found 3 item(s) matching ".card". Fields: name, price, link.');
  expect(jsonOutput(result)).toEqual([
    { name: 'Widget, "Pro"', price: '$10', link: server.PREFIX + '/p/1' },
    { name: 'Gadget', price: '$20', link: server.PREFIX + '/p/2' },
    { name: 'Gizmo', price: null, link: server.PREFIX + '/p/3' },
  ]);
});

test('browser_extract quotes CSV fields', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_extract',
    arguments: { mode: 'items', itemSelector: '.card', fields: productFields, format: 'csv' },
  });
  expect(result.isError).toBeFalsy();
  expect(allText(result)).toContain([
    'name,price,link',
    `"Widget, ""Pro""",$10,${server.PREFIX}/p/1`,
    `Gadget,$20,${server.PREFIX}/p/2`,
    `Gizmo,,${server.PREFIX}/p/3`,
  ].join('\r\n'));
});

test('browser_extract saves to a file', async ({ client }, testInfo) => {
  const result = await client.callTool({
    name: 'browser_extract',
    arguments: { mode: 'items', itemSelector: '.card', fields: { name: { selector: 'h3' } }, format: 'csv', filename: 'products.csv' },
  });
  expect(result.isError).toBeFalsy();
  expect(allText(result)).toContain('products.csv');
  const csv = await fs.promises.readFile(testInfo.outputPath('products.csv'), 'utf-8');
  expect(csv).toBe('name\r\n"Widget, ""Pro"""\r\nGadget\r\nGizmo\r\n');
});

test('browser_extract notes when the limit truncates', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_extract',
    arguments: { mode: 'items', itemSelector: '.card', fields: productFields, limit: 2 },
  });
  expect(result.isError).toBeFalsy();
  expect(allText(result)).toContain('Returned the first 2 of 3 items. Pass a larger limit to get more.');
  expect(jsonOutput(result)).toHaveLength(2);
});

test('browser_extract requires itemSelector in items mode', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_extract',
    arguments: { mode: 'items', fields: productFields },
  });
  expect(result.isError).toBe(true);
  expect(allText(result)).toContain('itemSelector is required in "items" mode.');
});

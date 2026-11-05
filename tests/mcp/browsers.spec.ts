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

import { test, expect } from './fixtures';

const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';

function allText(result: any): string {
  return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}

async function createFakeBrowsers(root: string) {
  // Chrome: "Default" has a web store install, "Profile 2" has no extension.
  const chrome = path.join(root, 'chrome');
  await fs.promises.mkdir(path.join(chrome, 'Default', 'Extensions', extensionId), { recursive: true });
  await fs.promises.mkdir(path.join(chrome, 'Profile 2'), { recursive: true });
  await fs.promises.writeFile(path.join(chrome, 'Profile 2', 'Preferences'), JSON.stringify({ extensions: { settings: {} } }));
  await fs.promises.writeFile(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Default': { name: 'Work' }, 'Profile 2': { name: 'Home' } } } }));
  // Edge: "Profile 1" has a settings record only.
  const edge = path.join(root, 'msedge');
  await fs.promises.mkdir(path.join(edge, 'Profile 1'), { recursive: true });
  await fs.promises.writeFile(path.join(edge, 'Profile 1', 'Secure Preferences'), JSON.stringify({ extensions: { settings: { [extensionId]: { state: 1 } } } }));
}

test('browser_list_browsers lists profiles with the extension', async ({ startClient }) => {
  const root = test.info().outputPath('browsers');
  await createFakeBrowsers(root);
  const { client } = await startClient({ env: { PWTEST_BROWSER_LIST_ROOT_FOR_TEST: root } });

  const result = await client.callTool({ name: 'browser_list_browsers', arguments: {} });
  expect(result.isError).toBeFalsy();
  const text = allText(result);
  expect(text).toContain('- id: chrome:Default, browser: Google Chrome, profile directory: Default, profile name: Work');
  expect(text).toContain('- id: msedge:Profile 1, browser: Microsoft Edge, profile directory: Profile 1');
  expect(text).not.toContain('Profile 2');
  expect(text).toContain('Switching browsers needs extension mode: start the server with --extension.');
});

test('browser_switch_browser errors outside extension mode and for an unknown id', async ({ startClient }) => {
  const root = test.info().outputPath('browsers');
  await createFakeBrowsers(root);
  const { client } = await startClient({ env: { PWTEST_BROWSER_LIST_ROOT_FOR_TEST: root } });

  const unknown = await client.callTool({ name: 'browser_switch_browser', arguments: { id: 'chrome:Profile 9' } });
  expect(unknown.isError).toBe(true);
  expect(allText(unknown)).toContain('Unknown browser id "chrome:Profile 9". Call browser_list_browsers to see the available ids.');

  const known = await client.callTool({ name: 'browser_switch_browser', arguments: { id: 'chrome:Default' } });
  expect(known.isError).toBe(true);
  expect(allText(known)).toContain('browser_switch_browser needs extension mode. Start the server with --extension');
});

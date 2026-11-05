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
import { defaultUserDataDirForChannel } from '@utils/chromiumChannels';
import { isExtensionInstalledInProfile, listProfileDirectories, playwrightExtensionInstallUrl } from '../utils/extension';
import { defineTool } from './tool';

export const switchBrowserToolName = 'browser_switch_browser';
export const switchUnavailableMessage = 'Switching browsers is not available in this setup, for example with --shared-browser-context or a custom executable path.';

// A browser and profile to connect to in extension mode.
export type BrowserTarget = {
  channel: string;
  userDataDir?: string;
  profileDirName?: string;
};

export type InstalledBrowser = {
  id: string;
  channel: string;
  browserName: string;
  userDataDir: string;
  profileDirName: string;
  profileName?: string;
};

const channelNames = new Map<string, string>([
  ['chrome', 'Google Chrome'],
  ['chrome-beta', 'Google Chrome Beta'],
  ['chrome-dev', 'Google Chrome Dev'],
  ['chrome-canary', 'Google Chrome Canary'],
  ['msedge', 'Microsoft Edge'],
  ['msedge-beta', 'Microsoft Edge Beta'],
  ['msedge-dev', 'Microsoft Edge Dev'],
  ['msedge-canary', 'Microsoft Edge Canary'],
]);

function userDataDirForChannel(channel: string): string | undefined {
  // Tests point the scan at a fake folder with one user data dir per channel.
  const testRoot = process.env.PWTEST_BROWSER_LIST_ROOT_FOR_TEST;
  if (testRoot)
    return path.join(testRoot, channel);
  return defaultUserDataDirForChannel(channel);
}

// The connected browser may use a custom user data dir, so it is scanned as well.
export async function listInstalledBrowsers(connected?: BrowserTarget): Promise<InstalledBrowser[]> {
  const dirs: { channel: string, userDataDir: string }[] = [];
  for (const channel of channelNames.keys()) {
    const userDataDir = userDataDirForChannel(channel);
    if (userDataDir)
      dirs.push({ channel, userDataDir });
  }
  if (connected?.userDataDir && !dirs.some(dir => samePath(dir.userDataDir, connected.userDataDir!)))
    dirs.push({ channel: connected.channel, userDataDir: connected.userDataDir });

  const result: InstalledBrowser[] = [];
  for (const { channel, userDataDir } of dirs) {
    const profileNames = await readProfileNames(userDataDir);
    for (const profileDirName of await listProfileDirectories(userDataDir)) {
      if (!await isExtensionInstalledInProfile(path.join(userDataDir, profileDirName)))
        continue;
      result.push({
        id: `${channel}:${profileDirName}`,
        channel,
        browserName: channelNames.get(channel) ?? channel,
        userDataDir,
        profileDirName,
        profileName: profileNames[profileDirName],
      });
    }
  }
  return result;
}

export function isConnectedTo(browser: InstalledBrowser, connected: BrowserTarget | undefined): boolean {
  return !!connected?.userDataDir && browser.channel === connected.channel && samePath(browser.userDataDir, connected.userDataDir) && browser.profileDirName === connected.profileDirName;
}

export function describeBrowser(browser: InstalledBrowser): string {
  const profileName = browser.profileName ? ` (${browser.profileName})` : '';
  return `${browser.browserName}, profile "${browser.profileDirName}"${profileName}`;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

async function readProfileNames(userDataDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  try {
    const localState = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'Local State'), 'utf-8'));
    const infoCache = localState?.profile?.info_cache;
    for (const [profileDirName, info] of Object.entries<any>(infoCache ?? {})) {
      if (typeof info?.name === 'string' && info.name)
        result[profileDirName] = info.name;
    }
  } catch {
  }
  return result;
}

const listBrowsers = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_list_browsers',
    title: 'List browsers',
    description: 'List the installed Chrome and Edge browsers and profiles that have the Playwright extension, with the id to pass to browser_switch_browser. Switching needs the server to run with --extension.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const connected = context.options.connectedBrowser;
    const browsers = await listInstalledBrowsers(connected);
    const lines: string[] = [];
    if (!browsers.length)
      lines.push(`No Chrome or Edge profile with the Playwright extension was found. Install the extension from ${playwrightExtensionInstallUrl}.`);
    for (const browser of browsers) {
      const fields = [
        `id: ${browser.id}`,
        `browser: ${browser.browserName}`,
        `profile directory: ${browser.profileDirName}`,
      ];
      if (browser.profileName)
        fields.push(`profile name: ${browser.profileName}`);
      if (isConnectedTo(browser, connected))
        fields.push('connected');
      lines.push(`- ${fields.join(', ')}`);
    }
    if (!context.config.extension)
      lines.push('', 'Switching browsers needs extension mode: start the server with --extension.');
    else if (!context.options.canSwitchBrowser)
      lines.push('', switchUnavailableMessage);
    else if (connected && !browsers.some(browser => isConnectedTo(browser, connected)))
      lines.push('', `Connected to ${channelNames.get(connected.channel) ?? connected.channel}${connected.profileDirName ? `, profile "${connected.profileDirName}"` : ''}.`);
    response.addTextResult(lines.join('\n'));
  },
});

const switchBrowser = defineTool({
  capability: 'core',
  schema: {
    name: switchBrowserToolName,
    title: 'Switch browser',
    description: 'In extension mode, close the connection to the current browser and connect to another browser or profile from browser_list_browsers. The following tool calls act on the new browser.',
    inputSchema: z.object({
      id: z.string().describe('Id of the browser and profile, from browser_list_browsers. For example "chrome:Default".'),
    }),
    type: 'action',
  },

  handle: async () => {
    throw new Error('This tool is run by the browser backend.');
  },
});

export default [
  listBrowsers,
  switchBrowser,
];

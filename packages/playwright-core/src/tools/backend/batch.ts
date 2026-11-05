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
import os from 'os';
import path from 'path';

import * as z from 'zod';

import { defineTool } from './tool';

export const batchToolName = 'browser_batch';
export const shortcutRunToolName = 'browser_shortcut_run';

const batchActionSchema = z.object({
  name: z.string().describe('Name of the tool to call, for example "browser_click".'),
  arguments: z.record(z.string(), z.any()).optional().describe('Arguments for that tool, exactly as you would pass them when calling it directly.'),
});

export const batchActionsSchema = z.array(batchActionSchema).min(1).max(50);

export type BatchAction = z.output<typeof batchActionSchema>;

type Shortcut = {
  description?: string;
  actions: BatchAction[];
};

export function shortcutsFile(): string {
  return process.env.PLAYWRIGHT_MCP_SHORTCUTS_FILE || path.join(os.homedir(), '.playwright-mcp', 'shortcuts.json');
}

export async function readShortcuts(): Promise<Record<string, Shortcut>> {
  try {
    return JSON.parse(await fs.promises.readFile(shortcutsFile(), 'utf-8'));
  } catch (e: any) {
    if (e.code === 'ENOENT')
      return {};
    throw new Error(`Could not read shortcuts from ${shortcutsFile()}: ${e.message}`);
  }
}

async function writeShortcuts(shortcuts: Record<string, Shortcut>) {
  const file = shortcutsFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(shortcuts, null, 2), 'utf-8');
}

function handledByBackend(): never {
  throw new Error('This tool is run by the browser backend.');
}

const batch = defineTool({
  capability: 'core',
  schema: {
    name: batchToolName,
    title: 'Run several actions',
    description: 'Run a sequence of browser tool calls in one call, in order. Use it when you can predict two or more steps ahead, for example navigate, click a field, type, press Enter. Stops at the first step that fails unless stopOnError is false. Each step returns what that tool would return on its own.',
    inputSchema: z.object({
      actions: batchActionsSchema.describe('The tool calls to run, in order.'),
      stopOnError: z.boolean().optional().describe('Stop at the first step that fails. Defaults to true.'),
    }),
    type: 'action',
  },
  handle: async () => handledByBackend(),
});

const shortcutSave = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_shortcut_save',
    title: 'Save a shortcut',
    description: 'Save a named sequence of browser tool calls as a reusable shortcut, to run later with browser_shortcut_run. Saving under an existing name replaces it.',
    inputSchema: z.object({
      name: z.string().regex(/^[\w-]+$/).describe('Shortcut name: letters, digits, "_" and "-" only.'),
      description: z.string().optional().describe('What the shortcut does.'),
      actions: batchActionsSchema.describe('The tool calls the shortcut runs, in order.'),
    }),
    type: 'action',
  },
  handle: async (context, params, response) => {
    if (params.actions.some(action => action.name === batchToolName || action.name === shortcutRunToolName))
      throw new Error(`A shortcut cannot contain ${batchToolName} or ${shortcutRunToolName}.`);
    const shortcuts = await readShortcuts();
    const replaced = !!shortcuts[params.name];
    shortcuts[params.name] = { description: params.description, actions: params.actions };
    await writeShortcuts(shortcuts);
    response.addTextResult(`${replaced ? 'Replaced' : 'Saved'} shortcut "${params.name}" with ${params.actions.length} step(s) in ${shortcutsFile()}.`);
  },
});

const shortcutList = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_shortcut_list',
    title: 'List shortcuts',
    description: 'List the saved shortcuts with their descriptions and steps.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (context, params, response) => {
    const shortcuts = await readShortcuts();
    const names = Object.keys(shortcuts).sort();
    if (!names.length) {
      response.addTextResult('No shortcuts saved yet. Save one with browser_shortcut_save.');
      return;
    }
    const lines: string[] = [];
    for (const name of names) {
      const shortcut = shortcuts[name];
      lines.push(`- ${name}${shortcut.description ? `: ${shortcut.description}` : ''}`);
      for (const action of shortcut.actions)
        lines.push(`  - ${action.name} ${JSON.stringify(action.arguments ?? {})}`);
    }
    response.addTextResult(lines.join('\n'));
  },
});

const shortcutRun = defineTool({
  capability: 'core',
  schema: {
    name: shortcutRunToolName,
    title: 'Run a shortcut',
    description: 'Run a saved shortcut: its tool calls run in order, as with browser_batch.',
    inputSchema: z.object({
      name: z.string().describe('Name of the shortcut to run.'),
      stopOnError: z.boolean().optional().describe('Stop at the first step that fails. Defaults to true.'),
    }),
    type: 'action',
  },
  handle: async () => handledByBackend(),
});

const shortcutDelete = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_shortcut_delete',
    title: 'Delete a shortcut',
    description: 'Delete a saved shortcut.',
    inputSchema: z.object({
      name: z.string().describe('Name of the shortcut to delete.'),
    }),
    type: 'action',
  },
  handle: async (context, params, response) => {
    const shortcuts = await readShortcuts();
    if (!shortcuts[params.name])
      throw new Error(`Shortcut "${params.name}" not found.`);
    delete shortcuts[params.name];
    await writeShortcuts(shortcuts);
    response.addTextResult(`Deleted shortcut "${params.name}".`);
  },
});

export default [
  batch,
  shortcutSave,
  shortcutList,
  shortcutRun,
  shortcutDelete,
];

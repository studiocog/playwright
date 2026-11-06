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

import * as z from 'zod';

import { defineTabTool } from './tool';

import type { AriaNodeJSON, AriaSnapshotJSON } from '@isomorphic/ariaSnapshot';
import type { Tab } from './tab';

const interactiveRoles = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const landmarkRoles = new Set([
  'banner',
  'complementary',
  'contentinfo',
  'dialog',
  'form',
  'main',
  'navigation',
  'region',
  'search',
]);

type CompactLine = {
  // Stable identity of the line, used to match lines between two snapshots.
  key: string;
  text: string;
  isElement: boolean;
};

// The previous compact snapshot of each tab, for the diff mode.
const previousSnapshots = new WeakMap<Tab, CompactLine[]>();

const compactSnapshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot_compact',
    title: 'Compact page snapshot',
    description: 'Capture a compact list of the elements a user can act on (with refs usable as target in other tools) and the page headings, one line each. Costs far fewer tokens than browser_snapshot. Use mode "diff" to get only what changed since the previous compact snapshot of this tab.',
    inputSchema: z.object({
      mode: z.enum(['interactive', 'diff']).optional().describe('"interactive" (default) lists the interactive elements and headings. "diff" lists only the lines added (+), removed (-) or changed (~) since the previous compact snapshot of this tab.'),
      maxElements: z.number().int().positive().optional().describe('Maximum number of lines to return. Defaults to 300.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const mode = params.mode ?? 'interactive';
    const maxElements = params.maxElements ?? 300;
    const snapshot = await tab.page.ariaSnapshotJSON({ mode: 'ai' });
    const lines = compactLines(snapshot);
    const fullLineCount = countFullSnapshotLines(snapshot);
    const previous = previousSnapshots.get(tab);
    previousSnapshots.set(tab, lines);

    const result = [
      `Page URL: ${tab.page.url()}`,
      `Page Title: ${await tab.page.title()}`,
      '',
    ];

    let body: string[];
    if (mode === 'diff' && previous) {
      body = diffLines(previous, lines);
      if (!body.length)
        body = ['No changes'];
    } else {
      if (mode === 'diff')
        result.push('No previous compact snapshot of this tab, showing the full interactive list.', '');
      body = lines.map(line => line.text);
    }

    if (body.length > maxElements) {
      const leftOut = body.length - maxElements;
      body = body.slice(0, maxElements);
      body.push(`[Truncated: ${leftOut} more lines left out. Pass a larger maxElements to see them.]`);
    }
    result.push(...body);

    const elementCount = lines.filter(line => line.isElement).length;
    result.push('', `[Compact snapshot: ${lines.length} lines (${elementCount} interactive elements) versus about ${fullLineCount} lines in the full browser_snapshot.]`);
    response.addTextResult(result.join('\n'));
  },
});

function compactLines(snapshot: AriaSnapshotJSON): CompactLine[] {
  const lines: CompactLine[] = [];
  const visit = (node: AriaNodeJSON | string) => {
    if (typeof node === 'string')
      return;
    if (node.role === 'heading') {
      const name = truncate(node.name || node.text || '');
      if (name)
        lines.push({ key: node.ref ?? `heading:${name}`, text: `${'#'.repeat(Math.min(node.level ?? 1, 6))} ${name}`, isElement: false });
    } else if (landmarkRoles.has(node.role) && node.name) {
      const text = `== ${node.role} "${truncate(node.name)}" ==`;
      lines.push({ key: node.ref ?? text, text, isElement: false });
    } else if (node.ref && (interactiveRoles.has(node.role) || node.cursor === 'pointer')) {
      lines.push({ key: node.ref, text: elementLine(node), isElement: true });
    }
    for (const child of node.children ?? [])
      visit(child);
  };
  for (const node of snapshot)
    visit(node);
  return lines;
}

function elementLine(node: AriaNodeJSON): string {
  const isValueRole = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(node.role);
  // For most roles a single text child is the visible label; for text inputs it is the current value.
  const name = node.name || (!isValueRole ? node.text : undefined) || '';
  const parts: string[] = [node.role];
  if (name)
    parts.push(JSON.stringify(truncate(name)));
  else if (node.placeholder)
    parts.push(`[placeholder=${JSON.stringify(truncate(node.placeholder))}]`);
  if (node.checked)
    parts.push(node.checked === 'mixed' ? '[checked=mixed]' : '[checked]');
  if (node.pressed)
    parts.push(node.pressed === 'mixed' ? '[pressed=mixed]' : '[pressed]');
  if (node.expanded)
    parts.push('[expanded]');
  if (node.selected)
    parts.push('[selected]');
  if (node.disabled)
    parts.push('[disabled]');
  parts.push(`[ref=${node.ref}]`);
  let line = parts.join(' ');
  if (isValueRole && node.text)
    line += `: ${truncate(node.text)}`;
  return line;
}

function diffLines(previous: CompactLine[], current: CompactLine[]): string[] {
  const previousByKey = new Map(previous.map(line => [line.key, line]));
  const currentKeys = new Set(current.map(line => line.key));
  const result: string[] = [];
  for (const line of current) {
    const old = previousByKey.get(line.key);
    if (!old)
      result.push(`+ ${line.text}`);
    else if (old.text !== line.text)
      result.push(`~ ${line.text} (was: ${old.text})`);
  }
  for (const line of previous) {
    if (!currentKeys.has(line.key))
      result.push(`- ${line.text}`);
  }
  return result;
}

// Counts the lines of the YAML that browser_snapshot renders for the same tree.
function countFullSnapshotLines(snapshot: AriaSnapshotJSON): number {
  const count = (node: AriaNodeJSON | string): number => {
    if (typeof node === 'string')
      return 1;
    let lines = 1;
    if (node.url !== undefined)
      lines++;
    if (node.placeholder !== undefined)
      lines++;
    for (const child of node.children ?? [])
      lines += count(child);
    return lines;
  };
  return snapshot.reduce((sum, node) => sum + count(node), 0);
}

function truncate(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 1) + '…' : normalized;
}

export default [
  compactSnapshot,
];

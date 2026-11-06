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
import { asLocator } from '@isomorphic/locatorGenerators';
import { toKeyboardModifiers } from '@isomorphic/codegen/language';

import { batchActionsSchema, saveShortcut, shortcutNameSchema } from './batch';
import { defineTool } from './tool';

import type * as actions from '@isomorphic/codegen/actions';
import type * as playwrightTypes from '../../..';
import type { BatchAction } from './batch';
import type { Context, RecordedAction } from './context';

type RecordingStart = {
  page: playwrightTypes.Page;
  url: string;
  // Pages that were open before the recording started, other than the recorded tab. Actions in them are not recorded.
  otherPages: Set<playwrightTypes.Page>;
};

type ConvertedRecording = {
  steps: BatchAction[];
  // Number of steps that come from recorded actions, not counting the navigation to the start page.
  recordedSteps: number;
  skipped: string[];
};

const recordingStarts = new WeakMap<Context, RecordingStart>();
// A stopped recording that could not be saved because of wrong variables, kept so that the user does not have to record again.
const unsavedRecordings = new WeakMap<Context, ConvertedRecording>();

const recordStart = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_shortcut_record_start',
    title: 'Record a shortcut',
    description: 'Start recording the actions that the user performs by hand in the current tab (and in the tabs it opens), to save them as a reusable shortcut. Call browser_shortcut_record_stop when the user says they are done.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const tab = await context.ensureTab();
    await context.startRecording('shortcut');
    unsavedRecordings.delete(context);
    recordingStarts.set(context, {
      page: tab.page,
      url: tab.page.url(),
      otherPages: new Set(context.tabs().map(t => t.page).filter(page => page !== tab.page)),
    });
    await tab.page.bringToFront();
    response.addTextResult(`Recording started. Do the task in the browser, then call ${recordStop.schema.name} with a name to save it as a shortcut.`);
  },
});

const recordStop = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_shortcut_record_stop',
    title: 'Save the recorded shortcut',
    description: 'Stop the recording started with browser_shortcut_record_start and save the recorded actions as a shortcut, to run later with browser_shortcut_run. Saving under an existing name replaces it.',
    inputSchema: z.object({
      name: shortcutNameSchema,
      description: z.string().optional().describe('What the shortcut does.'),
      variables: z.record(z.string(), z.string().regex(/^\w+$/)).optional().describe('Text that the user typed during the recording, mapped to a variable name, as { "typed text": "name" }. That text becomes {{name}} in the shortcut, so that browser_shortcut_run can fill in a new value.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    let converted = unsavedRecordings.get(context);
    if (!converted) {
      const recorded = await context.stopShortcutRecording();
      const start = recordingStarts.get(context);
      recordingStarts.delete(context);
      if (!recorded || !start)
        throw new Error(`No shortcut recording in progress, use ${recordStart.schema.name} to start one.`);
      converted = toShortcutSteps(context, start, recorded);
    }
    unsavedRecordings.delete(context);
    if (!converted.recordedSteps) {
      response.addTextResult('Recording stopped. No actions were recorded, so no shortcut was saved.');
      return;
    }
    if (!batchActionsSchema.safeParse(converted.steps).success)
      throw new Error(`The recording has ${converted.steps.length} steps, a shortcut can have 1 to 50 steps. Nothing was saved.`);

    // Variables change the steps, so a failed save must not change the recording that is kept for a retry.
    const steps: BatchAction[] = JSON.parse(JSON.stringify(converted.steps));
    let variableNames: string[];
    try {
      variableNames = applyVariables(steps, params.variables ?? {});
    } catch (e) {
      unsavedRecordings.set(context, converted);
      throw new Error(`${(e as Error).message} Call ${recordStop.schema.name} again with corrected variables, the recording is kept.`);
    }
    const { skipped } = converted;

    const lines = [await saveShortcut({ name: params.name, description: params.description, actions: steps })];
    if (variableNames.length)
      lines.push(`Run it with browser_shortcut_run and a value for: ${variableNames.join(', ')}.`);
    if (skipped.length)
      lines.push(`Not saved, because shortcuts cannot replay them: ${skipped.join(', ')}.`);
    lines.push('', 'Steps:');
    for (const step of steps)
      lines.push(`- ${step.name} ${JSON.stringify(step.arguments ?? {})}`);
    response.addTextResult(lines.join('\n'));
  },
});

function toShortcutSteps(context: Context, start: RecordingStart, recorded: RecordedAction[]): ConvertedRecording {
  const steps: BatchAction[] = [];
  const skipped: string[] = [];
  const entries = recorded.filter(entry => !start.otherPages.has(entry.page));
  const firstAction = entries[0]?.action.name;
  const startStep = firstAction !== 'navigate' && firstAction !== 'openPage' && !!start.url && start.url !== 'about:blank';
  if (startStep)
    steps.push({ name: 'browser_navigate', arguments: { url: start.url } });

  let currentPage: playwrightTypes.Page | undefined = start.page;
  let popupPending = false;
  for (const { page, action, signals } of entries) {
    if (action.name === 'openPage') {
      if (page !== start.page) {
        // A page opened by a click is selected below, before its first action. A page the user opened is opened again.
        if (!popupPending && action.url && action.url !== 'about:blank') {
          steps.push({ name: 'browser_tabs', arguments: { action: 'new', url: action.url } });
          currentPage = page;
        }
      }
      continue;
    }

    if (page !== currentPage) {
      const index = context.tabs().findIndex(tab => tab.page === page);
      if (index === -1) {
        skipped.push(`${action.name} in a closed tab`);
        continue;
      }
      steps.push({ name: 'browser_tabs', arguments: { action: 'select', index } });
      currentPage = page;
      popupPending = false;
    }

    const step = toStep(action, steps[steps.length - 1]);
    if (step === 'merged') {
      // Merged into the previous step.
    } else if (step) {
      steps.push(step);
    } else {
      skipped.push(action.name);
    }
    if (action.name === 'closePage')
      currentPage = undefined;
    if (signals.some(signal => signal.name === 'popup'))
      popupPending = true;
  }
  return { steps, recordedSteps: steps.length - (startStep ? 1 : 0), skipped };
}

function toStep(action: actions.Action, previous: BatchAction | undefined): BatchAction | 'merged' | undefined {
  switch (action.name) {
    case 'navigate':
      return { name: 'browser_navigate', arguments: { url: action.url } };
    case 'closePage':
      return { name: 'browser_tabs', arguments: { action: 'close' } };
    case 'click':
    case 'check':
    case 'uncheck': {
      const args: Record<string, any> = targetArguments(action);
      if (action.name === 'click') {
        if (action.clickCount === 2)
          args.doubleClick = true;
        if (action.button !== 'left')
          args.button = action.button;
        const modifiers = [...new Set(toKeyboardModifiers(action.modifiers))];
        if (modifiers.length)
          args.modifiers = modifiers;
      }
      return { name: 'browser_click', arguments: args };
    }
    case 'hover':
      return { name: 'browser_hover', arguments: targetArguments(action) };
    case 'fill': {
      const args = targetArguments(action);
      if (previous?.name === 'browser_type' && previous.arguments?.target === args.target && !previous.arguments?.submit) {
        previous.arguments!.text = action.text;
        return 'merged';
      }
      return { name: 'browser_type', arguments: { ...args, text: action.text } };
    }
    case 'press': {
      if (action.key === 'Enter' && !action.modifiers && previous?.name === 'browser_type' && previous.arguments?.target === targetArguments(action).target && !previous.arguments?.submit) {
        previous.arguments!.submit = true;
        return 'merged';
      }
      const modifiers = [...new Set(toKeyboardModifiers(action.modifiers))];
      return { name: 'browser_press_key', arguments: { key: [...modifiers, action.key].join('+') } };
    }
    case 'select':
      return { name: 'browser_select_option', arguments: { ...targetArguments(action), values: action.options } };
  }
  // File uploads and assertions are not replayed.
  return undefined;
}

function targetArguments(action: actions.ActionWithSelector): { target: string, element: string } {
  const target = asLocator('javascript', action.selector);
  // The aria snapshot of the element, for example `- button "Submit"`, reads better than the locator.
  const element = action.ariaSnapshot?.split('\n')[0].replace(/^\s*-\s*/, '').replace(/:$/, '').trim();
  return { target, element: element || target };
}

// Replaces typed text that has a variable name with {{name}}, and returns the variable names used.
function applyVariables(steps: BatchAction[], variables: Record<string, string>): string[] {
  const typed = steps.filter(step => step.name === 'browser_type' && typeof step.arguments?.text === 'string');
  const typedText = typed.map(step => JSON.stringify(step.arguments!.text)).join(', ') || 'none';
  const usedValues = new Set<string>();
  const usedNames = new Set<string>();
  // Longer values first, so that a value that contains another one is replaced as a whole.
  const values = Object.keys(variables).filter(value => value).sort((a, b) => b.length - a.length);
  for (const step of typed) {
    let text: string = step.arguments!.text;
    for (const value of values) {
      if (text.includes(value)) {
        text = text.split(value).join(`{{${variables[value]}}}`);
        usedValues.add(value);
        usedNames.add(variables[value]);
      }
    }
    step.arguments!.text = text;
  }
  const missing = Object.keys(variables).filter(value => !usedValues.has(value));
  if (missing.length)
    throw new Error(`The user did not type ${missing.map(value => JSON.stringify(value)).join(', ')} during the recording. Typed text: ${typedText}.`);
  return [...usedNames];
}

export default [
  recordStart,
  recordStop,
];

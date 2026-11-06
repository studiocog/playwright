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
import debug from 'debug';
import { defineTool } from './tool';

import type * as playwright from '../../..';
import type { Context } from './context';
import type { Tab } from './tab';

const approvalDebug = debug('pw:mcp:approval');

export const defaultApprovalPattern = String.raw`\b(send|post|publish|share|tweet|reply|submit|confirm|buy|purchase|order|pay|checkout|place order|delete|remove|unsubscribe|transfer)\b`;
const defaultTimeoutMs = 120_000;
const lookupTimeoutMs = 3_000;

type ApprovalSettings = {
  enabled: boolean;
  pattern: RegExp;
  patternError?: string;
  timeoutMs: number;
};

export function approvalSettings(): ApprovalSettings {
  const enabled = ['1', 'true'].includes((process.env.PLAYWRIGHT_MCP_APPROVAL_GATES ?? '').toLowerCase());
  let pattern = new RegExp(defaultApprovalPattern, 'i');
  let patternError: string | undefined;
  const custom = process.env.PLAYWRIGHT_MCP_APPROVAL_PATTERN;
  if (custom) {
    try {
      pattern = new RegExp(custom, 'i');
    } catch (error) {
      patternError = `PLAYWRIGHT_MCP_APPROVAL_PATTERN is not a valid regular expression, the default pattern is used: ${String(error)}`;
    }
  }
  const timeout = Number(process.env.PLAYWRIGHT_MCP_APPROVAL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs;
  return { enabled, pattern, patternError, timeoutMs };
}

type GatedAction = {
  action: string;
  description: string;
  element: playwright.ElementHandle;
};

type ElementDescription = {
  parts: string[];
};

// Returns an error message when the user did not approve the tool call, undefined when the tool may run.
export async function checkApproval(context: Context, toolName: string, params: any, signal?: AbortSignal): Promise<string | undefined> {
  const settings = approvalSettings();
  if (!settings.enabled)
    return;
  const tab = context.currentTab();
  // Without a page there is nothing to click, and a modal dialog blocks page scripts.
  if (!tab || tab.modalStates().length)
    return;

  let gated: GatedAction | undefined;
  try {
    gated = await withTimeout(resolveGatedAction(tab, toolName, params), lookupTimeoutMs);
  } catch (error) {
    approvalDebug('lookup failed, not gating', error);
    return;
  }
  if (!gated)
    return;
  try {
    if (!settings.pattern.test(gated.description))
      return;
    approvalDebug(`asking to ${gated.action}: ${gated.description}`);
    const answer = await askUser(tab, gated, settings.timeoutMs, signal);
    const request = `${gated.action}: "${gated.description}"`;
    if (answer === 'allow')
      return;
    if (answer === 'deny')
      return `The user denied the request to ${request}. The tool was not run. Stop and ask the user how to continue.`;
    if (answer === 'cancelled')
      return `The approval request to ${request} was cancelled. The tool was not run.`;
    return `The user did not answer the request to ${request} within ${Math.round(settings.timeoutMs / 1000)} seconds. The tool was not run. Stop and ask the user how to continue.`;
  } finally {
    gated.element.dispose().catch(() => {});
  }
}

async function resolveGatedAction(tab: Tab, toolName: string, params: any): Promise<GatedAction | undefined> {
  let action: string;
  let element: playwright.ElementHandle | null = null;
  let submit = false;
  let extra: string[] = [];
  if (toolName === 'browser_click') {
    action = params.doubleClick ? 'double-click' : 'click';
    element = await targetElement(tab, params);
  } else if (toolName === 'browser_select_option') {
    action = 'select';
    element = await targetElement(tab, params);
    extra = params.values;
  } else if (toolName === 'browser_type' && params.submit) {
    action = 'type and submit';
    element = await targetElement(tab, params);
    submit = true;
  } else if (toolName === 'browser_press_key' && params.key === 'Enter') {
    action = 'press Enter on';
    element = await elementInFrames(await tab.page.evaluateHandle(() => document.activeElement), async frameElement => await frameElement.evaluateHandle(frame => frame.contentDocument?.activeElement ?? null));
    submit = true;
  } else if (toolName === 'browser_mouse_click_xy') {
    action = 'click';
    let point = { x: params.x, y: params.y };
    element = await elementInFrames(await tab.page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), point), async frameElement => {
      const offset = await frameElement.evaluate(frame => {
        const rect = frame.getBoundingClientRect();
        return { x: rect.x + frame.clientLeft, y: rect.y + frame.clientTop };
      });
      point = { x: point.x - offset.x, y: point.y - offset.y };
      return await frameElement.evaluateHandle((frame, { x, y }) => frame.contentDocument?.elementFromPoint(x, y) ?? null, point);
    });
  } else {
    return;
  }
  if (!element)
    return;

  const { parts } = await element.evaluate(describeElement, { submit, closestInteractive: toolName === 'browser_mouse_click_xy', skipText: toolName === 'browser_select_option' });
  const description = [...parts, ...extra].map(part => part.slice(0, 200)).join(' / ');
  if (!description) {
    element.dispose().catch(() => {});
    return;
  }
  return { action, description, element };
}

async function targetElement(tab: Tab, params: { element?: string, target: string }): Promise<playwright.ElementHandle | null> {
  const { locator } = await tab.targetLocator(params);
  return await locator.elementHandle({ timeout: lookupTimeoutMs });
}

// Follows same-origin iframes down to the element that will receive the input.
async function elementInFrames(handle: playwright.JSHandle, next: (frameElement: playwright.ElementHandle<HTMLIFrameElement>) => Promise<playwright.JSHandle>): Promise<playwright.ElementHandle | null> {
  let element = handle.asElement();
  for (let depth = 0; element && depth < 5; depth++) {
    const isFrame = await element.evaluate(e => e.tagName === 'IFRAME' || e.tagName === 'FRAME');
    if (!isFrame)
      break;
    const innerHandle = await next(element as playwright.ElementHandle<HTMLIFrameElement>);
    const inner = innerHandle.asElement();
    if (!inner) {
      innerHandle.dispose().catch(() => {});
      break;
    }
    element.dispose().catch(() => {});
    element = inner;
  }
  if (!element)
    handle.dispose().catch(() => {});
  return element;
}

function describeElement(target: Element, options: { submit: boolean, closestInteractive: boolean, skipText: boolean }): ElementDescription {
  const parts: string[] = [];
  const add = (value: string | null | undefined) => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    if (text && !parts.includes(text))
      parts.push(text);
  };
  const addElement = (element: Element, skipText: boolean) => {
    add(element.getAttribute('aria-label'));
    for (const id of (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean))
      add(element.ownerDocument.getElementById(id)?.textContent);
    for (const label of (element as HTMLInputElement).labels ?? [])
      add(label.textContent);
    const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
    // Long text belongs to a container, not to a control.
    if (!skipText && text.length <= 200)
      add(text);
    if (element instanceof HTMLInputElement && element.type !== 'password')
      add(element.value);
    if (element instanceof HTMLButtonElement)
      add(element.value);
    add(element.getAttribute('title'));
    add(element.getAttribute('alt'));
    if (element instanceof HTMLInputElement)
      add(element.type);
  };

  let element = target;
  if (options.closestInteractive)
    element = target.closest('button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [onclick]') ?? target;
  // Input on the document itself (nothing focused, or a click on empty space) does not act on a control.
  if (element === element.ownerDocument.body || element === element.ownerDocument.documentElement)
    return { parts };
  addElement(element, options.skipText || element instanceof HTMLSelectElement);
  if (options.submit) {
    const form = (element as HTMLInputElement).form ?? element.closest('form');
    const button = form?.querySelector('button[type=submit], button:not([type]), input[type=submit], input[type=image]');
    if (button && button !== element)
      addElement(button, false);
  }
  return { parts };
}

type Answer = 'allow' | 'deny' | 'timeout' | 'cancelled';

async function askUser(tab: Tab, gated: GatedAction, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
  let host = '';
  try {
    host = new URL(tab.page.url()).host;
  } catch {
  }
  const box = await gated.element.boundingBox().catch(() => null);
  const overlay = await tab.page.evaluateHandle(installOverlay, { text: `Claude wants to ${gated.action}: "${gated.description}"`, host: host || tab.page.url(), box });
  try {
    const decision = overlay.evaluate(o => o.decision).catch(() => 'timeout' as const);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<Answer>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const aborted = new Promise<Answer>(resolve => {
      onAbort = () => resolve('cancelled');
      signal?.addEventListener('abort', onAbort);
    });
    const testAnswer = process.env.PWTEST_MCP_APPROVAL_ANSWER_FOR_TEST as 'allow' | 'deny' | undefined;
    if (testAnswer === 'allow' || testAnswer === 'deny') {
      // Answers with real mouse input, like a user would, so the trusted event path is exercised.
      const point = await overlay.evaluate((o, answer) => o.points[answer], testAnswer);
      await tab.page.mouse.click(point.x, point.y);
    }
    try {
      return await Promise.race([decision, timeout, aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort)
        signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    await overlay.evaluate(o => o.remove()).catch(() => {});
    overlay.dispose().catch(() => {});
  }
}

// Runs in the page. The closed shadow root keeps page scripts away from the buttons,
// and only trusted (user) input is accepted as an answer.
function installOverlay(options: { text: string, host: string, box: { x: number, y: number, width: number, height: number } | null }) {
  const hostElement = document.createElement('x-pw-approval');
  hostElement.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  const root = hostElement.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); }
    .highlight { position: fixed; outline: 3px solid #d97706; outline-offset: 2px; border-radius: 4px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.2); pointer-events: none; }
    .dialog { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box;
      background: #fff; color: #1f2937; border-radius: 10px; padding: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); font: 14px/1.4 system-ui, sans-serif; }
    .text { font-weight: 600; word-break: break-word; }
    .host { margin-top: 4px; color: #6b7280; font-size: 12px; }
    .buttons { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
    button { font: inherit; padding: 6px 16px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #1f2937; cursor: pointer; }
    button.allow { background: #2563eb; border-color: #2563eb; color: #fff; }
  `;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'alertdialog');
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = options.text;
  const site = document.createElement('div');
  site.className = 'host';
  site.textContent = options.host;
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const deny = document.createElement('button');
  deny.textContent = 'Deny';
  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = 'Allow';
  buttons.append(deny, allow);
  dialog.append(text, site, buttons);
  root.append(style, backdrop);
  if (options.box) {
    const highlight = document.createElement('div');
    highlight.className = 'highlight';
    highlight.style.left = `${options.box.x}px`;
    highlight.style.top = `${options.box.y}px`;
    highlight.style.width = `${options.box.width}px`;
    highlight.style.height = `${options.box.height}px`;
    root.append(highlight);
  }
  root.append(dialog);

  let resolve: (answer: 'allow' | 'deny') => void = () => {};
  const decision = new Promise<'allow' | 'deny'>(f => resolve = f);
  const listen = (button: HTMLElement, answer: 'allow' | 'deny') => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (event.isTrusted)
      resolve(answer);
  });
  listen(allow, 'allow');
  listen(deny, 'deny');
  // Keep input on the overlay from reaching the page.
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'])
    hostElement.addEventListener(type, event => event.stopPropagation());
  document.documentElement.appendChild(hostElement);

  const center = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  return {
    decision,
    points: { allow: center(allow), deny: center(deny) },
    // Settles the pending decision so the waiting evaluation does not outlive the overlay.
    remove: () => {
      resolve('deny');
      hostElement.remove();
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const approvalStatus = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_approval_status',
    title: 'Approval gates status',
    description: 'Report whether approval gates are on. When they are on, clicks and key presses that send, post, buy or delete something wait until the user allows them in the browser. If the user denies or does not answer, stop and ask the user.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const settings = approvalSettings();
    const lines = [
      `Approval gates: ${settings.enabled ? 'on' : 'off'}`,
      `Pattern: ${settings.pattern.source} (case-insensitive)`,
      `Timeout: ${Math.round(settings.timeoutMs / 1000)} seconds`,
    ];
    if (settings.patternError)
      lines.push(settings.patternError);
    if (!settings.enabled)
      lines.push('Set PLAYWRIGHT_MCP_APPROVAL_GATES=1 in the server environment to turn them on.');
    response.addTextResult(lines.join('\n'));
  },
});

export default [
  approvalStatus,
];

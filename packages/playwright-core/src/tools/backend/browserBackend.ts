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

import { EventEmitter } from 'events';

import * as z from 'zod';
import debug from 'debug';
import { checkApproval } from './approval';
import { batchToolName, readShortcuts, shortcutRunToolName, shortcutVariables, substituteVariables } from './batch';
import { describeBrowser, isConnectedTo, listInstalledBrowsers, switchBrowserToolName, switchUnavailableMessage } from './browsers';
import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import type { BatchAction } from './batch';
import type { BrowserTarget } from './browsers';
import type { ContextConfig } from './context';
import type { IdleTimer } from './idleTimer';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

const backendDebug = debug('pw:mcp:backend');

export type SwitchedBrowser = {
  browserContext: playwright.BrowserContext;
  idleTimer?: IdleTimer;
  // Closes the connection to the previous browser, called once the backend has released it.
  closePrevious: () => Promise<void>;
};

export type BrowserBackendOptions = {
  dispose?: () => Promise<void>;
  idleTimer?: IdleTimer;
  // Extension mode: the browser the backend is connected to, and how to connect to another one.
  connectedBrowser?: BrowserTarget;
  switchBrowser?: (target: BrowserTarget) => Promise<SwitchedBrowser>;
};

export class BrowserBackend extends EventEmitter<{ disconnected: [], dynamictoolschange: [] }> implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: ContextConfig;
  private _disconnected = false;
  private _disposed = false;
  private _browserContext: playwright.BrowserContext;
  private _disposeCallback: (() => Promise<void>) | undefined;
  private _idleTimer: IdleTimer | undefined;
  private _connectedBrowser: BrowserTarget | undefined;
  private _switchBrowserCallback: BrowserBackendOptions['switchBrowser'];
  private _cwd = '';

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[], options: BrowserBackendOptions = {}) {
    super();
    this._config = config;
    this._tools = tools;
    this._browserContext = browserContext;
    this._disposeCallback = options.dispose;
    this._idleTimer = options.idleTimer;
    this._connectedBrowser = options.connectedBrowser;
    this._switchBrowserCallback = options.switchBrowser;
    this._watchBrowserContext();
  }

  private _markDisconnected = () => {
    if (this._disconnected)
      return;
    backendDebug('browser disconnected');
    this._disconnected = true;
    this.emit('disconnected');
  };

  private _watchBrowserContext() {
    this._browserContext.once('close', this._markDisconnected);
    this._browserContext.browser()?.once('disconnected', this._markDisconnected);
  }

  private _unwatchBrowserContext() {
    this._browserContext.off('close', this._markDisconnected);
    this._browserContext.browser()?.off('disconnected', this._markDisconnected);
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._cwd = clientInfo.cwd;
    this._context = this._createContext();
  }

  private _createContext(): Context {
    return new Context(this._browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: this._cwd,
      onWebMCPToolsChanged: () => this.emit('dynamictoolschange'),
      connectedBrowser: this._connectedBrowser,
      canSwitchBrowser: !!this._switchBrowserCallback,
    });
  }

  dynamicTools(): mcpServer.Tool[] {
    return this._context?.currentWebMCPTools().map(tool => tool.schema) ?? [];
  }

  async dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
    await this._disposeCallback?.().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult> {
    this._idleTimer?.poke();
    const json = !!rawArguments._meta?.json;
    const formatError = (message: string): mcpServer.CallToolResult => ({
      content: [{ type: 'text' as const, text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
      isError: true,
    });
    const context = this._context!;

    let parsedArguments: any;
    let handle: (params: any, response: Response) => Promise<void>;
    const tool = this._tools.find(tool => tool.schema.name === name);
    if (tool) {
      try {
        parsedArguments = tool.schema.inputSchema.parse(rawArguments);
      } catch (error) {
        if (error instanceof z.ZodError)
          return formatError(`Invalid arguments for tool "${name}":\n${z.prettifyError(error)}`);
        throw error;
      }
      if (name === batchToolName)
        return await this._runSteps(parsedArguments.actions, parsedArguments.stopOnError ?? true, rawArguments._meta, signal);
      if (name === shortcutRunToolName) {
        const shortcut = (await readShortcuts())[parsedArguments.name];
        if (!shortcut)
          return formatError(`Shortcut "${parsedArguments.name}" not found. List the saved ones with browser_shortcut_list.`);
        const values: Record<string, string> = parsedArguments.variables ?? {};
        const variables = shortcutVariables(shortcut);
        const missing = variables.filter(variable => !Object.prototype.hasOwnProperty.call(values, variable));
        if (missing.length)
          return formatError(`Shortcut "${parsedArguments.name}" needs a value for missing variable(s): ${missing.join(', ')}. Pass them in "variables". No step was run.`);
        const result = await this._runSteps(substituteVariables(shortcut.actions, values), parsedArguments.stopOnError ?? true, rawArguments._meta, signal);
        const extra = Object.keys(values).filter(variable => !variables.includes(variable));
        if (extra.length)
          result.content.unshift({ type: 'text', text: `Ignored variable(s) the shortcut does not use: ${extra.join(', ')}.` });
        return result;
      }
      if (name === switchBrowserToolName)
        return await this._switchBrowser(parsedArguments.id, rawArguments._meta, formatError);
      const denied = await checkApproval(context, name, parsedArguments, signal);
      if (denied)
        return formatError(denied);
      handle = (params, response) => tool.handle(context, params, response, signal);
    } else {
      const webmcpTool = context.currentWebMCPTools().find(tool => tool.schema.name === name);
      if (!webmcpTool)
        return formatError(`Tool "${name}" not found`);
      // Page-registered WebMCP tools validate their own input, only strip the meta.
      parsedArguments = { ...rawArguments };
      delete parsedArguments._meta;
      handle = webmcpTool.handle;
    }

    const cwd = rawArguments._meta?.cwd;
    const raw = !!rawArguments._meta?.raw;
    const response = new Response(context, name, parsedArguments, { relativeTo: cwd, raw, json });
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult & { isClose?: boolean };
    try {
      await handle(parsedArguments, response);
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      const messages = [String(error), ...context.drainPendingUnhandledRejections().filter(reason => reason !== error).map(formatRejectionReason)];
      responseObject = formatError(messages.join('\n\n'));
    } finally {
      context.setRunningTool(undefined);
    }
    if (this._disconnected || responseObject.isClose) {
      delete responseObject.isClose;
      await this.dispose();
    }
    return responseObject;
  }

  private async _runSteps(actions: BatchAction[], stopOnError: boolean, meta: Record<string, any> | undefined, signal?: AbortSignal): Promise<mcpServer.CallToolResult> {
    const content: mcpServer.CallToolResult['content'] = [];
    let failed = 0;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const header = `## Step ${i + 1} of ${actions.length}: ${action.name}`;
      if (action.name === batchToolName || action.name === shortcutRunToolName) {
        content.push({ type: 'text', text: `${header}\n### Error\n${action.name} cannot run inside a batch or shortcut.` });
        failed++;
        if (stopOnError)
          break;
        continue;
      }
      const result = await this.callTool(action.name, { ...action.arguments, ...(meta ? { _meta: meta } : {}) }, signal);
      content.push({ type: 'text', text: header }, ...result.content);
      if (result.isError) {
        failed++;
        if (stopOnError) {
          if (i + 1 < actions.length)
            content.push({ type: 'text', text: `Stopped after step ${i + 1}; ${actions.length - i - 1} step(s) not run.` });
          break;
        }
      }
      if (this._disposed)
        break;
    }
    return { content, ...(failed ? { isError: true } : {}) };
  }

  private async _switchBrowser(id: string, meta: Record<string, any> | undefined, formatError: (message: string) => mcpServer.CallToolResult): Promise<mcpServer.CallToolResult> {
    const target = (await listInstalledBrowsers(this._connectedBrowser)).find(browser => browser.id === id);
    if (!target)
      return formatError(`Unknown browser id "${id}". Call browser_list_browsers to see the available ids.`);
    if (!this._config.extension)
      return formatError(`${switchBrowserToolName} needs extension mode. Start the server with --extension to connect to your browser through the Playwright extension.`);
    if (!this._switchBrowserCallback)
      return formatError(switchUnavailableMessage);

    const respond = async (text: string) => {
      const response = new Response(this._context!, switchBrowserToolName, { id }, { relativeTo: meta?.cwd, raw: !!meta?.raw, json: !!meta?.json });
      response.addTextResult(text);
      return await response.serialize();
    };
    if (isConnectedTo(target, this._connectedBrowser))
      return await respond(`Already connected to ${describeBrowser(target)}.`);

    // Closing the previous browser must not mark the backend as disconnected.
    this._unwatchBrowserContext();
    let switched: SwitchedBrowser;
    try {
      switched = await this._switchBrowserCallback({ channel: target.channel, userDataDir: target.userDataDir, profileDirName: target.profileDirName });
    } catch (error) {
      this._watchBrowserContext();
      if (!this._browserContext.browser()?.isConnected())
        this._markDisconnected();
      return formatError(`Could not connect to ${describeBrowser(target)}, still connected to the previous browser.\n${String(error)}`);
    }
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
    await switched.closePrevious().catch(e => debug('pw:tools:error')(e));
    this._browserContext = switched.browserContext;
    this._idleTimer = switched.idleTimer;
    this._connectedBrowser = { channel: target.channel, userDataDir: target.userDataDir, profileDirName: target.profileDirName };
    this._watchBrowserContext();
    this._context = this._createContext();
    return await respond(`Connected to ${describeBrowser(target)}. The following tool calls act on this browser.`);
  }
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? reason.message;
  return String(reason);
}

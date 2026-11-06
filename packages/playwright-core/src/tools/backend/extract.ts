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

const maxInlineChars = 20000;

type FieldSpec = { selector?: string, attribute?: string };

type ExtractArgs = {
  mode: 'tables' | 'items';
  tableSelector?: string;
  itemSelector?: string;
  fields?: Record<string, FieldSpec>;
  limit: number;
};

type ResultSet = {
  name: string;
  columns: string[];
  rows: Record<string, string | null>[];
  total: number;
};

type ExtractResult = { error: string } | { resultSets: ResultSet[] };

// Runs in the page: must not reference anything outside of its own body.
function extractInPage(args: ExtractArgs): ExtractResult {
  const textOf = (element: Element): string => {
    const text = element instanceof HTMLElement ? element.innerText : element.textContent;
    return (text ?? '').replace(/\s+/g, ' ').trim();
  };

  if (args.mode === 'items') {
    const items = [...document.querySelectorAll(args.itemSelector!)];
    const fields = Object.entries(args.fields!);
    const rows = items.slice(0, args.limit).map(item => {
      const row: Record<string, string | null> = {};
      for (const [name, field] of fields) {
        const element = field.selector ? item.querySelector(field.selector) : item;
        if (!element) {
          row[name] = null;
          continue;
        }
        if (!field.attribute) {
          row[name] = textOf(element);
          continue;
        }
        const value = element.getAttribute(field.attribute);
        if (value !== null && (field.attribute === 'href' || field.attribute === 'src')) {
          try {
            row[name] = new URL(value, document.baseURI).href;
          } catch {
            row[name] = value;
          }
        } else {
          row[name] = value;
        }
      }
      return row;
    });
    return { resultSets: [{ name: args.itemSelector!, columns: fields.map(([name]) => name), rows, total: items.length }] };
  }

  const tableQuery = 'table, [role="table"], [role="grid"]';
  let tables: Element[];
  if (args.tableSelector) {
    const element = document.querySelector(args.tableSelector);
    if (!element)
      return { error: `No element matches "${args.tableSelector}".` };
    const table = element.matches(tableQuery) ? element : element.querySelector(tableQuery);
    if (!table)
      return { error: `"${args.tableSelector}" is not a table and does not contain one.` };
    tables = [table];
  } else {
    tables = [...document.querySelectorAll(tableQuery)];
  }

  const rowsOf = (table: Element): Element[] => {
    if (table instanceof HTMLTableElement)
      return [...table.rows];
    return [...table.querySelectorAll('[role="row"]')].filter(row => row.parentElement?.closest(tableQuery) === table);
  };
  const cellsOf = (row: Element): Element[] => {
    if (row instanceof HTMLTableRowElement)
      return [...row.cells];
    return [...row.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')].filter(cell => cell.closest('[role="row"]') === row);
  };
  // Repeats the value of a cell with colspan in every column it covers.
  const expand = (row: Element): string[] => {
    const values: string[] = [];
    for (const cell of cellsOf(row)) {
      const span = Math.min(Math.max(parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1, 1), 1000);
      const value = textOf(cell);
      for (let i = 0; i < span; i++)
        values.push(value);
    }
    return values;
  };

  const resultSets: ResultSet[] = [];
  tables.forEach((table, index) => {
    const rows = rowsOf(table);
    if (rows.length < 2 && !args.tableSelector)
      return;
    // The header row is the first row of <thead>, or the first row of the table.
    const headerRow = (table instanceof HTMLTableElement ? table.tHead?.rows[0] : undefined) ?? rows[0];
    const headerIndex = headerRow ? rows.indexOf(headerRow) : -1;
    const header = headerRow ? expand(headerRow) : [];
    const dataRows = rows.slice(headerIndex + 1).map(expand).filter(values => values.some(value => value));
    const width = Math.max(header.length, ...dataRows.map(values => values.length));

    const columns: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < width; i++) {
      const base = header[i] || `column_${i + 1}`;
      let name = base;
      for (let n = 2; used.has(name); n++)
        name = `${base}_${n}`;
      used.add(name);
      columns.push(name);
    }

    const label = table.getAttribute('aria-label') || (table instanceof HTMLTableElement && table.caption ? textOf(table.caption) : '') || table.id || `Table ${index + 1}`;
    resultSets.push({
      name: label,
      columns,
      rows: dataRows.slice(0, args.limit).map(values => Object.fromEntries(columns.map((column, i) => [column, values[i] ?? '']))),
      total: dataRows.length,
    });
  });
  return { resultSets };
}

function csvField(value: string | null): string {
  if (value === null)
    return '';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(resultSet: ResultSet): string {
  const lines = [resultSet.columns.map(csvField).join(',')];
  for (const row of resultSet.rows)
    lines.push(resultSet.columns.map(column => csvField(row[column] ?? null)).join(','));
  return lines.join('\r\n') + '\r\n';
}

const extract = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_extract',
    title: 'Extract structured data',
    description: 'Extract tables, lists or repeated cards from the current page as clean data (JSON or CSV) in one call. Mode "tables" reads every table on the page as an array of row objects keyed by the header row. Mode "items" reads every element matching itemSelector and picks the given fields from each one.',
    inputSchema: z.object({
      mode: z.enum(['tables', 'items']).optional().describe('"tables" to read tables, "items" to read repeated elements such as product cards or search results. Defaults to "tables".'),
      tableSelector: z.string().optional().describe('Tables mode only: CSS selector of the one table to read. If not specified, all tables with at least 2 rows are read.'),
      itemSelector: z.string().optional().describe('Items mode only, required: CSS selector that matches each repeated element, for example ".product-card".'),
      fields: z.record(z.string(), z.object({
        selector: z.string().optional().describe('CSS selector relative to the item. Omit it to read the item itself.'),
        attribute: z.string().optional().describe('Attribute to read instead of the text, for example "href". "href" and "src" are resolved to absolute URLs.'),
      })).optional().describe('Items mode only, required: map of field name to { selector?, attribute? }. A field whose element is missing is null.'),
      limit: z.number().int().positive().optional().describe('Maximum number of rows per table, or items per list. Defaults to 500.'),
      format: z.enum(['json', 'csv']).optional().describe('Output format. CSV needs exactly one table or list. Defaults to "json".'),
      filename: z.string().optional().describe('File name to save the output to. Relative file names are resolved against the workspace root. If not specified, the output is returned inline, or saved into the output directory when it is longer than 20000 characters.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const mode = params.mode ?? 'tables';
    const format = params.format ?? 'json';
    const limit = params.limit ?? 500;
    if (mode === 'items') {
      if (!params.itemSelector)
        throw new Error('itemSelector is required in "items" mode.');
      if (!params.fields || !Object.keys(params.fields).length)
        throw new Error('fields is required in "items" mode.');
      if (params.tableSelector)
        throw new Error('tableSelector can only be used in "tables" mode.');
    } else if (params.itemSelector || params.fields) {
      throw new Error('itemSelector and fields can only be used in "items" mode.');
    }

    const result = await tab.page.evaluate(extractInPage, { mode, tableSelector: params.tableSelector, itemSelector: params.itemSelector, fields: params.fields, limit });
    if ('error' in result)
      throw new Error(result.error);
    const { resultSets } = result;

    if (mode === 'tables' && !resultSets.length) {
      response.addTextResult('No tables with at least 2 rows found on the page.');
      return;
    }
    if (format === 'csv' && resultSets.length !== 1)
      throw new Error(`CSV needs exactly one table, but ${resultSets.length} were found. Pass tableSelector to pick one, or use format "json".`);

    const lines: string[] = [];
    if (mode === 'items') {
      const [items] = resultSets;
      lines.push(`Found ${items.total} item(s) matching "${items.name}". Fields: ${items.columns.join(', ')}.`);
      if (items.total > items.rows.length)
        lines.push(`Returned the first ${items.rows.length} of ${items.total} items. Pass a larger limit to get more.`);
    } else {
      lines.push(`Found ${resultSets.length} table(s).`);
      resultSets.forEach((table, index) => {
        lines.push(`- Table ${index + 1} "${table.name}": ${table.total} row(s). Columns: ${table.columns.join(', ')}.`);
        if (table.total > table.rows.length)
          lines.push(`  Returned the first ${table.rows.length} of ${table.total} rows. Pass a larger limit to get more.`);
      });
    }
    response.addTextResult(lines.join('\n'));

    let output: string;
    if (format === 'csv')
      output = toCsv(resultSets[0]);
    else if (mode === 'items')
      output = JSON.stringify(resultSets[0].rows, null, 2);
    else
      output = JSON.stringify(resultSets.map(table => ({ table: table.name, rows: table.rows })), null, 2);

    if (!params.filename && output.length <= maxInlineChars) {
      response.addTextResult(output);
      return;
    }
    if (!params.filename)
      response.addTextResult(`The output is ${output.length} characters, more than ${maxInlineChars}, so it was saved to a file instead.`);
    const resolvedFile = await response.resolveClientOutputFile({ prefix: 'extract', ext: format, suggestedFilename: params.filename }, 'Extracted data');
    await response.addFileResult(resolvedFile, output);
  },
});

export default [
  extract,
];

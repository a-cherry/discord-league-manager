// Checks the League DB workbook (GOOGLE_LEAGUE_DB_ID) against src/schema.ts.
import { getSheets } from './google.js';
import { TABS, tabRange, type TabKey } from './schema.js';

export type TabStatus =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'empty' } // exists with nothing in it, not even a header
  | { kind: 'problem'; message: string };

export function getLeagueDbId(): string {
  const id = process.env.GOOGLE_LEAGUE_DB_ID;
  if (!id) throw new Error('GOOGLE_LEAGUE_DB_ID is not set');
  return id;
}

export async function getTabIds(spreadsheetId: string): Promise<Map<string, number>> {
  const res = await getSheets().spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  return new Map(res.data.sheets!.map((s) => [s.properties!.title!, s.properties!.sheetId!]));
}

export async function isTabEmpty(spreadsheetId: string, name: string): Promise<boolean> {
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId, range: tabRange(name) });
  return !res.data.values?.length;
}

// Status of every schema tab, keyed by tab name, in schema order.
export async function checkTabs(spreadsheetId: string): Promise<Map<string, TabStatus>> {
  const schema = Object.values(TABS);
  const existing = await getTabIds(spreadsheetId);
  const present = schema.filter((t) => existing.has(t.name));
  const headers = present.length
    ? (
        await getSheets().spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: present.map((t) => `${tabRange(t.name)}!1:1`),
        })
      ).data.valueRanges!
    : [];

  const result = new Map<string, TabStatus>();
  for (const tab of schema) {
    const i = present.indexOf(tab);
    if (i < 0) {
      result.set(tab.name, { kind: 'missing' });
      continue;
    }
    const header = (headers[i].values?.[0] ?? []).map((v) => String(v).trim());
    if (header.length === 0) {
      result.set(
        tab.name,
        (await isTabEmpty(spreadsheetId, tab.name))
          ? { kind: 'empty' }
          : { kind: 'problem', message: 'row 1 is blank but the tab has data' },
      );
    } else if (header.join('\t') !== tab.columns.join('\t')) {
      result.set(tab.name, {
        kind: 'problem',
        message: `header does not match\n    expected: ${tab.columns.join(', ')}\n    found:    ${header.join(', ')}`,
      });
    } else {
      result.set(tab.name, { kind: 'ok' });
    }
  }
  return result;
}

// Number of data rows (below the header) in each named tab.
export async function countRows(spreadsheetId: string, names: string[]): Promise<Map<string, number>> {
  const res = await getSheets().spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: names.map((n) => `${tabRange(n)}!A2:ZZ`),
  });
  return new Map(names.map((n, i) => [n, res.data.valueRanges![i].values?.length ?? 0]));
}

// deleteDimension requests for these 1-based sheet rows of one tab: one per run
// of adjacent rows, bottom-up, so each delete leaves the rows above it where
// they were. The header row can't be deleted.
export function deleteRequests(sheetId: number, rowNumbers: number[]) {
  if (rowNumbers.some((n) => !Number.isInteger(n) || n < 2)) throw new Error(`Can't delete rows ${rowNumbers.join(', ')}`);
  const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
  const runs: { start: number; end: number }[] = [];
  for (const n of sorted) {
    const run = runs.at(-1);
    if (run && run.start === n + 1) run.start = n;
    else runs.push({ start: n, end: n });
  }
  return runs.map((r) => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r.start - 1, endIndex: r.end } },
  }));
}

// Deletes rows from League DB tabs in one batchUpdate, so the deletes land
// together or not at all. Keyed by tab key; row numbers as read by readTabs.
// Not retried on failure (see shouldRetry in google.ts).
export async function deleteRows(rows: Partial<Record<TabKey, number[]>>): Promise<void> {
  const entries = Object.entries(rows).filter(([, n]) => n?.length) as [TabKey, number[]][];
  if (!entries.length) return;
  const spreadsheetId = getLeagueDbId();
  const ids = await getTabIds(spreadsheetId);
  const requests = entries.flatMap(([key, numbers]) => {
    const sheetId = ids.get(TABS[key].name);
    if (sheetId === undefined) throw new Error(`The League DB has no ${TABS[key].name} tab`);
    return deleteRequests(sheetId, numbers);
  });
  await getSheets().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

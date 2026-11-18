// Reads one match tab from a workbook that isn't the League DB. readTabs in
// src/sheet-rows.ts is hardwired to the League DB, so this has its own reads:
// one spreadsheets.get to map the gid to the tab title, then one batchGet of
// the anchor ranges with FORMATTED_VALUE (Discord IDs must stay text).
import type { sheets_v4 } from 'googleapis';
import { getSheets } from '../google.js';
import { tabRange } from '../schema.js';
import { MATCH_RANGES, cellsFromRanges, type MatchCells } from './parse.js';

// The workbook can't be opened: not shared with the service account, or no such workbook.
export class SheetAccessError extends Error {
  constructor(readonly status: number) {
    super(`The match workbook can't be opened (${status})`);
  }
}

export class TabNotFound extends Error {
  constructor(readonly gid: string) {
    super(`No tab with gid ${gid}`);
  }
}

export interface MatchTab {
  title: string;
  cells: MatchCells;
}

export interface SheetLink {
  spreadsheetId: string;
  gid: string;
}

// A link copied from an open tab: .../spreadsheets/d/<id>/edit#gid=<gid>. The
// gid may also come as ?gid= or &gid=. Undefined parts are missing.
export function parseSheetLink(link: string): Partial<SheetLink> {
  const spreadsheetId = /\/spreadsheets\/d\/([\w-]{20,})/.exec(link)?.[1];
  const gid = /[#?&]gid=(\d+)/.exec(link)?.[1];
  return { spreadsheetId, gid };
}

// The anchors reach column AP (42) and row 41. A smaller tab, such as Ref,
// can't be a match tab, and a read past its edge would fail outright.
const LAST_COLUMN = 42;
const LAST_ROW = 41;
export const fitsMatchLayout = (grid: { rowCount?: number | null; columnCount?: number | null } | undefined) =>
  (grid?.columnCount ?? 0) >= LAST_COLUMN && (grid?.rowCount ?? 0) >= LAST_ROW;

const statusOf = (err: unknown) => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: number } };
  return Number(e.response?.status ?? e.status ?? e.code);
};

// The Sheets calls this needs; tests pass a stub.
type SheetsClient = Pick<sheets_v4.Sheets, 'spreadsheets'>;

export async function readMatchTab({ spreadsheetId, gid }: SheetLink, sheets: SheetsClient = getSheets()): Promise<MatchTab> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId, fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    });
    const props = meta.data.sheets?.map((s) => s.properties!).find((p) => String(p.sheetId) === gid);
    if (!props?.title) throw new TabNotFound(gid);
    // No cells, so the sentinel check reports it as not a match tab.
    if (!fitsMatchLayout(props.gridProperties)) return { title: props.title, cells: {} };
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      // Quoted, so a numeric title such as 1 isn't read as a cell reference.
      ranges: MATCH_RANGES.map((r) => `${tabRange(props.title!)}!${r}`),
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const values = (res.data.valueRanges ?? []).map((v) => (v.values ?? []).map((row) => row.map(String)));
    return { title: props.title, cells: cellsFromRanges(values) };
  } catch (err) {
    const status = statusOf(err);
    if (status === 403 || status === 404) throw new SheetAccessError(status);
    throw err;
  }
}

// Links to a tab of a Google Sheets workbook. Pure: no Sheets or Discord
// imports, so both match ingestion and the API can use it.

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

// Replaces the real players in a match fixture with made-up ones, so the
// fixtures can live in a public repo. Pure: no Sheets imports.
//
// The name table AO4:AP13 lists the left slots in rows 4 to 8 and the right
// slots in rows 9 to 13. Each name becomes "Left Player NN" or "Right Player
// NN" (a gym tag before " | " is kept, so tagged names still look tagged) and
// each Discord ID a fake 19-digit one. Every cell that exactly matches a real
// name or ID is rewritten, so the roster slots, game rows and name table
// still agree.

export interface Player {
  name: string;
  discordId: string;
  side: 'left' | 'right';
}

export function anonymizeMatch<M extends { cells: Record<string, string> }>(
  match: M,
): { match: M; players: Player[] } {
  const swaps = new Map<string, string>();
  const players: Player[] = [];
  for (let row = 4; row <= 13; row++) {
    const [name, id] = [match.cells[`AO${row}`], match.cells[`AP${row}`]];
    if (!name) continue;
    if (!/^\d{17,19}$/.test(id ?? '')) throw new Error(`AP${row} isn't a Discord ID: ${JSON.stringify(id)}`);
    const side = row <= 8 ? 'left' : 'right';
    const n = String(side === 'left' ? row - 3 : row - 8).padStart(2, '0');
    const tag = name.includes(' | ') ? name.slice(0, name.indexOf(' | ') + 3) : '';
    const fake = { name: `${tag}${side === 'left' ? 'Left' : 'Right'} Player ${n}`, discordId: `1${side === 'left' ? 1 : 2}${'0'.repeat(15)}${n}`, side } as const;
    swaps.set(name, fake.name).set(id, fake.discordId);
    players.push(fake);
  }

  const cells = Object.fromEntries(Object.entries(match.cells).map(([a1, v]) => [a1, swaps.get(v) ?? v]));
  const out = { ...match, cells };

  // Nothing real may survive anywhere in the output.
  const text = JSON.stringify(out);
  const leaked = [...swaps.keys()].filter((s) => text.includes(JSON.stringify(s)));
  if (leaked.length) throw new Error(`Anonymizing left real values in the fixture: ${leaked.join(', ')}`);
  return { match: out, players };
}

// How a Trainer's role is named to people. Pure: no Sheets or Discord imports,
// so the roster commands and the API name roles the same way.

// The Trainers tab stores trainer or non-playing; people see player or coach.
export const playerOrCoach = (role: string) => (role === 'non-playing' ? 'coach' : 'player');

import { parseGameHeaders, type GameHeader } from '../context/gameHeaders.ts';

export const INJURY_ATTRIBUTION_RULE = `INJURY ATTRIBUTION RULE:
- Every injury citation must match the team_id or team name in the tool result or board.
- Do not assign a player to the opposing team.
- If the team is not explicit in the tool result, do not cite that injury.
- A reason that puts a player on the wrong team is invalid.`;

export interface EspnTeamEntry {
  sport: 'nhl' | 'nba' | 'nfl' | 'mlb';
  id: string;
  abbr: string;
  name: string;
  city: string;
  nickname: string;
  aliases: string[];
}

const RAW_TEAMS: Array<{
  sport: 'nhl' | 'nba' | 'nfl' | 'mlb';
  id: string;
  abbr: string;
  name: string;
  city: string;
  nickname: string;
  extraAliases?: string[];
}> = [
  // NHL (ESPN team IDs)
  { sport: 'nhl', id: '1', abbr: 'BOS', name: 'Boston Bruins', city: 'Boston', nickname: 'Bruins' },
  { sport: 'nhl', id: '2', abbr: 'BUF', name: 'Buffalo Sabres', city: 'Buffalo', nickname: 'Sabres' },
  { sport: 'nhl', id: '3', abbr: 'CGY', name: 'Calgary Flames', city: 'Calgary', nickname: 'Flames' },
  { sport: 'nhl', id: '4', abbr: 'CHI', name: 'Chicago Blackhawks', city: 'Chicago', nickname: 'Blackhawks', extraAliases: ['hawks'] },
  { sport: 'nhl', id: '5', abbr: 'DET', name: 'Detroit Red Wings', city: 'Detroit', nickname: 'Red Wings', extraAliases: ['wings'] },
  { sport: 'nhl', id: '6', abbr: 'EDM', name: 'Edmonton Oilers', city: 'Edmonton', nickname: 'Oilers' },
  { sport: 'nhl', id: '7', abbr: 'CAR', name: 'Carolina Hurricanes', city: 'Carolina', nickname: 'Hurricanes', extraAliases: ['canes'] },
  { sport: 'nhl', id: '8', abbr: 'LAK', name: 'Los Angeles Kings', city: 'Los Angeles', nickname: 'Kings', extraAliases: ['la kings'] },
  { sport: 'nhl', id: '9', abbr: 'DAL', name: 'Dallas Stars', city: 'Dallas', nickname: 'Stars' },
  { sport: 'nhl', id: '10', abbr: 'MTL', name: 'Montreal Canadiens', city: 'Montreal', nickname: 'Canadiens', extraAliases: ['habs', 'montréal'] },
  { sport: 'nhl', id: '11', abbr: 'NJD', name: 'New Jersey Devils', city: 'New Jersey', nickname: 'Devils', extraAliases: ['nj devils'] },
  { sport: 'nhl', id: '12', abbr: 'NYI', name: 'New York Islanders', city: 'New York', nickname: 'Islanders', extraAliases: ['isles', 'ny islanders'] },
  { sport: 'nhl', id: '13', abbr: 'NYR', name: 'New York Rangers', city: 'New York', nickname: 'Rangers', extraAliases: ['ny rangers'] },
  { sport: 'nhl', id: '14', abbr: 'OTT', name: 'Ottawa Senators', city: 'Ottawa', nickname: 'Senators', extraAliases: ['sens'] },
  { sport: 'nhl', id: '15', abbr: 'PHI', name: 'Philadelphia Flyers', city: 'Philadelphia', nickname: 'Flyers' },
  { sport: 'nhl', id: '16', abbr: 'PIT', name: 'Pittsburgh Penguins', city: 'Pittsburgh', nickname: 'Penguins', extraAliases: ['pens'] },
  { sport: 'nhl', id: '17', abbr: 'COL', name: 'Colorado Avalanche', city: 'Colorado', nickname: 'Avalanche', extraAliases: ['avs'] },
  { sport: 'nhl', id: '18', abbr: 'SJS', name: 'San Jose Sharks', city: 'San Jose', nickname: 'Sharks', extraAliases: ['sj sharks'] },
  { sport: 'nhl', id: '19', abbr: 'STL', name: 'St. Louis Blues', city: 'St. Louis', nickname: 'Blues', extraAliases: ['st louis', 'st louis blues'] },
  { sport: 'nhl', id: '20', abbr: 'TBL', name: 'Tampa Bay Lightning', city: 'Tampa Bay', nickname: 'Lightning', extraAliases: ['tampa', 'bolts', 'tb lightning'] },
  { sport: 'nhl', id: '21', abbr: 'TOR', name: 'Toronto Maple Leafs', city: 'Toronto', nickname: 'Maple Leafs', extraAliases: ['leafs'] },
  { sport: 'nhl', id: '22', abbr: 'VAN', name: 'Vancouver Canucks', city: 'Vancouver', nickname: 'Canucks' },
  { sport: 'nhl', id: '23', abbr: 'WSH', name: 'Washington Capitals', city: 'Washington', nickname: 'Capitals', extraAliases: ['caps'] },
  { sport: 'nhl', id: '24', abbr: 'ARI', name: 'Arizona Coyotes', city: 'Arizona', nickname: 'Coyotes' },
  { sport: 'nhl', id: '25', abbr: 'ANA', name: 'Anaheim Ducks', city: 'Anaheim', nickname: 'Ducks' },
  { sport: 'nhl', id: '26', abbr: 'FLA', name: 'Florida Panthers', city: 'Florida', nickname: 'Panthers', extraAliases: ['cats'] },
  { sport: 'nhl', id: '27', abbr: 'NSH', name: 'Nashville Predators', city: 'Nashville', nickname: 'Predators', extraAliases: ['preds'] },
  { sport: 'nhl', id: '28', abbr: 'WPG', name: 'Winnipeg Jets', city: 'Winnipeg', nickname: 'Jets' },
  { sport: 'nhl', id: '29', abbr: 'CBJ', name: 'Columbus Blue Jackets', city: 'Columbus', nickname: 'Blue Jackets', extraAliases: ['jackets'] },
  { sport: 'nhl', id: '30', abbr: 'MIN', name: 'Minnesota Wild', city: 'Minnesota', nickname: 'Wild' },
  { sport: 'nhl', id: '37', abbr: 'VGK', name: 'Vegas Golden Knights', city: 'Vegas', nickname: 'Golden Knights', extraAliases: ['las vegas', 'knights'] },
  { sport: 'nhl', id: '124292', abbr: 'SEA', name: 'Seattle Kraken', city: 'Seattle', nickname: 'Kraken' },
  { sport: 'nhl', id: '129764', abbr: 'UTA', name: 'Utah Mammoth', city: 'Utah', nickname: 'Mammoth', extraAliases: ['utah hockey club', 'utah hc'] },

  // NBA (ESPN team IDs)
  { sport: 'nba', id: '1', abbr: 'ATL', name: 'Atlanta Hawks', city: 'Atlanta', nickname: 'Hawks' },
  { sport: 'nba', id: '2', abbr: 'BOS', name: 'Boston Celtics', city: 'Boston', nickname: 'Celtics' },
  { sport: 'nba', id: '3', abbr: 'NOP', name: 'New Orleans Pelicans', city: 'New Orleans', nickname: 'Pelicans', extraAliases: ['pels', 'no pelicans'] },
  { sport: 'nba', id: '4', abbr: 'CHI', name: 'Chicago Bulls', city: 'Chicago', nickname: 'Bulls' },
  { sport: 'nba', id: '5', abbr: 'CLE', name: 'Cleveland Cavaliers', city: 'Cleveland', nickname: 'Cavaliers', extraAliases: ['cavs'] },
  { sport: 'nba', id: '6', abbr: 'DAL', name: 'Dallas Mavericks', city: 'Dallas', nickname: 'Mavericks', extraAliases: ['mavs'] },
  { sport: 'nba', id: '7', abbr: 'DEN', name: 'Denver Nuggets', city: 'Denver', nickname: 'Nuggets' },
  { sport: 'nba', id: '8', abbr: 'DET', name: 'Detroit Pistons', city: 'Detroit', nickname: 'Pistons' },
  { sport: 'nba', id: '9', abbr: 'GSW', name: 'Golden State Warriors', city: 'Golden State', nickname: 'Warriors', extraAliases: ['gs warriors', 'dubs'] },
  { sport: 'nba', id: '10', abbr: 'HOU', name: 'Houston Rockets', city: 'Houston', nickname: 'Rockets' },
  { sport: 'nba', id: '11', abbr: 'IND', name: 'Indiana Pacers', city: 'Indiana', nickname: 'Pacers' },
  { sport: 'nba', id: '12', abbr: 'LAC', name: 'Los Angeles Clippers', city: 'Los Angeles', nickname: 'Clippers', extraAliases: ['la clippers'] },
  { sport: 'nba', id: '13', abbr: 'LAL', name: 'Los Angeles Lakers', city: 'Los Angeles', nickname: 'Lakers', extraAliases: ['la lakers'] },
  { sport: 'nba', id: '14', abbr: 'MIA', name: 'Miami Heat', city: 'Miami', nickname: 'Heat' },
  { sport: 'nba', id: '15', abbr: 'MIL', name: 'Milwaukee Bucks', city: 'Milwaukee', nickname: 'Bucks' },
  { sport: 'nba', id: '16', abbr: 'MIN', name: 'Minnesota Timberwolves', city: 'Minnesota', nickname: 'Timberwolves', extraAliases: ['wolves', 'twolves', 't-wolves'] },
  { sport: 'nba', id: '17', abbr: 'BKN', name: 'Brooklyn Nets', city: 'Brooklyn', nickname: 'Nets', extraAliases: ['brk'] },
  { sport: 'nba', id: '18', abbr: 'NYK', name: 'New York Knicks', city: 'New York', nickname: 'Knicks', extraAliases: ['ny knicks'] },
  { sport: 'nba', id: '19', abbr: 'ORL', name: 'Orlando Magic', city: 'Orlando', nickname: 'Magic' },
  { sport: 'nba', id: '20', abbr: 'PHI', name: 'Philadelphia 76ers', city: 'Philadelphia', nickname: '76ers', extraAliases: ['sixers', 'philly'] },
  { sport: 'nba', id: '21', abbr: 'PHX', name: 'Phoenix Suns', city: 'Phoenix', nickname: 'Suns' },
  { sport: 'nba', id: '22', abbr: 'POR', name: 'Portland Trail Blazers', city: 'Portland', nickname: 'Trail Blazers', extraAliases: ['blazers'] },
  { sport: 'nba', id: '23', abbr: 'SAC', name: 'Sacramento Kings', city: 'Sacramento', nickname: 'Kings' },
  { sport: 'nba', id: '24', abbr: 'SAS', name: 'San Antonio Spurs', city: 'San Antonio', nickname: 'Spurs', extraAliases: ['sa spurs'] },
  { sport: 'nba', id: '25', abbr: 'OKC', name: 'Oklahoma City Thunder', city: 'Oklahoma City', nickname: 'Thunder' },
  { sport: 'nba', id: '26', abbr: 'UTA', name: 'Utah Jazz', city: 'Utah', nickname: 'Jazz' },
  { sport: 'nba', id: '27', abbr: 'WAS', name: 'Washington Wizards', city: 'Washington', nickname: 'Wizards', extraAliases: ['wsh'] },
  { sport: 'nba', id: '28', abbr: 'TOR', name: 'Toronto Raptors', city: 'Toronto', nickname: 'Raptors', extraAliases: ['raps'] },
  { sport: 'nba', id: '29', abbr: 'MEM', name: 'Memphis Grizzlies', city: 'Memphis', nickname: 'Grizzlies', extraAliases: ['grizz'] },
  { sport: 'nba', id: '30', abbr: 'CHA', name: 'Charlotte Hornets', city: 'Charlotte', nickname: 'Hornets', extraAliases: ['cho'] },

  // NFL (ESPN team IDs)
  { sport: 'nfl', id: '1', abbr: 'ATL', name: 'Atlanta Falcons', city: 'Atlanta', nickname: 'Falcons' },
  { sport: 'nfl', id: '2', abbr: 'BUF', name: 'Buffalo Bills', city: 'Buffalo', nickname: 'Bills' },
  { sport: 'nfl', id: '3', abbr: 'CHI', name: 'Chicago Bears', city: 'Chicago', nickname: 'Bears' },
  { sport: 'nfl', id: '4', abbr: 'CIN', name: 'Cincinnati Bengals', city: 'Cincinnati', nickname: 'Bengals' },
  { sport: 'nfl', id: '5', abbr: 'CLE', name: 'Cleveland Browns', city: 'Cleveland', nickname: 'Browns' },
  { sport: 'nfl', id: '6', abbr: 'DAL', name: 'Dallas Cowboys', city: 'Dallas', nickname: 'Cowboys' },
  { sport: 'nfl', id: '7', abbr: 'DEN', name: 'Denver Broncos', city: 'Denver', nickname: 'Broncos' },
  { sport: 'nfl', id: '8', abbr: 'DET', name: 'Detroit Lions', city: 'Detroit', nickname: 'Lions' },
  { sport: 'nfl', id: '9', abbr: 'GB', name: 'Green Bay Packers', city: 'Green Bay', nickname: 'Packers', extraAliases: ['gbp'] },
  { sport: 'nfl', id: '10', abbr: 'TEN', name: 'Tennessee Titans', city: 'Tennessee', nickname: 'Titans' },
  { sport: 'nfl', id: '11', abbr: 'IND', name: 'Indianapolis Colts', city: 'Indianapolis', nickname: 'Colts', extraAliases: ['indy'] },
  { sport: 'nfl', id: '12', abbr: 'KC', name: 'Kansas City Chiefs', city: 'Kansas City', nickname: 'Chiefs', extraAliases: ['kcc'] },
  { sport: 'nfl', id: '13', abbr: 'LV', name: 'Las Vegas Raiders', city: 'Las Vegas', nickname: 'Raiders', extraAliases: ['vegas raiders', 'lvr'] },
  { sport: 'nfl', id: '14', abbr: 'LAR', name: 'Los Angeles Rams', city: 'Los Angeles', nickname: 'Rams', extraAliases: ['la rams'] },
  { sport: 'nfl', id: '15', abbr: 'MIA', name: 'Miami Dolphins', city: 'Miami', nickname: 'Dolphins', extraAliases: ['fins'] },
  { sport: 'nfl', id: '16', abbr: 'MIN', name: 'Minnesota Vikings', city: 'Minnesota', nickname: 'Vikings', extraAliases: ['vikes'] },
  { sport: 'nfl', id: '17', abbr: 'NE', name: 'New England Patriots', city: 'New England', nickname: 'Patriots', extraAliases: ['pats', 'nep'] },
  { sport: 'nfl', id: '18', abbr: 'NO', name: 'New Orleans Saints', city: 'New Orleans', nickname: 'Saints', extraAliases: ['nos'] },
  { sport: 'nfl', id: '19', abbr: 'NYG', name: 'New York Giants', city: 'New York', nickname: 'Giants', extraAliases: ['ny giants'] },
  { sport: 'nfl', id: '20', abbr: 'NYJ', name: 'New York Jets', city: 'New York', nickname: 'Jets', extraAliases: ['ny jets'] },
  { sport: 'nfl', id: '21', abbr: 'PHI', name: 'Philadelphia Eagles', city: 'Philadelphia', nickname: 'Eagles', extraAliases: ['philly'] },
  { sport: 'nfl', id: '22', abbr: 'ARI', name: 'Arizona Cardinals', city: 'Arizona', nickname: 'Cardinals', extraAliases: ['cards'] },
  { sport: 'nfl', id: '23', abbr: 'PIT', name: 'Pittsburgh Steelers', city: 'Pittsburgh', nickname: 'Steelers' },
  { sport: 'nfl', id: '24', abbr: 'LAC', name: 'Los Angeles Chargers', city: 'Los Angeles', nickname: 'Chargers', extraAliases: ['la chargers', 'bolts'] },
  { sport: 'nfl', id: '25', abbr: 'SF', name: 'San Francisco 49ers', city: 'San Francisco', nickname: '49ers', extraAliases: ['niners', 'sfo'] },
  { sport: 'nfl', id: '26', abbr: 'SEA', name: 'Seattle Seahawks', city: 'Seattle', nickname: 'Seahawks', extraAliases: ['hawks'] },
  { sport: 'nfl', id: '27', abbr: 'TB', name: 'Tampa Bay Buccaneers', city: 'Tampa Bay', nickname: 'Buccaneers', extraAliases: ['bucs', 'tampa', 'tbb'] },
  { sport: 'nfl', id: '28', abbr: 'WAS', name: 'Washington Commanders', city: 'Washington', nickname: 'Commanders', extraAliases: ['wsh'] },
  { sport: 'nfl', id: '29', abbr: 'CAR', name: 'Carolina Panthers', city: 'Carolina', nickname: 'Panthers' },
  { sport: 'nfl', id: '30', abbr: 'JAX', name: 'Jacksonville Jaguars', city: 'Jacksonville', nickname: 'Jaguars', extraAliases: ['jags', 'jac'] },
  { sport: 'nfl', id: '33', abbr: 'BAL', name: 'Baltimore Ravens', city: 'Baltimore', nickname: 'Ravens' },
  { sport: 'nfl', id: '34', abbr: 'HOU', name: 'Houston Texans', city: 'Houston', nickname: 'Texans' },

  // MLB (ESPN team IDs)
  { sport: 'mlb', id: '1', abbr: 'BAL', name: 'Baltimore Orioles', city: 'Baltimore', nickname: 'Orioles' },
  { sport: 'mlb', id: '2', abbr: 'BOS', name: 'Boston Red Sox', city: 'Boston', nickname: 'Red Sox' },
  { sport: 'mlb', id: '3', abbr: 'LAA', name: 'Los Angeles Angels', city: 'Los Angeles', nickname: 'Angels' },
  { sport: 'mlb', id: '4', abbr: 'CHW', name: 'Chicago White Sox', city: 'Chicago', nickname: 'White Sox' },
  { sport: 'mlb', id: '5', abbr: 'CLE', name: 'Cleveland Guardians', city: 'Cleveland', nickname: 'Guardians' },
  { sport: 'mlb', id: '6', abbr: 'DET', name: 'Detroit Tigers', city: 'Detroit', nickname: 'Tigers' },
  { sport: 'mlb', id: '7', abbr: 'KC', name: 'Kansas City Royals', city: 'Kansas City', nickname: 'Royals' },
  { sport: 'mlb', id: '8', abbr: 'MIL', name: 'Milwaukee Brewers', city: 'Milwaukee', nickname: 'Brewers' },
  { sport: 'mlb', id: '9', abbr: 'MIN', name: 'Minnesota Twins', city: 'Minnesota', nickname: 'Twins' },
  { sport: 'mlb', id: '10', abbr: 'NYY', name: 'New York Yankees', city: 'New York', nickname: 'Yankees' },
  { sport: 'mlb', id: '11', abbr: 'OAK', name: 'Athletics', city: 'Oakland', nickname: 'Athletics', extraAliases: ['as', 'ath'] },
  { sport: 'mlb', id: '12', abbr: 'SEA', name: 'Seattle Mariners', city: 'Seattle', nickname: 'Mariners' },
  { sport: 'mlb', id: '13', abbr: 'TEX', name: 'Texas Rangers', city: 'Texas', nickname: 'Rangers' },
  { sport: 'mlb', id: '14', abbr: 'TOR', name: 'Toronto Blue Jays', city: 'Toronto', nickname: 'Blue Jays', extraAliases: ['jays'] },
  { sport: 'mlb', id: '15', abbr: 'ATL', name: 'Atlanta Braves', city: 'Atlanta', nickname: 'Braves' },
  { sport: 'mlb', id: '16', abbr: 'CHC', name: 'Chicago Cubs', city: 'Chicago', nickname: 'Cubs' },
  { sport: 'mlb', id: '17', abbr: 'CIN', name: 'Cincinnati Reds', city: 'Cincinnati', nickname: 'Reds' },
  { sport: 'mlb', id: '18', abbr: 'HOU', name: 'Houston Astros', city: 'Houston', nickname: 'Astros' },
  { sport: 'mlb', id: '19', abbr: 'LAD', name: 'Los Angeles Dodgers', city: 'Los Angeles', nickname: 'Dodgers' },
  { sport: 'mlb', id: '20', abbr: 'WSH', name: 'Washington Nationals', city: 'Washington', nickname: 'Nationals', extraAliases: ['nats'] },
  { sport: 'mlb', id: '21', abbr: 'NYM', name: 'New York Mets', city: 'New York', nickname: 'Mets' },
  { sport: 'mlb', id: '22', abbr: 'PHI', name: 'Philadelphia Phillies', city: 'Philadelphia', nickname: 'Phillies' },
  { sport: 'mlb', id: '23', abbr: 'PIT', name: 'Pittsburgh Pirates', city: 'Pittsburgh', nickname: 'Pirates' },
  { sport: 'mlb', id: '24', abbr: 'STL', name: 'St. Louis Cardinals', city: 'St. Louis', nickname: 'Cardinals', extraAliases: ['cards'] },
  { sport: 'mlb', id: '25', abbr: 'SD', name: 'San Diego Padres', city: 'San Diego', nickname: 'Padres' },
  { sport: 'mlb', id: '26', abbr: 'SF', name: 'San Francisco Giants', city: 'San Francisco', nickname: 'Giants' },
  { sport: 'mlb', id: '27', abbr: 'COL', name: 'Colorado Rockies', city: 'Colorado', nickname: 'Rockies' },
  { sport: 'mlb', id: '28', abbr: 'MIA', name: 'Miami Marlins', city: 'Miami', nickname: 'Marlins' },
  { sport: 'mlb', id: '29', abbr: 'ARI', name: 'Arizona Diamondbacks', city: 'Arizona', nickname: 'Diamondbacks', extraAliases: ['dbacks', 'd-backs'] },
  { sport: 'mlb', id: '30', abbr: 'TB', name: 'Tampa Bay Rays', city: 'Tampa Bay', nickname: 'Rays' }
];

export const ESPN_TEAMS: EspnTeamEntry[] = RAW_TEAMS.map(t => {
  const aliases = Array.from(
    new Set(
      [
        t.name.toLowerCase(),
        t.abbr.toLowerCase(),
        t.city.toLowerCase(),
        t.nickname.toLowerCase(),
        ...(t.extraAliases || []).map(a => a.toLowerCase())
      ].filter(Boolean)
    )
  );
  return {
    sport: t.sport,
    id: t.id,
    abbr: t.abbr,
    name: t.name,
    city: t.city,
    nickname: t.nickname,
    aliases
  };
});

export function normalizeSportHint(hint?: string): 'nhl' | 'nba' | 'nfl' | 'mlb' | undefined {
  if (!hint || typeof hint !== 'string') return undefined;
  const s = hint.toLowerCase().trim();
  if (s.startsWith('nhl') || s.includes('hockey') || s.includes('nhl')) return 'nhl';
  if (s.startsWith('nba') || s.includes('basketball') || s.includes('nba')) return 'nba';
  if (s.startsWith('nfl') || s.includes('football') || s.includes('nfl')) return 'nfl';
  if (s.startsWith('mlb') || s.includes('baseball') || s.includes('mlb')) return 'mlb';
  return undefined;
}

export function matchTeamByLabel(label: string, sportHint?: string): EspnTeamEntry | undefined {
  if (!label || typeof label !== 'string') return undefined;
  const cleaned = label
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-zA-Z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned || /^\d+$/.test(cleaned)) return undefined;

  const parentheticalMatch = label.match(/\(([A-Za-z]{2,4})\)/);
  const parenAbbr = parentheticalMatch ? parentheticalMatch[1].toLowerCase() : '';

  const sport = normalizeSportHint(sportHint);
  const candidates = sport ? ESPN_TEAMS.filter(t => t.sport === sport) : ESPN_TEAMS;

  // 1. Exact full name or abbr match
  for (const t of candidates) {
    if (t.name.toLowerCase() === cleaned || t.abbr.toLowerCase() === cleaned || (parenAbbr && t.abbr.toLowerCase() === parenAbbr)) {
      return t;
    }
  }
  // 2. Exact nickname or city or alias match
  for (const t of candidates) {
    if (t.aliases.includes(cleaned)) {
      return t;
    }
  }
  // 3. Substring match on full name or nickname
  for (const t of candidates) {
    if (cleaned.includes(t.name.toLowerCase()) || cleaned.includes(t.nickname.toLowerCase())) {
      return t;
    }
  }
  // If sportHint narrowed too far, try all sports on exact name/nickname
  if (sport) {
    for (const t of ESPN_TEAMS) {
      if (t.name.toLowerCase() === cleaned || t.nickname.toLowerCase() === cleaned) {
        return t;
      }
    }
  }
  return undefined;
}

export function resolveEspnTeam(
  rawTeamId: string,
  sportHint?: string,
  matchupTeams?: string[]
): EspnTeamEntry | undefined {
  const id = String(rawTeamId || '').trim();
  if (!id) return undefined;

  let sport = normalizeSportHint(sportHint);
  const cleanMatchup = (matchupTeams || [])
    .map(m => (typeof m === 'string' ? m.trim() : ''))
    .filter(m => m && !/^(away|home|unknown|tbd)$/i.test(m));

  if (!sport && cleanMatchup.length > 0) {
    for (const m of cleanMatchup) {
      const matched = matchTeamByLabel(m);
      if (matched) {
        sport = matched.sport;
        break;
      }
    }
  }

  // If matchup teams are known, check if rawTeamId matches one of the matchup teams in its sport
  if (cleanMatchup.length > 0) {
    const resolvedMatchupEntries = cleanMatchup
      .map(m => matchTeamByLabel(m, sport))
      .filter((e): e is EspnTeamEntry => Boolean(e));
    for (const entry of resolvedMatchupEntries) {
      if (entry.id === id || entry.abbr.toLowerCase() === id.toLowerCase() || entry.name.toLowerCase() === id.toLowerCase()) {
        return entry;
      }
    }
  }

  if (sport) {
    const byId = ESPN_TEAMS.find(t => t.sport === sport && t.id === id);
    if (byId) return byId;
    const byLabel = matchTeamByLabel(id, sport);
    if (byLabel) return byLabel;
  }

  // Unique high-number ESPN IDs (like 129764 for Utah Mammoth, 124292 for Seattle Kraken, 33 for BAL, 34 for HOU, 37 for VGK)
  const exactIdMatches = ESPN_TEAMS.filter(t => t.id === id);
  if (exactIdMatches.length === 1) {
    return exactIdMatches[0];
  }

  if (!/^\d+$/.test(id)) {
    return matchTeamByLabel(id, sport);
  }

  return undefined;
}

export function isUnclearTeamLabel(label: unknown): boolean {
  if (typeof label !== 'string') return true;
  const trimmed = label.trim();
  if (!trimmed) return true;
  if (/^(unknown|unk|null|undefined|none|n\/a|na|tbd|\?+)$/i.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) return true;
  return false;
}

export interface ResolvedInjuryTeam {
  label: string;
  abbr: string;
  name: string;
  teamId?: string;
}

/**
 * Resolves the authoritative team for an injury item from tool or board payloads.
 * Returns null if the team is unclear or cannot be resolved to a real team name/abbr.
 */
export function resolveInjuryTeam(
  injury: Record<string, any>,
  options?: {
    teamLabelMap?: Map<string, string>;
    sportHint?: string;
    matchupTeams?: string[];
  }
): ResolvedInjuryTeam | null {
  if (!injury || typeof injury !== 'object') return null;

  const rawTeamId = injury.team_id !== undefined && injury.team_id !== null ? String(injury.team_id).trim() : '';
  const directAbbr = typeof injury.team_abbr === 'string' ? injury.team_abbr.trim() : '';
  const directName = typeof injury.team_name === 'string' ? injury.team_name.trim() : '';
  const directTeam = typeof injury.team === 'string' ? injury.team.trim() : '';
  const directCandidate = directName || directAbbr || directTeam;

  const mappedFromGame = rawTeamId && options?.teamLabelMap ? options.teamLabelMap.get(rawTeamId) : undefined;
  const espnEntry =
    resolveEspnTeam(rawTeamId, options?.sportHint, options?.matchupTeams) ||
    (directCandidate ? matchTeamByLabel(directCandidate, options?.sportHint) : undefined) ||
    (mappedFromGame ? matchTeamByLabel(mappedFromGame, options?.sportHint) : undefined);

  // If game context explicitly provided a label in teamLabelMap (e.g. 'BAL' or 'Minnesota Wild'), preserve it if clear
  if (mappedFromGame && !isUnclearTeamLabel(mappedFromGame)) {
    return {
      label: mappedFromGame.trim(),
      abbr: espnEntry?.abbr || directAbbr || mappedFromGame.trim(),
      name: espnEntry?.name || directName || mappedFromGame.trim(),
      ...(rawTeamId ? { teamId: rawTeamId } : {})
    };
  }

  if (directCandidate && !isUnclearTeamLabel(directCandidate)) {
    const label =
      directName && directAbbr && !directName.includes(directAbbr)
        ? `${directName} (${directAbbr})`
        : espnEntry && directCandidate.length <= 4
          ? `${espnEntry.name} (${espnEntry.abbr})`
          : directCandidate;
    return {
      label,
      abbr: directAbbr || espnEntry?.abbr || directCandidate,
      name: directName || espnEntry?.name || directCandidate,
      ...(rawTeamId ? { teamId: rawTeamId } : {})
    };
  }

  if (espnEntry) {
    return {
      label: `${espnEntry.name} (${espnEntry.abbr})`,
      abbr: espnEntry.abbr,
      name: espnEntry.name,
      ...(rawTeamId ? { teamId: rawTeamId } : {})
    };
  }

  // Team is unclear (e.g. missing or bare numeric team_id with no resolution) -> drop!
  return null;
}

export interface AuthoritativeInjury {
  eventId?: string;
  sport?: 'nhl' | 'nba' | 'nfl' | 'mlb';
  playerName: string;
  lastName: string;
  status: string;
  teamLabel: string;
  teamEntry?: EspnTeamEntry;
  teamAliases: string[];
  opposingAliases: string[];
  opposingTeamName?: string;
}

function extractLastName(fullName: string): string {
  const cleaned = fullName
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(Jr\.?|Sr\.?|II|III|IV|V)\b/gi, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[parts.length - 1].replace(/[^a-zA-Z'-]/g, '');
}

function buildAliasesForLabel(label: string, entry?: EspnTeamEntry): string[] {
  const set = new Set<string>();
  if (entry) {
    for (const a of entry.aliases) set.add(a.toLowerCase());
    set.add(entry.name.toLowerCase());
    set.add(entry.abbr.toLowerCase());
    set.add(entry.city.toLowerCase());
    set.add(entry.nickname.toLowerCase());
  }
  const cleanLabel = label.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (cleanLabel && !/^\d+$/.test(cleanLabel)) {
    set.add(cleanLabel);
    for (const tok of cleanLabel.split(/\s+/)) {
      if (tok.length >= 3) set.add(tok);
    }
  }
  const paren = label.match(/\(([A-Za-z]{2,4})\)/);
  if (paren) set.add(paren[1].toLowerCase());
  return Array.from(set).filter(Boolean);
}

/**
 * Extracts authoritative player->team injury bindings from tool results, verifier evidence, and board text.
 */
export function extractAuthoritativeInjuries(evidenceText: string, slateText?: string): AuthoritativeInjury[] {
  const combinedSource = `${slateText || ''}\n${evidenceText || ''}`;
  const headers: GameHeader[] = parseGameHeaders(combinedSource);

  // Also scan EVENT lines in verifierEvidence ("EVENT nhl-401892736 Nashville Predators @ Minnesota Wild")
  const eventLineRegex = /EVENT\s+([a-z0-9-]+)(?:\s+\([^)]*\))?(?:\s*:)?\s+([^\n@]+?)\s*@\s*([^\n\[]+)/gi;
  let evMatch: RegExpExecArray | null;
  while ((evMatch = eventLineRegex.exec(combinedSource)) !== null) {
    const evId = evMatch[1].trim();
    const away = evMatch[2].trim();
    const home = evMatch[3].trim();
    if (evId && !headers.some(h => h.eventId === evId)) {
      headers.push({
        eventId: evId,
        sport: normalizeSportHint(evId) || 'unknown',
        away,
        home,
        options: []
      });
    }
  }

  // Also scan raw "Away @ Home" lines if headers is still empty
  if (headers.length === 0) {
    const simpleMatchupRegex = /\b([A-Z][A-Za-z.\s]{2,25}?)\s+(?:@|vs\.?|versus)\s+([A-Z][A-Za-z.\s]{2,25})\b/g;
    let mMatch: RegExpExecArray | null;
    while ((mMatch = simpleMatchupRegex.exec(combinedSource)) !== null) {
      const away = mMatch[1].trim();
      const home = mMatch[2].trim();
      const awayEntry = matchTeamByLabel(away);
      const homeEntry = matchTeamByLabel(home, awayEntry?.sport);
      if (awayEntry && homeEntry && awayEntry.abbr !== homeEntry.abbr) {
        headers.push({
          eventId: `${awayEntry.sport}-matchup`,
          sport: awayEntry.sport,
          away: awayEntry.name,
          home: homeEntry.name,
          options: []
        });
      }
    }
  }

  const headerById = new Map<string, GameHeader>();
  for (const h of headers) {
    if (h.eventId) headerById.set(h.eventId, h);
  }

  const results: AuthoritativeInjury[] = [];
  const seenKey = new Set<string>();

  const addBinding = (
    rawTeam: string,
    rawPlayer: string,
    rawStatus: string,
    eventId?: string
  ) => {
    const playerName = rawPlayer
      .replace(/\([A-Z0-9/-]{1,5}\)/g, '')
      .replace(/\(shift:[^)]*\)/gi, '')
      .trim();
    if (!playerName || playerName.length < 3 || /^(none|unknown|no significant|no injuries)/i.test(playerName)) {
      return;
    }

    const hdr = eventId ? headerById.get(eventId) : headers[0];
    const sportHint = eventId || hdr?.sport;
    const matchupTeams = hdr ? [hdr.away, hdr.home] : undefined;

    const resolved = resolveInjuryTeam(
      /^\d+$/.test(rawTeam.trim()) ? { team_id: rawTeam.trim() } : { team_name: rawTeam.trim() },
      { sportHint, matchupTeams }
    );
    if (!resolved) return;

    const teamEntry =
      matchTeamByLabel(resolved.name, sportHint) ||
      matchTeamByLabel(resolved.abbr, sportHint) ||
      resolveEspnTeam(rawTeam, sportHint, matchupTeams);

    const teamAliases = buildAliasesForLabel(resolved.label, teamEntry);
    if (teamAliases.length === 0) return;

    // Determine opposing team(s) for this game or slate
    const opposingSet = new Set<string>();
    let opposingTeamName: string | undefined;

    const addOpponentFromLabel = (oppLabel: string) => {
      if (!oppLabel || /^(away|home|unknown)$/i.test(oppLabel.trim())) return;
      const oppEntry = matchTeamByLabel(oppLabel, teamEntry?.sport || sportHint);
      if (oppEntry && teamEntry && oppEntry.abbr === teamEntry.abbr && oppEntry.sport === teamEntry.sport) {
        return;
      }
      const oppAliases = buildAliasesForLabel(oppLabel, oppEntry);
      if (oppAliases.some(a => teamAliases.includes(a) && a !== teamEntry?.city.toLowerCase())) {
        return;
      }
      if (!opposingTeamName) {
        opposingTeamName = oppEntry ? `${oppEntry.name} (${oppEntry.abbr})` : oppLabel;
      }
      for (const a of oppAliases) {
        if (!teamAliases.includes(a)) opposingSet.add(a);
      }
    };

    if (hdr) {
      addOpponentFromLabel(hdr.away);
      addOpponentFromLabel(hdr.home);
    }
    for (const h of headers) {
      if (!hdr || h.eventId === hdr.eventId) {
        addOpponentFromLabel(h.away);
        addOpponentFromLabel(h.home);
      }
    }

    // Also include other teams in the same sport as fallback wrong-team aliases
    const targetSport = teamEntry?.sport || normalizeSportHint(sportHint);
    if (targetSport) {
      for (const other of ESPN_TEAMS) {
        if (other.sport !== targetSport) continue;
        if (teamEntry && other.abbr === teamEntry.abbr) continue;
        for (const a of other.aliases) {
          if (!teamAliases.includes(a) && a.length >= 3) {
            opposingSet.add(a);
          }
        }
      }
    }

    const lastName = extractLastName(playerName);
    const key = `${(teamEntry?.abbr || resolved.abbr).toUpperCase()}::${playerName.toLowerCase()}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);

    results.push({
      eventId,
      sport: targetSport,
      playerName,
      lastName,
      status: rawStatus.toUpperCase(),
      teamLabel: resolved.label,
      teamEntry,
      teamAliases,
      opposingAliases: Array.from(opposingSet),
      opposingTeamName
    });
  };

  let currentEventId: string | undefined;
  const lines = combinedSource.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const evHeaderMatch =
      line.match(/^EVENT\s+([a-z0-9-]+)/i) ||
      line.match(/\[INJURY(?:\s*&\s*ROSTER\s*DELTA)?:\s*([a-z0-9-]+)/i) ||
      line.match(/^([a-z]{3}-\d+):/i);
    if (evHeaderMatch) {
      currentEventId = evHeaderMatch[1].trim();
    }

    // Parse "Injuries: TeamA:Player1(out), TeamB:Player2(questionable)" from gameContext.ts
    if (/^Injuries:/i.test(line)) {
      const body = line.replace(/^Injuries:\s*/i, '');
      for (const part of body.split(',')) {
        const m = part.trim().match(/^([^:]+):([^(]+)\(([^)]+)\)$/);
        if (m) {
          addBinding(m[1].trim(), m[2].trim(), m[3].trim(), currentEventId);
        }
      }
      continue;
    }

    // Parse "[INJURY: event_id] PHI: Joel Embiid (Out); CLE: Evan Mobley (Out)"
    const inlineBracketMatch = line.match(/^\[INJURY[^:\]]*:\s*([a-z0-9-]+)\]\s*(.+)$/i);
    if (inlineBracketMatch) {
      const evId = inlineBracketMatch[1].trim();
      const rest = inlineBracketMatch[2].trim();
      for (const seg of rest.split(';')) {
        const m = seg.trim().match(/^([^:]+):\s*([^(]+)\(([^)]+)\)/);
        if (m) {
          addBinding(m[1].trim(), m[2].trim(), m[3].trim(), evId);
        }
      }
    }

    // Parse "INJ: TeamA: Player1: OUT; Player2: QUESTIONABLE | TeamB: Player3: OUT"
    // or "TeamA: Player1 (OUT), Player2 (OUT). TeamB: Player3 (OUT)"
    const normalizedSegments = line
      .replace(/^\[INJURY\s*&\s*ROSTER\s*DELTA:[^\]]*\]\s*;?\s*/i, '')
      .replace(/^\[INJURY:[^\]]*\]\s*;?\s*/i, '')
      .replace(/^INJ:\s*/i, '')
      .split(/\s*\|\s*|\s*;\s*(?=-\s*[A-Za-z])|\.\s+(?=[A-Z][A-Za-z.\s'-]{2,35}:\s)/);

    for (const seg of normalizedSegments) {
      const cleanSeg = seg.replace(/^-\s*/, '').trim();
      if (!cleanSeg || /^no\s+(?:significant|injuries)/i.test(cleanSeg)) continue;
      if (/^\[(?:risk|critic|quant|market|analyst|manager|a\d+|seat|specialist|proposer)/i.test(cleanSeg)) continue;

      const colonIdx = cleanSeg.indexOf(':');
      if (colonIdx <= 0) continue;

      const candidateTeam = cleanSeg.slice(0, colonIdx).trim();
      const playersPart = cleanSeg.slice(colonIdx + 1).trim();
      if (
        !candidateTeam ||
        candidateTeam.length > 42 ||
        /[\[\]]/.test(candidateTeam) ||
        /^(event_id|sport|options|task|summary|analysis|pick|reason|verdict|fund|mkt|verified|pass|note|warning|veto|bottom-line|market check)/i.test(candidateTeam)
      ) {
        continue;
      }

      for (const pItem of playersPart.split(/[;,]/)) {
        const trimmedP = pItem.replace(/\.+$/, '').trim();
        if (!trimmedP) continue;
        const colonMatch = trimmedP.match(/^([^:]+):\s*(OUT|DOUBTFUL|QUESTIONABLE|PROBABLE|IR|INJURED\s+RESERVE|SUSPENDED)\b/i);
        if (colonMatch) {
          addBinding(candidateTeam, colonMatch[1].trim(), colonMatch[2].trim(), currentEventId);
          continue;
        }
        const parenMatch = trimmedP.match(/^([^(]+)\((OUT|DOUBTFUL|QUESTIONABLE|PROBABLE|IR|INJURED\s+RESERVE|SUSPENDED)\)/i);
        if (parenMatch) {
          addBinding(candidateTeam, parenMatch[1].trim(), parenMatch[2].trim(), currentEventId);
        }
      }
    }
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsAliasWord(textLower: string, alias: string): boolean {
  if (!alias) return false;
  const rx = new RegExp(`\\b${escapeRegex(alias.toLowerCase())}\\b`, 'i');
  return rx.test(textLower);
}

/**
 * Checks whether a single text clause or reason misattributes any known injured player to the wrong team.
 */
export function findClauseInjuryMisattribution(
  clause: string,
  injuries: AuthoritativeInjury[],
  selectedSideHint?: string
): string | null {
  if (!clause || typeof clause !== 'string' || injuries.length === 0) return null;
  const textLower = clause.toLowerCase();

  // Count how many distinct teams share a given last name so we only use bare lastName when unambiguous
  const lastNameTeamCount = new Map<string, Set<string>>();
  for (const inj of injuries) {
    if (!inj.lastName || inj.lastName.length < 4) continue;
    const key = inj.lastName.toLowerCase();
    if (!lastNameTeamCount.has(key)) lastNameTeamCount.set(key, new Set());
    lastNameTeamCount.get(key)!.add(inj.teamLabel);
  }

  for (const inj of injuries) {
    const fullNameLower = inj.playerName.toLowerCase();
    const lastNameLower = inj.lastName.toLowerCase();
    const isUniqueLastName =
      lastNameLower.length >= 4 &&
      (lastNameTeamCount.get(lastNameLower)?.size ?? 0) === 1 &&
      !inj.teamAliases.includes(lastNameLower) &&
      !inj.opposingAliases.includes(lastNameLower);

    const hasFullName = containsAliasWord(textLower, fullNameLower);
    const hasLastName = isUniqueLastName && containsAliasWord(textLower, lastNameLower);
    if (!hasFullName && !hasLastName) continue;

    const matchedPlayerToken = hasFullName ? inj.playerName : inj.lastName;
    const playerPattern = hasFullName
      ? `(?:${escapeRegex(inj.playerName)}|${escapeRegex(inj.lastName)})`
      : escapeRegex(inj.lastName);

    const mentionsOwnTeam = inj.teamAliases.some(alias => containsAliasWord(textLower, alias));
    const matchedWrongAliases = inj.opposingAliases.filter(alias => containsAliasWord(textLower, alias));

    if (matchedWrongAliases.length > 0) {
      // Case 1: Clause names the injured player AND a wrong team, and never mentions the player's own team at all
      if (!mentionsOwnTeam) {
        const wrongDisplay = inj.opposingTeamName || matchedWrongAliases[0].toUpperCase();
        return `Injury misattribution: ${inj.playerName} (${inj.status}) belongs to ${inj.teamLabel}, not ${wrongDisplay}.`;
      }

      // Case 2: Both teams appear in the text; check if the wrong team directly modifies/claims the player
      for (const wrongAlias of matchedWrongAliases) {
        const wEsc = escapeRegex(wrongAlias);
        const roleWords = `(?:starting\\s+|backup\\s+|star\\s+|key\\s+|no\\.\\s*1\\s+|#1\\s+|primary\\s+|top\\s+|injured\\s+|sidelined\\s+)*(?:goalie\\s+|goaltender\\s+|netminder\\s+|qb\\s+|quarterback\\s+|center\\s+|forward\\s+|guard\\s+|wing\\s+|winger\\s+|defenseman\\s+|defender\\s+|starter\\s+|ace\\s+|pitcher\\s+|scorer\\s+|player\\s+)?`;

        // Pattern A: "<WrongTeam>'s starting goalie <Player>"
        const patA = new RegExp(`\\b${wEsc}(?:'s)?\\s+${roleWords}${playerPattern}\\b`, 'i');
        // Pattern B: "<WrongTeam> is missing/without ... <Player>"
        const patB = new RegExp(
          `\\b${wEsc}\\s+(?:is\\s+|are\\s+)?(?:missing|without|lacking|down|minus|loses|lost)\\s+${roleWords}(?:[a-z]+\\s+){0,2}?${playerPattern}\\b`,
          'i'
        );
        // Pattern C: "<Player> is OUT for <WrongTeam>"
        const patC = new RegExp(
          `\\b${playerPattern}\\b[^.;,()]{0,35}?\\b(?:out|doubtful|questionable|injured|sidelined|absent|scratched)\\s+(?:for|on|with)\\s+(?:the\\s+)?${wEsc}\\b`,
          'i'
        );
        // Pattern D: "<Player> (<WrongTeam>)"
        const patD = new RegExp(`\\b${playerPattern}\\s*\\(\\s*${wEsc}\\b`, 'i');

        if (patA.test(clause) || patB.test(clause) || patC.test(clause) || patD.test(clause)) {
          const wrongDisplay = inj.opposingTeamName || wrongAlias.toUpperCase();
          return `Injury misattribution: ${matchedPlayerToken} (${inj.status}) belongs to ${inj.teamLabel}, not ${wrongDisplay}.`;
        }
      }
    }

    // Case 3: A pick is on the player's own team, and the reason calls the player "opposing goalie <Player>"
    if (selectedSideHint && inj.teamAliases.some(a => containsAliasWord(selectedSideHint.toLowerCase(), a))) {
      const oppRolePattern = new RegExp(
        `\\b(?:opposing|opponent(?:'s)?|their)\\s+(?:starting\\s+|backup\\s+|star\\s+)?(?:goalie\\s+|goaltender\\s+|qb\\s+|quarterback\\s+|player\\s+|starter\\s+)?${playerPattern}\\b`,
        'i'
      );
      if (oppRolePattern.test(clause)) {
        return `Injury misattribution: ${inj.playerName} (${inj.status}) belongs to ${inj.teamLabel}, not the opposing team.`;
      }
    }
  }

  return null;
}

export interface InjuryVetoLegTarget {
  rowId?: string;
  eventId?: string;
  teamLabel?: string;
  teamAliases: string[];
  reason: string;
}

function buildInjuryVetoTarget(pk: any, reason: string, headers: GameHeader[]): InjuryVetoLegTarget | null {
  if (!pk) return null;
  if (typeof pk === 'string') {
    const rMatch = pk.match(/\b(R\d+)\b/i);
    const rowId = rMatch ? rMatch[1].toUpperCase() : undefined;
    const entry = matchTeamByLabel(pk);
    const aliases = entry ? buildAliasesForLabel(entry.name, entry) : [];
    if (!rowId && aliases.length === 0) return null;
    return {
      ...(rowId ? { rowId } : {}),
      ...(entry ? { teamLabel: `${entry.name} (${entry.abbr})` } : {}),
      teamAliases: aliases,
      reason: reason.slice(0, 140)
    };
  }
  if (typeof pk !== 'object') return null;
  let rowId = typeof pk.row === 'string' && /^R\d+$/i.test(pk.row.trim())
    ? pk.row.trim().toUpperCase()
    : (typeof pk.id === 'string' && /^R\d+$/i.test(pk.id.trim()) ? pk.id.trim().toUpperCase() : undefined);
  const sideText = [pk.side, pk.pick, pk.selection, pk.team, pk.note]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join(' ')
    .trim();
  if (!rowId && sideText) {
    const m = sideText.match(/\b(R\d+)\b/i);
    if (m) rowId = m[1].toUpperCase();
  }
  const eventId = typeof pk.event_id === 'string' && pk.event_id.trim()
    ? pk.event_id.trim()
    : (typeof pk.eventId === 'string' && pk.eventId.trim() ? pk.eventId.trim() : undefined);
  const hdr = eventId ? headers.find(h => h.eventId === eventId) : undefined;
  const entry = sideText ? matchTeamByLabel(sideText, hdr?.sport) : undefined;
  const aliases = entry ? buildAliasesForLabel(entry.name, entry) : [];
  if (!rowId && aliases.length === 0) return null;
  return {
    ...(rowId ? { rowId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(entry ? { teamLabel: `${entry.name} (${entry.abbr})` } : (sideText ? { teamLabel: sideText } : {})),
    teamAliases: aliases,
    reason: reason.slice(0, 140)
  };
}

/**
 * Audits a full proposal or analyst report for any injury team misattribution.
 */
export function auditInjuryAttribution(
  proposal: any,
  evidenceText: string,
  slateText?: string
): { pass: boolean; violations: string[]; feedback?: string; vetoedLegs?: InjuryVetoLegTarget[] } {
  const injuries = extractAuthoritativeInjuries(evidenceText, slateText);
  if (injuries.length === 0 || !proposal) {
    return { pass: true, violations: [] };
  }

  const headers = parseGameHeaders(slateText || evidenceText || '');
  const violations: string[] = [];
  const vetoedLegs: InjuryVetoLegTarget[] = [];
  const checkText = (text: unknown, sideHint?: string, onViolation?: (v: string) => void) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const clauses = text.split(/(?<=[.!?])\s+|\n+|;\s+/);
    for (const c of clauses) {
      const v = findClauseInjuryMisattribution(c, injuries, sideHint);
      if (v) {
        if (!violations.includes(v)) violations.push(v);
        onViolation?.(v);
      }
    }
  };

  if (typeof proposal === 'string') {
    checkText(proposal);
  } else if (typeof proposal === 'object') {
    checkText(proposal.summary);
    checkText(proposal.analysis);
    checkText(proposal.reason);
    checkText(proposal.rationale);
    checkText(proposal.conclusion);

    if (Array.isArray(proposal.insights)) {
      for (const ins of proposal.insights) checkText(ins);
    }
    if (Array.isArray(proposal.anomalies)) {
      for (const anom of proposal.anomalies) checkText(anom);
    }
    if (Array.isArray(proposal.picks)) {
      for (const pk of proposal.picks) {
        if (!pk || typeof pk !== 'object') {
          checkText(pk, undefined, (v) => {
            const target = buildInjuryVetoTarget(pk, v, headers);
            if (target) vetoedLegs.push(target);
          });
          continue;
        }
        const sideHint = String(pk.side || pk.pick || pk.selection || pk.team || '');
        const onPickV = (v: string) => {
          const target = buildInjuryVetoTarget(pk, v, headers);
          if (target) vetoedLegs.push(target);
        };
        checkText(pk.reason, sideHint, onPickV);
        checkText(pk.rationale, sideHint, onPickV);
        checkText(pk.edge, sideHint, onPickV);
        checkText(pk.note, sideHint, onPickV);
        checkText(pk.description, sideHint, onPickV);
        checkText(pk.claim, sideHint, onPickV);
        if (Array.isArray(pk.reasons)) {
          for (const r of pk.reasons) checkText(r, sideHint, onPickV);
        }
      }
    }
    if (Array.isArray(proposal.scorecards)) {
      for (const sc of proposal.scorecards) {
        if (!sc || typeof sc !== 'object') continue;
        const sideHint = String(sc.pick || sc.side || '');
        const onScV = (v: string) => {
          const target = buildInjuryVetoTarget(sc, v, headers);
          if (target) vetoedLegs.push(target);
        };
        checkText(sc.note, sideHint, onScV);
        checkText(sc.reason, sideHint, onScV);
        checkText(sc.summary, sideHint, onScV);
        if (Array.isArray(sc.reasons)) {
          for (const r of sc.reasons) checkText(r, sideHint, onScV);
        }
      }
    }
    if (proposal.scorecard && typeof proposal.scorecard === 'object') {
      const sc = proposal.scorecard;
      const sideHint = String(sc.pick || sc.side || '');
      const onScV = (v: string) => {
        const target = buildInjuryVetoTarget(sc, v, headers);
        if (target) vetoedLegs.push(target);
      };
      checkText(sc.note, sideHint, onScV);
      checkText(sc.reason, sideHint, onScV);
      checkText(sc.summary, sideHint, onScV);
    }
  }

  if (violations.length > 0) {
    return {
      pass: false,
      violations,
      feedback: `Veto (INJURY ATTRIBUTION RULE): ${violations.join(' ')}`,
      ...(vetoedLegs.length > 0 ? { vetoedLegs } : {})
    };
  }

  return { pass: true, violations: [] };
}

/**
 * Filters out any pick legs from an analyst or manager report whose reason attributes an injury to the wrong team,
 * and strips misattributed clauses from summary/analysis/insights/components.
 */
export function sanitizeMisattributedPicksAndText<T extends Record<string, any>>(
  report: T,
  evidenceText: string,
  slateText?: string
): T {
  const injuries = extractAuthoritativeInjuries(evidenceText, slateText);
  if (injuries.length === 0 || !report || typeof report !== 'object') {
    return report;
  }

  const cleanClauses = (text: string, sideHint?: string): string => {
    const parts = text.split(/(?<=[.!?])\s+/);
    const kept = parts.filter(part => !findClauseInjuryMisattribution(part, injuries, sideHint));
    return kept.join(' ').trim();
  };

  const rep = report as Record<string, any>;

  if (Array.isArray(rep.picks)) {
    rep.picks = rep.picks.filter((pk: any) => {
      if (!pk || typeof pk !== 'object') {
        return !findClauseInjuryMisattribution(String(pk || ''), injuries);
      }
      const sideHint = String(pk.side || pk.pick || pk.selection || pk.team || '');
      const reasonTexts = [
        pk.reason,
        pk.rationale,
        pk.edge,
        pk.note,
        pk.description,
        pk.claim,
        ...(Array.isArray(pk.reasons) ? pk.reasons : [])
      ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);

      for (const rText of reasonTexts) {
        if (findClauseInjuryMisattribution(rText, injuries, sideHint)) {
          return false;
        }
      }
      return true;
    });
  }

  if (Array.isArray(rep.scorecards)) {
    rep.scorecards = rep.scorecards.filter((sc: any) => {
      if (!sc || typeof sc !== 'object') return true;
      const sideHint = String(sc.pick || sc.side || '');
      const texts = [sc.note, sc.reason, sc.summary, ...(Array.isArray(sc.reasons) ? sc.reasons : [])]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      return !texts.some(t => Boolean(findClauseInjuryMisattribution(t, injuries, sideHint)));
    });
  }

  if (typeof rep.summary === 'string' && rep.summary.trim()) {
    rep.summary = cleanClauses(rep.summary);
  }
  if (typeof rep.analysis === 'string' && rep.analysis.trim()) {
    rep.analysis = cleanClauses(rep.analysis);
  }
  if (Array.isArray(rep.insights)) {
    rep.insights = rep.insights
      .map((ins: any) => (typeof ins === 'string' ? cleanClauses(ins) : ins))
      .filter((ins: any) => typeof ins !== 'string' || ins.trim().length > 0);
  }
  if (Array.isArray(rep.components)) {
    for (const comp of rep.components) {
      if (!comp || typeof comp !== 'object' || !comp.props) continue;
      if (comp.type === 'InsightList' && Array.isArray(comp.props.insights)) {
        comp.props.insights = comp.props.insights
          .map((ins: any) => {
            if (typeof ins === 'string') return cleanClauses(ins);
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') {
              return { ...ins, message: cleanClauses(ins.message) };
            }
            return ins;
          })
          .filter((ins: any) => {
            if (typeof ins === 'string') return ins.trim().length > 0;
            if (ins && typeof ins === 'object' && typeof ins.message === 'string') return ins.message.trim().length > 0;
            return true;
          });
      } else if (comp.type === 'MetricCard' && typeof comp.props.subtitle === 'string') {
        comp.props.subtitle = cleanClauses(comp.props.subtitle);
      } else if (comp.type === 'DataTable' && Array.isArray(comp.props.rows)) {
        for (const row of comp.props.rows) {
          if (!row || typeof row !== 'object') continue;
          for (const key of Object.keys(row)) {
            if (typeof row[key] === 'string' && row[key].trim()) {
              row[key] = cleanClauses(row[key]);
            }
          }
        }
      }
    }
  }

  return report;
}


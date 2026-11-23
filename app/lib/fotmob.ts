// Intégration FotMob (flux JSON public non-officiel : https://www.fotmob.com/api/data/...)
// Utilisé pour enrichir l'analyse ESPN avec :
// - Blessés, suspendus & incertains (pondérés par valeur/importance dans les xG Poisson)
// - Vrais xG / xGA de saison et du match (lorsque coverageLevel === 'xG' ou table xG dispo)
// - Arbitre désigné & statistiques disciplinaires (cartons/fautes/penalties par match)
// - Entraîneurs & schémas tactiques
// - Historique multi-saisons des confrontations directes (H2H)
// - Météo & insights FotMob/Opta

const FOTMOB_BASE = 'https://www.fotmob.com/api/data';
const FOTMOB_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Correspondance ligues ESPN -> FotMob primaryId / id
export const ESPN_TO_FOTMOB_LEAGUE: Record<string, number[]> = {
  'eng.1': [47],
  'esp.1': [87],
  'ita.1': [55],
  'ger.1': [54],
  'fra.1': [53],
  'ned.1': [57],
  'por.1': [61],
  'bel.1': [40, 41],
  'sco.1': [64, 181],
  'tur.1': [71],
  'uefa.champions': [42, 10611],
  'uefa.europa': [73, 10613],
  'usa.1': [130, 957981],
  'mex.1': [230],
  'bra.1': [268],
  'arg.1': [112, 10007],
};

// Cache mémoire court côté serveur (évite de marteler FotMob lors d'un scan de journée)
type CacheEntry<T> = { expiresAt: number; value: T };
const memoryCache = new Map<string, CacheEntry<any>>();

async function fetchFotmobJson<T = any>(pathWithQuery: string, ttlSeconds = 300, timeoutMs = 4500): Promise<T | null> {
  const now = Date.now();
  const cached = memoryCache.get(pathWithQuery);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${FOTMOB_BASE}/${pathWithQuery}`, {
      headers: FOTMOB_HEADERS,
      signal: controller.signal,
      next: { revalidate: ttlSeconds },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;
    const data = (await res.json()) as T;
    memoryCache.set(pathWithQuery, { expiresAt: now + ttlSeconds * 1000, value: data });
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Normalisation souple des noms d'équipes entre ESPN et FotMob
const STOP_WORDS = new Set([
  'fc',
  'cf',
  'sc',
  'ac',
  'afc',
  'ssc',
  'ud',
  'cd',
  'rc',
  'rcd',
  'as',
  'us',
  'ss',
  'sv',
  'vfb',
  'vfl',
  'fsv',
  'tsg',
  'bsc',
  'fk',
  'sk',
  'bk',
  'kv',
  'krc',
  'rsc',
  'club',
  'deportivo',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'and',
  'et',
  'the',
  'calcio',
  'football',
  'soccer',
  'sporting',
]);

const ALIAS_TOKENS: Record<string, string> = {
  utd: 'united',
  man: 'manchester',
  st: 'saint',
  ste: 'sainte',
  psg: 'paris saint germain',
  om: 'marseille',
  ol: 'lyon',
  ath: 'athletic',
  atletico: 'atletico',
  inter: 'internazionale inter',
  ny: 'new york',
  la: 'los angeles',
  dc: 'dc',
  gladbach: 'monchengladbach',
  mgladbach: 'monchengladbach',
  wolves: 'wolverhampton',
  spurs: 'tottenham',
  forest: 'nottingham',
  brighton: 'brighton',
  bournemouth: 'bournemouth',
  alaves: 'alaves',
  betis: 'betis',
  celta: 'celta',
  sociedad: 'sociedad',
  bilbao: 'athletic',
  bayern: 'bayern munchen munich',
  munich: 'munchen',
  cologne: 'koln',
  mainz: 'mainz',
  psv: 'psv eindhoven',
  az: 'alkmaar',
  vitória: 'vitoria',
  sportingcp: 'sporting',
};

export function normalizeTeamName(raw?: string | null): string {
  if (!raw) return '';
  const ascii = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ascii;
}

function teamTokens(raw?: string | null): string[] {
  const norm = normalizeTeamName(raw);
  if (!norm) return [];
  const expanded: string[] = [];
  for (const part of norm.split(' ')) {
    if (!part) continue;
    if (ALIAS_TOKENS[part]) {
      for (const sub of ALIAS_TOKENS[part].split(' ')) {
        if (sub && !STOP_WORDS.has(sub)) expanded.push(sub);
      }
    } else if (!STOP_WORDS.has(part) && !/^\d+$/.test(part)) {
      expanded.push(part);
    }
  }
  return expanded.length ? expanded : norm.split(' ').filter(Boolean);
}

export function teamSimilarity(nameA?: string | null, nameB?: string | null): number {
  const normA = normalizeTeamName(nameA);
  const normB = normalizeTeamName(nameB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.92;

  const tokAList = Array.from(new Set(teamTokens(nameA)));
  const tokBList = Array.from(new Set(teamTokens(nameB)));
  const tokB = new Set(tokBList);
  if (!tokAList.length || !tokBList.length) return 0;

  let inter = 0;
  for (const t of tokAList) {
    if (tokB.has(t)) inter += 1;
    else {
      for (const b of tokBList) {
        if (t.length >= 4 && b.length >= 4 && (t.startsWith(b) || b.startsWith(t))) {
          inter += 0.8;
          break;
        }
      }
    }
  }
  const union = new Set(tokAList.concat(tokBList)).size;
  return (inter / Math.max(1, Math.min(tokAList.length, tokBList.length))) * 0.7 + (inter / Math.max(1, union)) * 0.3;
}

function shiftCompactDate(compactDate: string, deltaDays: number): string {
  if (!/^\d{8}$/.test(compactDate)) return compactDate;
  const y = Number(compactDate.slice(0, 4));
  const m = Number(compactDate.slice(4, 6));
  const d = Number(compactDate.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export type FotmobDayMatch = {
  id: number;
  leagueId: number;
  primaryLeagueId?: number;
  leagueName?: string;
  utcTime?: string;
  home: { id: number; name: string; shortName?: string; longName?: string; score?: number };
  away: { id: number; name: string; shortName?: string; longName?: string; score?: number };
  status?: { started?: boolean; finished?: boolean; cancelled?: boolean; utcTime?: string };
};

export async function getFotmobMatchesForDate(compactDate: string): Promise<FotmobDayMatch[]> {
  const data = await fetchFotmobJson<{ leagues?: any[] }>(`matches?date=${encodeURIComponent(compactDate)}`, 120);
  if (!data?.leagues || !Array.isArray(data.leagues)) return [];

  const out: FotmobDayMatch[] = [];
  for (const lg of data.leagues) {
    const primaryId = Number(lg.primaryId ?? lg.parentLeagueId ?? lg.id);
    const leagueId = Number(lg.id);
    const leagueName = lg.name;
    for (const m of lg.matches || []) {
      if (!m?.id || !m?.home || !m?.away) continue;
      out.push({
        id: Number(m.id),
        leagueId,
        primaryLeagueId: primaryId,
        leagueName,
        utcTime: m.status?.utcTime,
        home: m.home,
        away: m.away,
        status: m.status,
      });
    }
  }
  return out;
}

export async function findFotmobMatchForEspn(params: {
  leagueSlug: string;
  compactDate: string;
  homeName: string;
  awayName: string;
  kickoffIso?: string;
}): Promise<FotmobDayMatch | null> {
  const { leagueSlug, compactDate, homeName, awayName, kickoffIso } = params;
  const preferredLeagueIds = new Set(ESPN_TO_FOTMOB_LEAGUE[leagueSlug] || []);

  // Chercher d'abord à la date exacte, puis +-1 jour si décalage de fuseau horaire (ex: MLS / Liga MX / Argentine)
  const datesToTry = [compactDate];
  if (kickoffIso) {
    const kickUtcDay = kickoffIso.slice(0, 10).replaceAll('-', '');
    if (/^\d{8}$/.test(kickUtcDay) && !datesToTry.includes(kickUtcDay)) {
      datesToTry.unshift(kickUtcDay);
    }
  }

  const pickBest = (candidates: FotmobDayMatch[]): { match: FotmobDayMatch; score: number } | null => {
    let best: { match: FotmobDayMatch; score: number } | null = null;
    const kickMs = kickoffIso ? Date.parse(kickoffIso) : NaN;

    for (const cand of candidates) {
      const simHome = Math.max(
        teamSimilarity(homeName, cand.home.name),
        teamSimilarity(homeName, cand.home.longName),
        teamSimilarity(homeName, cand.home.shortName)
      );
      const simAway = Math.max(
        teamSimilarity(awayName, cand.away.name),
        teamSimilarity(awayName, cand.away.longName),
        teamSimilarity(awayName, cand.away.shortName)
      );

      if (simHome < 0.45 || simAway < 0.45) continue;

      let score = simHome * 0.45 + simAway * 0.45;
      if (
        preferredLeagueIds.size > 0 &&
        (preferredLeagueIds.has(cand.leagueId) || (cand.primaryLeagueId && preferredLeagueIds.has(cand.primaryLeagueId)))
      ) {
        score += 0.1;
      }

      if (Number.isFinite(kickMs) && cand.utcTime) {
        const diffHours = Math.abs(kickMs - Date.parse(cand.utcTime)) / 3_600_000;
        if (diffHours <= 2) score += 0.04;
        else if (diffHours > 36) score -= 0.15;
      }

      if (!best || score > best.score) {
        best = { match: cand, score };
      }
    }
    return best;
  };

  for (const dt of datesToTry) {
    const list = await getFotmobMatchesForDate(dt);
    const found = pickBest(list);
    if (found && found.score >= 0.65) return found.match;
  }

  // Fallback +- 1 jour
  const neighbors = await Promise.all([
    getFotmobMatchesForDate(shiftCompactDate(compactDate, -1)),
    getFotmobMatchesForDate(shiftCompactDate(compactDate, 1)),
  ]);
  const foundNeighbor = pickBest([...neighbors[0], ...neighbors[1]]);
  if (foundNeighbor && foundNeighbor.score >= 0.68) return foundNeighbor.match;

  return null;
}

export type UnavailablePlayerInfo = {
  id: number;
  name: string;
  type: 'injury' | 'suspension' | 'doubtful' | 'other';
  labelFr: string;
  expectedReturn?: string;
  marketValue?: number;
  rating?: number | null;
  goals?: number;
  assists?: number;
  position?: string;
  isKeyPlayer?: boolean;
};

export type TeamXgSeasonStats = {
  teamId: number;
  played: number;
  xg: number;
  xgConceded: number;
  xgPerMatch: number;
  xgaPerMatch: number;
  xPoints: number;
  xgDiff: number;
};

export type RefereeInfo = {
  name: string;
  country?: string;
  matches?: number;
  yellowPerMatch?: number;
  redCardsTotal?: number;
  penaltiesTotal?: number;
  penaltiesPerMatch?: number;
  foulsPerMatch?: number;
};

export type H2HItem = {
  date: string;
  competition?: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
};

// Modèle mathématique Poisson identique au backend mais enrichi
function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

export function computeProbabilitiesFromLambdas(lambdaHome: number, lambdaAway: number) {
  const lh = Math.max(0.18, Math.min(4.8, lambdaHome));
  const la = Math.max(0.18, Math.min(4.8, lambdaAway));
  const maxGoals = 10;

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let bttsYes = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  const scores: { h: number; a: number; p: number }[] = [];

  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lh);
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph * poissonPmf(a, la);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      if (h >= 1 && a >= 1) bttsYes += p;
      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;

      if (h <= 6 && a <= 6) {
        scores.push({ h, a, p: Number(p.toFixed(4)) });
      }
    }
  }

  // Normalisation légère de la troncature à maxGoals
  const sum = pHome + pDraw + pAway || 1;
  pHome /= sum;
  pDraw /= sum;
  pAway /= sum;

  scores.sort((x, y) => y.p - x.p);

  const totalLambda = lh + la;
  const noGoal = Math.exp(-totalLambda);
  const firstHome = totalLambda > 0 ? (1 - noGoal) * (lh / totalLambda) : 0;
  const firstAway = totalLambda > 0 ? (1 - noGoal) * (la / totalLambda) : 0;

  // Répartition empirique football : ~44% des buts en 1re période, ~56% en 2e période
  const lH1 = totalLambda * 0.44;
  const lH2 = totalLambda * 0.56;
  const lhH1 = lh * 0.44;
  const laH1 = la * 0.44;

  const overK = (lam: number, threshold: number) => {
    let cdf = 0;
    for (let k = 0; k <= threshold; k++) cdf += poissonPmf(k, lam);
    return Math.max(0, Math.min(1, 1 - cdf));
  };

  const noGoalH1 = Math.exp(-lH1);
  const round4 = (v: number) => Number(Math.max(0, Math.min(1, v)).toFixed(4));

  return {
    expectedGoals: {
      home: Number(lh.toFixed(2)),
      away: Number(la.toFixed(2)),
    },
    probabilities: {
      home: round4(pHome),
      draw: round4(pDraw),
      away: round4(pAway),
      bttsYes: round4(bttsYes),
      bttsNo: round4(1 - bttsYes),
      over15: round4(over15),
      under15: round4(1 - over15),
      over25: round4(over25),
      under25: round4(1 - over25),
      over35: round4(over35),
      under35: round4(1 - over35),
      firstHome: round4(firstHome),
      firstAway: round4(firstAway),
      noGoal: round4(noGoal),
      firstHalf: {
        over05: round4(overK(lH1, 0)),
        over15: round4(overK(lH1, 1)),
        over25: round4(overK(lH1, 2)),
      },
      secondHalf: {
        over05: round4(overK(lH2, 0)),
        over15: round4(overK(lH2, 1)),
        over25: round4(overK(lH2, 2)),
      },
      firstHomeH1: round4(lH1 > 0 ? (1 - noGoalH1) * (lhH1 / lH1) : 0),
      firstAwayH1: round4(lH1 > 0 ? (1 - noGoalH1) * (laH1 / lH1) : 0),
    },
    topScores: scores.slice(0, 5),
  };
}

function parseUnavailableList(rawUnavailable: any[], squadMembersById: Map<number, any>, totalSquadValue: number): UnavailablePlayerInfo[] {
  if (!Array.isArray(rawUnavailable)) return [];
  const items: UnavailablePlayerInfo[] = [];

  for (const p of rawUnavailable) {
    if (!p?.name) continue;
    const pid = Number(p.id);
    const squadInfo = squadMembersById.get(pid);
    const unav = p.unavailability || {};
    const expectedReturn: string | undefined = unav.expectedReturn || squadInfo?.injury?.expectedReturn || undefined;
    const rawType = String(unav.type || '').toLowerCase();
    const isDoubtful = Boolean(expectedReturn && /doubtful|incertain|questionable/i.test(expectedReturn));

    let type: UnavailablePlayerInfo['type'] = 'other';
    let labelFr = 'Absent';
    if (rawType === 'suspension' || /red card|yellow|suspend/i.test(rawType)) {
      type = 'suspension';
      labelFr = 'Suspendu';
    } else if (isDoubtful) {
      type = 'doubtful';
      labelFr = 'Incertain';
    } else if (rawType === 'injury' || unav.injuryId) {
      type = 'injury';
      labelFr = 'Blessé';
    } else if (/international|national/i.test(rawType)) {
      type = 'other';
      labelFr = 'Sélection';
    }

    const marketValue = Number(p.marketValue || squadInfo?.transferValue || 0) || undefined;
    const rating = typeof squadInfo?.rating === 'number' ? Number(squadInfo.rating.toFixed(2)) : null;
    const goals = typeof squadInfo?.goals === 'number' ? squadInfo.goals : undefined;
    const assists = typeof squadInfo?.assists === 'number' ? squadInfo.assists : undefined;
    const position = squadInfo?.positionIdsDesc ? String(squadInfo.positionIdsDesc).split(',')[0] : undefined;

    const valueShare = totalSquadValue > 0 && marketValue ? marketValue / totalSquadValue : 0;
    const isKeyPlayer =
      valueShare >= 0.065 ||
      (rating !== null && rating >= 7.15) ||
      (typeof goals === 'number' && goals >= 3) ||
      (typeof assists === 'number' && assists >= 3);

    items.push({
      id: pid,
      name: p.name,
      type,
      labelFr,
      expectedReturn: expectedReturn && !/doubtful/i.test(expectedReturn) ? expectedReturn : undefined,
      marketValue,
      rating,
      goals,
      assists,
      position,
      isKeyPlayer,
    });
  }

  // Trier par importance (titulaires/joueurs clés puis valeur marchande décroissante)
  items.sort((a, b) => {
    if (Boolean(a.isKeyPlayer) !== Boolean(b.isKeyPlayer)) return a.isKeyPlayer ? -1 : 1;
    if ((a.type === 'doubtful') !== (b.type === 'doubtful')) return a.type === 'doubtful' ? 1 : -1;
    return (b.marketValue || 0) - (a.marketValue || 0);
  });

  return items;
}

function computeAbsencePenalty(players: UnavailablePlayerInfo[], totalSquadValue: number): {
  attackMultiplier: number;
  defenseConcedeMultiplier: number;
  severityScore: number;
} {
  if (!players.length) {
    return { attackMultiplier: 1, defenseConcedeMultiplier: 1, severityScore: 0 };
  }

  let attDrop = 0;
  let defVuln = 0;
  const refSquadVal = totalSquadValue > 0 ? totalSquadValue : 250_000_000;

  for (const p of players) {
    const certainty = p.type === 'doubtful' ? 0.4 : 1.0;
    const valShare = p.marketValue ? Math.min(0.16, p.marketValue / refSquadVal) : p.isKeyPlayer ? 0.07 : 0.025;
    const ratingBoost = p.rating && p.rating >= 7.1 ? 1.25 : 1.0;
    const impact = certainty * valShare * ratingBoost;

    const pos = (p.position || '').toUpperCase();
    if (/ST|CF|LW|RW|CAM|AM|FW/.test(pos) || (p.goals && p.goals >= 2)) {
      attDrop += impact * 1.15;
      defVuln += impact * 0.2;
    } else if (/GK|CB|LB|RB|LWB|RWB/.test(pos)) {
      attDrop += impact * 0.25;
      defVuln += impact * 1.15;
    } else {
      // Milieu ou poste inconnu : impact mixte attaque/défense
      attDrop += impact * 0.7;
      defVuln += impact * 0.7;
    }
  }

  // Plafonner l'impact pour éviter de déformer excessivement le modèle (max -22% en attaque, +18% buts encaissés)
  const clampedAttDrop = Math.min(0.22, attDrop);
  const clampedDefVuln = Math.min(0.18, defVuln);
  const severityScore = Math.round((clampedAttDrop + clampedDefVuln) * 100);

  return {
    attackMultiplier: 1 - clampedAttDrop,
    defenseConcedeMultiplier: 1 + clampedDefVuln,
    severityScore,
  };
}

function formatAbsenceSummaryFr(players: UnavailablePlayerInfo[]): string {
  if (!players.length) {
    return 'Aucun blessé ni suspendu signalé (FotMob)';
  }
  const confirmed = players.filter(p => p.type !== 'doubtful');
  const doubtful = players.filter(p => p.type === 'doubtful');
  const suspensions = players.filter(p => p.type === 'suspension');

  const countParts: string[] = [];
  const injuredCount = confirmed.filter(p => p.type !== 'suspension').length;
  if (injuredCount > 0) countParts.push(`${injuredCount} blessé${injuredCount > 1 ? 's' : ''}`);
  if (suspensions.length > 0) countParts.push(`${suspensions.length} suspendu${suspensions.length > 1 ? 's' : ''}`);
  if (doubtful.length > 0) countParts.push(`${doubtful.length} incertain${doubtful.length > 1 ? 's' : ''}`);

  const previewNames = players.slice(0, 5).map(p => {
    const tags: string[] = [];
    if (p.position) tags.push(p.position);
    if (p.type === 'suspension') tags.push('susp.');
    else if (p.type === 'doubtful') tags.push('incert.');
    if (typeof p.goals === 'number' && p.goals >= 2) tags.push(`${p.goals} b.`);
    return `${p.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  });

  const more = players.length > 5 ? ` +${players.length - 5}` : '';
  return `${countParts.join(', ')} : ${previewNames.join(' · ')}${more}`;
}

function extractMatchStatsXg(statsRoot: any): {
  homeXg?: number;
  awayXg?: number;
  homeXgot?: number;
  awayXgot?: number;
  homeBigChances?: number;
  awayBigChances?: number;
} | null {
  const groups = statsRoot?.Periods?.All?.stats;
  if (!Array.isArray(groups)) return null;

  const result: {
    homeXg?: number;
    awayXg?: number;
    homeXgot?: number;
    awayXgot?: number;
    homeBigChances?: number;
    awayBigChances?: number;
  } = {};

  for (const grp of groups) {
    for (const row of grp?.stats || []) {
      if (!row?.key || !Array.isArray(row.stats) || row.stats.length < 2) continue;
      const hVal = Number(row.rawStats?.[0]?.value ?? row.stats[0]);
      const aVal = Number(row.rawStats?.[1]?.value ?? row.stats[1]);
      if (!Number.isFinite(hVal) || !Number.isFinite(aVal)) continue;

      if (row.key === 'expected_goals' && result.homeXg === undefined) {
        result.homeXg = Number(hVal.toFixed(2));
        result.awayXg = Number(aVal.toFixed(2));
      } else if (row.key === 'expected_goals_on_target') {
        result.homeXgot = Number(hVal.toFixed(2));
        result.awayXgot = Number(aVal.toFixed(2));
      } else if (row.key === 'big_chance') {
        result.homeBigChances = hVal;
        result.awayBigChances = aVal;
      }
    }
  }

  return result.homeXg !== undefined ? result : null;
}

function extractXgTableMap(tablePayload: any): Map<number, TeamXgSeasonStats> {
  const map = new Map<number, TeamXgSeasonStats>();
  if (!Array.isArray(tablePayload)) return map;

  const scanXgRows = (xgRows: any[]) => {
    if (!Array.isArray(xgRows)) return;
    for (const row of xgRows) {
      const tid = Number(row.id ?? row.teamId);
      const played = Number(row.played || 0);
      const xg = Number(row.xg);
      const xgConceded = Number(row.xgConceded);
      if (!tid || played <= 0 || !Number.isFinite(xg) || !Number.isFinite(xgConceded)) continue;
      map.set(tid, {
        teamId: tid,
        played,
        xg: Number(xg.toFixed(2)),
        xgConceded: Number(xgConceded.toFixed(2)),
        xgPerMatch: Number((xg / played).toFixed(2)),
        xgaPerMatch: Number((xgConceded / played).toFixed(2)),
        xPoints: Number(Number(row.xPoints || 0).toFixed(1)),
        xgDiff: Number(Number(row.xgDiff || 0).toFixed(2)),
      });
    }
  };

  for (const entry of tablePayload) {
    const data = entry?.data || entry;
    if (data?.table?.xg) scanXgRows(data.table.xg);
    if (Array.isArray(data?.tables)) {
      for (const sub of data.tables) {
        if (sub?.table?.xg) scanXgRows(sub.table.xg);
      }
    }
  }
  return map;
}

function extractSquadInfo(teamPayload: any): {
  coachName: string | null;
  membersById: Map<number, any>;
  totalSquadValue: number;
  xgMapFromTeamTable: Map<number, TeamXgSeasonStats>;
} {
  const membersById = new Map<number, any>();
  let coachName: string | null = null;
  let totalSquadValue = 0;

  const squadGroups = teamPayload?.squad?.squad;
  if (Array.isArray(squadGroups)) {
    for (const grp of squadGroups) {
      const title = String(grp?.title || '').toLowerCase();
      const members = Array.isArray(grp?.members) ? grp.members : [];
      if (title === 'coach' || title === 'coaches') {
        if (members[0]?.name) coachName = String(members[0].name);
        continue;
      }
      for (const m of members) {
        if (!m?.id) continue;
        membersById.set(Number(m.id), m);
        if (typeof m.transferValue === 'number' && m.transferValue > 0) {
          totalSquadValue += m.transferValue;
        }
      }
    }
  }

  const xgMapFromTeamTable = extractXgTableMap(teamPayload?.table);
  return { coachName, membersById, totalSquadValue, xgMapFromTeamTable };
}

function extractReferee(infoBox: any): RefereeInfo | null {
  const ref = infoBox?.Referee;
  if (!ref || !ref.text || !String(ref.text).trim()) return null;

  const info: RefereeInfo = {
    name: String(ref.text).trim(),
    country: ref.country || undefined,
  };

  if (Array.isArray(ref.stats)) {
    for (const st of ref.stats) {
      if (st?.type === 'matches' && typeof st.value === 'number') info.matches = st.value;
      else if (st?.type === 'yellowCards' && typeof st.value === 'number') info.yellowPerMatch = Number(st.value.toFixed(2));
      else if (st?.type === 'redCards' && typeof st.value === 'number') info.redCardsTotal = st.value;
      else if (st?.type === 'penalties' && typeof st.value === 'number') info.penaltiesTotal = st.value;
      else if (st?.type === 'fouls' && typeof st.value === 'number') info.foulsPerMatch = Number(st.value.toFixed(1));
    }
    if (info.matches && info.matches > 0 && typeof info.penaltiesTotal === 'number') {
      info.penaltiesPerMatch = Number((info.penaltiesTotal / info.matches).toFixed(2));
    }
  }
  return info;
}

function extractH2H(h2hRoot: any, homeTeamId: number, awayTeamId: number, homeTeamName: string, awayTeamName: string) {
  if (!h2hRoot || !Array.isArray(h2hRoot.matches)) return null;

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let totalGoalsHome = 0;
  let totalGoalsAway = 0;
  const completed: H2HItem[] = [];

  for (const m of h2hRoot.matches) {
    const scoreStr: string | undefined = m?.status?.scoreStr;
    const isFinished = Boolean(m?.status?.finished) && Boolean(scoreStr && scoreStr.includes('-'));
    if (!isFinished || !scoreStr) continue;

    const parts = scoreStr.split('-').map(s => Number(s.trim()));
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;

    const [sH, sA] = parts;
    const mHomeId = Number(m?.home?.id);
    const mHomeName = String(m?.home?.name || '');
    const mAwayName = String(m?.away?.name || '');

    const sameOrientation =
      mHomeId === homeTeamId ||
      (mHomeId !== awayTeamId && teamSimilarity(mHomeName, homeTeamName) >= teamSimilarity(mHomeName, awayTeamName));

    const gfHome = sameOrientation ? sH : sA;
    const gfAway = sameOrientation ? sA : sH;

    totalGoalsHome += gfHome;
    totalGoalsAway += gfAway;
    if (gfHome > gfAway) homeWins += 1;
    else if (gfHome === gfAway) draws += 1;
    else awayWins += 1;

    completed.push({
      date: String(m?.time?.utcTime || m?.status?.utcTime || '').slice(0, 10),
      competition: m?.league?.name || undefined,
      homeName: mHomeName,
      awayName: mAwayName,
      homeScore: sH,
      awayScore: sA,
    });
  }

  if (!completed.length) return null;

  const n = completed.length;
  const avgGoals = ((totalGoalsHome + totalGoalsAway) / n).toFixed(2);
  const last3 = completed
    .slice(0, 3)
    .map(item => `${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}${item.date ? ` (${item.date.slice(0, 4)})` : ''}`)
    .join(' · ');

  return {
    count: n,
    homeWins,
    draws,
    awayWins,
    avgGoalsPerMatch: Number(avgGoals),
    homeGoalsAvg: Number((totalGoalsHome / n).toFixed(2)),
    awayGoalsAvg: Number((totalGoalsAway / n).toFixed(2)),
    resume: `${n} confrontations : ${homeWins}V ${homeTeamName} · ${draws}N · ${awayWins}V ${awayTeamName} (${avgGoals} buts/m)`,
    note: `Derniers duels (FotMob multi-saisons) : ${last3}.`,
    detail: completed.slice(0, 8),
  };
}

export async function enrichEspnMatchWithFotmob(params: {
  espnMatch: any;
  leagueSlug: string;
  compactDate: string;
  deepTeamFetch?: boolean;
}): Promise<any> {
  const { espnMatch, leagueSlug, compactDate, deepTeamFetch = true } = params;
  if (!espnMatch || espnMatch.error || !espnMatch.home?.name || !espnMatch.away?.name) {
    return espnMatch;
  }

  const matchedDayItem = await findFotmobMatchForEspn({
    leagueSlug,
    compactDate,
    homeName: espnMatch.home.name,
    awayName: espnMatch.away.name,
    kickoffIso: espnMatch.date,
  });

  if (!matchedDayItem) {
    return espnMatch;
  }

  const isFinished = Boolean(matchedDayItem.status?.finished);
  const detailsTtl = isFinished ? 1800 : 300;
  const details = await fetchFotmobJson<any>(`matchDetails?matchId=${matchedDayItem.id}`, detailsTtl);
  if (!details?.content) {
    return espnMatch;
  }

  const homeTeamId = Number(details.general?.homeTeam?.id ?? matchedDayItem.home.id);
  const awayTeamId = Number(details.general?.awayTeam?.id ?? matchedDayItem.away.id);
  const parentLeagueId = Number(details.general?.parentLeagueId ?? details.general?.leagueId ?? matchedDayItem.primaryLeagueId ?? matchedDayItem.leagueId);

  // Récupération parallèle des fiches équipes (entraîneurs, notes/valeurs joueurs, table xG) + table ligue si nécessaire
  let homeTeamPayload: any = null;
  let awayTeamPayload: any = null;
  let leagueTablePayload: any = null;

  if (deepTeamFetch) {
    [homeTeamPayload, awayTeamPayload, leagueTablePayload] = await Promise.all([
      homeTeamId ? fetchFotmobJson<any>(`teams?id=${homeTeamId}`, 600) : Promise.resolve(null),
      awayTeamId ? fetchFotmobJson<any>(`teams?id=${awayTeamId}`, 600) : Promise.resolve(null),
      parentLeagueId ? fetchFotmobJson<any>(`tltable?leagueId=${parentLeagueId}`, 600) : Promise.resolve(null),
    ]);
  } else if (parentLeagueId) {
    leagueTablePayload = await fetchFotmobJson<any>(`tltable?leagueId=${parentLeagueId}`, 600);
  }

  const homeSquad = extractSquadInfo(homeTeamPayload);
  const awaySquad = extractSquadInfo(awayTeamPayload);

  // Table xG consolidée (ligue ou fiche équipe)
  const xgMap = extractXgTableMap(leagueTablePayload);
  homeSquad.xgMapFromTeamTable.forEach((v, k) => {
    if (!xgMap.has(k)) xgMap.set(k, v);
  });
  awaySquad.xgMapFromTeamTable.forEach((v, k) => {
    if (!xgMap.has(k)) xgMap.set(k, v);
  });

  const homeXgSeason = xgMap.get(homeTeamId) || null;
  const awayXgSeason = xgMap.get(awayTeamId) || null;

  // 1. Blessés / suspendus / incertains
  const lineup = details.content?.lineup;
  const rawHomeUnav = lineup?.homeTeam?.unavailable || [];
  const rawAwayUnav = lineup?.awayTeam?.unavailable || [];

  const homeAbsences = parseUnavailableList(rawHomeUnav, homeSquad.membersById, homeSquad.totalSquadValue);
  const awayAbsences = parseUnavailableList(rawAwayUnav, awaySquad.membersById, awaySquad.totalSquadValue);

  const homePenalty = computeAbsencePenalty(homeAbsences, homeSquad.totalSquadValue);
  const awayPenalty = computeAbsencePenalty(awayAbsences, awaySquad.totalSquadValue);

  // Entraîneurs & formations (depuis lineup si match joué/compos publiées, sinon depuis squad)
  const homeCoach = lineup?.homeTeam?.coach?.name || homeSquad.coachName || null;
  const awayCoach = lineup?.awayTeam?.coach?.name || awaySquad.coachName || null;
  const homeFormation = lineup?.homeTeam?.formation || null;
  const awayFormation = lineup?.awayTeam?.formation || null;

  // 2. Arbitre & Stade & Météo FotMob
  const infoBox = details.content?.matchFacts?.infoBox;
  const referee = extractReferee(infoBox);
  const fotmobWeather = details.content?.weather || null;

  // 3. Confrontations directes multi-saisons (H2H)
  const h2hEnriched = extractH2H(
    details.content?.h2h,
    homeTeamId,
    awayTeamId,
    espnMatch.home.name,
    espnMatch.away.name
  );

  // 4. xG réel du match (si match en cours / terminé avec couverture xG)
  const liveOrFinalMatchXg = extractMatchStatsXg(details.content?.stats);

  // 5. Insights FotMob / Opta
  const rawInsights: any[] = Array.isArray(details.content?.matchFacts?.insights)
    ? details.content.matchFacts.insights
    : [];
  const insights = rawInsights
    .map(ins => (typeof ins?.text === 'string' ? ins.text.trim() : ''))
    .filter(Boolean)
    .slice(0, 6);

  // 6. Recalibrage intelligent du modèle Poisson (λ_dom, λ_ext) avec xG FotMob + absences + H2H
  const baseLambdaHome = Number(espnMatch.expectedGoals?.home || 1.35);
  const baseLambdaAway = Number(espnMatch.expectedGoals?.away || 1.15);

  let adjLambdaHome = baseLambdaHome;
  let adjLambdaAway = baseLambdaAway;

  // Intégration des vrais xG/match et xGA/match de la saison (poids 35% si au moins 3 matchs joués)
  if (homeXgSeason && awayXgSeason && homeXgSeason.played >= 3 && awayXgSeason.played >= 3) {
    // Attendu offensif croisé : moyenne géométrique/arithmétique entre xG produit et xGA concédé par l'adversaire (+ léger bonus domicile ~6%)
    const xgBasedHome = ((homeXgSeason.xgPerMatch + awayXgSeason.xgaPerMatch) / 2) * 1.06;
    const xgBasedAway = ((awayXgSeason.xgPerMatch + homeXgSeason.xgaPerMatch) / 2) * 0.94;
    adjLambdaHome = adjLambdaHome * 0.62 + xgBasedHome * 0.38;
    adjLambdaAway = adjLambdaAway * 0.62 + xgBasedAway * 0.38;
  }

  // Léger ajustement H2H si échantillon >= 4 confrontations récentes (poids prudent de 8%)
  if (h2hEnriched && h2hEnriched.count >= 4) {
    adjLambdaHome = adjLambdaHome * 0.92 + h2hEnriched.homeGoalsAvg * 0.08;
    adjLambdaAway = adjLambdaAway * 0.92 + h2hEnriched.awayGoalsAvg * 0.08;
  }

  // Pondération des blessés & suspendus (baisse de l'attaque propre + hausse des buts concédés si défense décimée)
  adjLambdaHome = adjLambdaHome * homePenalty.attackMultiplier * awayPenalty.defenseConcedeMultiplier;
  adjLambdaAway = adjLambdaAway * awayPenalty.attackMultiplier * homePenalty.defenseConcedeMultiplier;

  const recomputed = computeProbabilitiesFromLambdas(adjLambdaHome, adjLambdaAway);

  // 7. Mise à jour du score de vigilance avec les signaux d'effectif et d'écart marché/modèle
  const market = espnMatch.market;
  const reasons: string[] = [];
  let vigilanceScore = 0;

  if (!market) {
    vigilanceScore += 10;
    reasons.push('Cotes indisponibles ou suspendues : impossible de comparer au marché.');
  } else {
    const diff1x2 = Math.max(
      Math.abs((recomputed.probabilities.home || 0) - (market.home || 0)),
      Math.abs((recomputed.probabilities.draw || 0) - (market.draw || 0)),
      Math.abs((recomputed.probabilities.away || 0) - (market.away || 0))
    );
    if (diff1x2 >= 0.14) {
      vigilanceScore += 25;
      reasons.push(
        `Divergence modèle/marché (${Math.round(diff1x2 * 100)}%) après prise en compte des xG et absences FotMob.`
      );
    }
    if (typeof market.over25 === 'number') {
      const diffOver = Math.abs((recomputed.probabilities.over25 || 0) - market.over25);
      if (diffOver >= 0.18) {
        vigilanceScore += 10;
        reasons.push(
          `Écart sur le total de buts (+2,5 : modèle ${Math.round(recomputed.probabilities.over25 * 100)}% vs marché ${Math.round(
            market.over25 * 100
          )}%).`
        );
      }
    }
  }

  if (homePenalty.severityScore >= 12 || awayPenalty.severityScore >= 12) {
    vigilanceScore += 12;
    const impacted =
      homePenalty.severityScore >= 12 && awayPenalty.severityScore >= 12
        ? `${espnMatch.home.short || espnMatch.home.name} & ${espnMatch.away.short || espnMatch.away.name}`
        : homePenalty.severityScore >= 12
        ? espnMatch.home.name
        : espnMatch.away.name;
    reasons.push(
      `Absences notables détectées sur FotMob (${impacted}) : impact significatif sur les onze probables.`
    );
  }

  const freshCountH = espnMatch.factors?.forme?.fraicheurHome?.count ?? 5;
  const freshCountA = espnMatch.factors?.forme?.fraicheurAway?.count ?? 5;
  if (freshCountH < 3 || freshCountA < 3) {
    vigilanceScore += 15;
    reasons.push('Échantillon récent réduit (< 3 matchs sur 60 jours) : incertitude statistique accrue.');
  }

  if (referee && typeof referee.yellowPerMatch === 'number' && referee.yellowPerMatch >= 4.6) {
    vigilanceScore += 5;
    reasons.push(
      `Arbitre sévère désigné (${referee.name} : ${referee.yellowPerMatch} cartons jaunes/match) — volatilité disciplinaire.`
    );
  }

  vigilanceScore = Math.min(100, vigilanceScore);
  const vigilanceLevel = vigilanceScore >= 55 ? 'Élevé' : vigilanceScore >= 30 ? 'Modéré' : 'Faible';

  // 8. Enrichissement structuré des 8 facteurs tout en préservant 100% de la compatibilité existante
  const nextFactors = { ...(espnMatch.factors || {}) };

  // Facteur 03 : Confrontations directes (H2H)
  if (h2hEnriched) {
    nextFactors.h2h = {
      ...(nextFactors.h2h || {}),
      resume: h2hEnriched.resume,
      note: h2hEnriched.note,
      detail: h2hEnriched.detail,
      source: 'FotMob',
    };
  }

  // Facteur 04 : Blessés / suspendus
  const hasLineupOrUnav = Boolean(lineup);
  if (hasLineupOrUnav) {
    const impactParts: string[] = [];
    if (homePenalty.attackMultiplier < 0.99 || homePenalty.defenseConcedeMultiplier > 1.01) {
      impactParts.push(
        `${espnMatch.home.short || espnMatch.home.name} (att. ${Math.round((homePenalty.attackMultiplier - 1) * 100)}%, déf. +${Math.round(
          (homePenalty.defenseConcedeMultiplier - 1) * 100
        )}% bc)`
      );
    }
    if (awayPenalty.attackMultiplier < 0.99 || awayPenalty.defenseConcedeMultiplier > 1.01) {
      impactParts.push(
        `${espnMatch.away.short || espnMatch.away.name} (att. ${Math.round((awayPenalty.attackMultiplier - 1) * 100)}%, déf. +${Math.round(
          (awayPenalty.defenseConcedeMultiplier - 1) * 100
        )}% bc)`
      );
    }

    nextFactors.blessures = {
      home: formatAbsenceSummaryFr(homeAbsences),
      away: formatAbsenceSummaryFr(awayAbsences),
      homePlayers: homeAbsences,
      awayPlayers: awayAbsences,
      impact: {
        home: homePenalty,
        away: awayPenalty,
      },
      note: impactParts.length
        ? `Source FotMob · Pondération xG appliquée : ${impactParts.join(' · ')}.`
        : 'Source FotMob · Effectifs quasi complets, aucun malus majeur appliqué au modèle.',
    };
  }

  // Facteur 07 : Statistiques attaque / défense + vrais xG
  if (homeXgSeason || awayXgSeason || liveOrFinalMatchXg) {
    const prevStats = nextFactors.stats || {};
    nextFactors.stats = {
      ...prevStats,
      xgSaison: {
        home: homeXgSeason,
        away: awayXgSeason,
      },
      xgMatchReel: liveOrFinalMatchXg,
      note:
        homeXgSeason && awayXgSeason
          ? `Modèle calibré avec les vrais xG/xGA FotMob (${espnMatch.home.short || 'Dom.'} : ${homeXgSeason.xgPerMatch} xG/m, ${homeXgSeason.xgaPerMatch} xGA/m · ${espnMatch.away.short || 'Ext.'} : ${awayXgSeason.xgPerMatch} xG/m, ${awayXgSeason.xgaPerMatch} xGA/m) combinés à la forme récente ESPN.`
          : liveOrFinalMatchXg
          ? `xG réels du match mesurés par FotMob : ${liveOrFinalMatchXg.homeXg} – ${liveOrFinalMatchXg.awayXg}.`
          : prevStats.note,
    };
  }

  // Facteur 08 : Météo, repos, arbitre & entraîneurs
  const prevAutres = nextFactors.autres || {};
  const extraNotes: string[] = [];
  if (referee) {
    const refStatsParts: string[] = [];
    if (typeof referee.yellowPerMatch === 'number') refStatsParts.push(`${referee.yellowPerMatch} j./m`);
    if (typeof referee.foulsPerMatch === 'number') refStatsParts.push(`${referee.foulsPerMatch} fautes/m`);
    if (typeof referee.penaltiesTotal === 'number' && referee.matches) {
      refStatsParts.push(`${referee.penaltiesTotal} pen. en ${referee.matches} m.`);
    }
    extraNotes.push(`Arbitre : ${referee.name}${refStatsParts.length ? ` (${refStatsParts.join(', ')})` : ''}.`);
  } else {
    extraNotes.push('Arbitre : non encore désigné sur FotMob.');
  }

  if (homeCoach || awayCoach) {
    extraNotes.push(
      `Bancs : ${homeCoach || 'n.c.'}${homeFormation ? ` (${homeFormation})` : ''} vs ${awayCoach || 'n.c.'}${
        awayFormation ? ` (${awayFormation})` : ''
      }.`
    );
  }

  const mergedMeteo = prevAutres.meteo
    ? {
        ...prevAutres.meteo,
        description:
          prevAutres.meteo.description ||
          fotmobWeather?.defaultTitle ||
          (typeof prevAutres.meteo.temp === 'number'
            ? `${prevAutres.meteo.temp}°C${
                typeof prevAutres.meteo.precipProb === 'number' ? `, pluie ${prevAutres.meteo.precipProb}%` : ''
              }`
            : undefined),
      }
    : fotmobWeather && typeof fotmobWeather.temperature === 'number'
    ? {
        temp: fotmobWeather.temperature,
        precipProb: fotmobWeather.precipChance,
        description: `${fotmobWeather.temperature}°C · ${fotmobWeather.defaultTitle || fotmobWeather.description || ''}`.trim(),
      }
    : null;

  nextFactors.autres = {
    ...prevAutres,
    meteo: mergedMeteo,
    arbitre: referee,
    entraineurs: {
      home: homeCoach,
      away: awayCoach,
      formationHome: homeFormation,
      formationAway: awayFormation,
    },
    note: extraNotes.join(' '),
  };

  // Limitations mises à jour honnêtement
  const updatedLimitations = [
    'Probabilités estimées par un modèle statistique hybride (Poisson + xG/absences FotMob + forme ESPN) : jamais garanties.',
    'Le score de vigilance signale une divergence ou un aléa d’effectif, jamais une preuve de manipulation.',
    homeXgSeason && awayXgSeason
      ? 'xG/xGA de saison, blessés/suspendus, H2H multi-saisons et arbitre enrichis via le flux JSON public non-officiel FotMob.'
      : 'Blessés/suspendus, H2H multi-saisons et arbitre enrichis via le flux public FotMob (couverture xG selon compétition).',
  ];

  return {
    ...espnMatch,
    expectedGoals: recomputed.expectedGoals,
    baseExpectedGoalsEspn: espnMatch.expectedGoals,
    realMatchXg: liveOrFinalMatchXg,
    probabilities: recomputed.probabilities,
    topScores: recomputed.topScores,
    vigilance: {
      score: vigilanceScore,
      level: vigilanceLevel,
      reasons: reasons.length ? reasons : espnMatch.vigilance?.reasons || [],
    },
    factors: nextFactors,
    limitations: updatedLimitations,
    fotmob: {
      matchId: matchedDayItem.id,
      coverageLevel: details.general?.coverageLevel || null,
      homeTeamId,
      awayTeamId,
      coaches: { home: homeCoach, away: awayCoach },
      formations: { home: homeFormation, away: awayFormation },
      referee,
      insights,
    },
  };
}

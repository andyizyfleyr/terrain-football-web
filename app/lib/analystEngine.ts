/**
 * MOTEUR D'ANALYSE QUANTITATIVE v2 — 8 modules
 * ---------------------------------------------------------------------------
 * 01. Modèle bivarié de Dixon-Coles (ρ) + décroissance exponentielle de la forme
 * 02. Force du calendrier (xG ajusté adversaires) + splits domicile/extérieur
 * 03. xG hors penalties, coups de pied arrêtés, finition & gardiens (Goals Prevented)
 * 04. Absences intelligentes (titulaires vs longue absence) + onze officiel H-1
 * 05. Confrontation tactique (pressing, bloc bas, transitions, jeu direct)
 * 06. Calibrage bayésien avec le marché (retrait de marge / devigging + edge)
 * 07. Congestion 14 jours, calendrier européen, enjeux, arbitre & météo
 * 08. Simulation Monte-Carlo minute par minute (10 000 itérations)
 *
 * Module pur, sans dépendance externe : toutes les statistiques sont dérivées
 * des données publiques et restent des estimations (jamais des certitudes).
 */

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function round(v: number, digits = 2): number {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += Number.isFinite(v) ? v : 0;
  return s / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : simulations reproductibles */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseScoresString(scoresStr?: string): { for: number; against: number } {
  if (!scoresStr || typeof scoresStr !== 'string') return { for: 0, against: 0 };
  const parts = scoresStr.split('-');
  if (parts.length < 2) return { for: 0, against: 0 };
  const f = Number(parts[0]);
  const a = Number(parts[1]);
  return { for: Number.isFinite(f) ? f : 0, against: Number.isFinite(a) ? a : 0 };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / 86_400_000;
}

const EUROPEAN_COMPETITIONS = /champions|europa|conference|uefa/i;

/* ------------------------------------------------------------------ */
/* Types d'entrée                                                      */
/* ------------------------------------------------------------------ */

export type AnalystTableRow = {
  id: number;
  name: string;
  played: number;
  pts?: number;
  idx?: number;
  goalsScored?: number;
  goalsConceded?: number;
  xg?: number;
  xgConceded?: number;
  xPoints?: number;
  xgDiff?: number;
};

export type AnalystStatEntry = {
  value: number;
  format?: string;
  perMatch?: number;
};

export type AnalystSquadMember = {
  id: number;
  name: string;
  position?: string;
  rating?: number | null;
  goals?: number;
  assists?: number;
  marketValue?: number;
  excludeFromRanking?: boolean;
  injured?: boolean;
  expectedReturn?: string;
};

export type AnalystAbsence = {
  id: number;
  name: string;
  type?: string;
  position?: string;
  marketValue?: number;
  rating?: number | null;
  goals?: number;
  assists?: number;
  isKeyPlayer?: boolean;
  excludeFromRanking?: boolean;
  expectedReturn?: string;
};

export type AnalystLineupPlayer = {
  id: number;
  name: string;
  marketValue?: number;
  rating?: number | null;
  position?: string;
};

export type AnalystLineup = {
  formation?: string | null;
  starters?: AnalystLineupPlayer[];
};

export type AnalystRecentMatch = {
  utcTime: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  competition?: string;
};

export type AnalystTeamInput = {
  teamId: number;
  name: string;
  tableAll?: AnalystTableRow | null;
  tableHome?: AnalystTableRow | null;
  tableAway?: AnalystTableRow | null;
  xgRow?: AnalystTableRow | null;
  recentMatches: AnalystRecentMatch[];
  stats: Record<string, AnalystStatEntry>;
  squad: AnalystSquadMember[];
  absences: AnalystAbsence[];
  lineup?: AnalystLineup | null;
  formation?: string | null;
  playerStats?: Record<string, any>;
};

export type AnalystLeagueInput = {
  rowsAll: AnalystTableRow[];
  rowsHome: AnalystTableRow[];
  rowsAway: AnalystTableRow[];
  xgRows: AnalystTableRow[];
  legend: { title: string; indices: number[] }[];
};

export type AnalystInput = {
  matchId?: string;
  kickoffIso?: string;
  baseLambdas: { home: number; away: number };
  market?: any;
  referee?: any;
  weather?: any;
  h2h?: { count: number; homeGoalsAvg: number; awayGoalsAvg: number } | null;
  league: AnalystLeagueInput;
  home: AnalystTeamInput;
  away: AnalystTeamInput;
};

/* ------------------------------------------------------------------ */
/* Types de sortie                                                     */
/* ------------------------------------------------------------------ */

export type AnalystModuleCard = {
  id: number;
  title: string;
  status: 'ok' | 'partial' | 'unavailable';
  summary: string;
  metrics: { label: string; value: string }[];
};

export type AnalystReport = {
  version: string;
  generatedAt: string;
  homeName: string;
  awayName: string;
  kickoffIso: string;
  confidence: {
    score: number;
    label: string;
    completeness: number;
    separation: number;
    agreement: number;
  };
  lambdas: { home: number; away: number; total: number; startHome: number; startAway: number };
  model: {
    btts: number;
    over15: number;
    over25: number;
    over35: number;
    noGoal: number;
    firstHome: number;
    firstAway: number;
    firstHalf: { over05: number; over15: number; over25: number };
    secondHalf: { over05: number; over15: number; over25: number };
    topScores: { h: number; a: number; p: number }[];
  };
  dixonColes: {
    rho: number;
    prior: number;
    fitted: boolean;
    samples: number;
    note: string;
  };
  timeDecay: {
    xi: number;
    halfLifeDays: number;
    homeMatches: number;
    awayMatches: number;
    homeWeight: number;
    awayWeight: number;
    note: string;
  };
  scheduleStrength: {
    home: { sos: number; attack: number; defence: number; matches: number; note: string };
    away: { sos: number; attack: number; defence: number; matches: number; note: string };
    splits: {
      homeAttack: number;
      homeDefence: number;
      awayAttack: number;
      awayDefence: number;
      leagueHomeAdvantage: number;
      note: string;
    };
  };
  finishing: {
    home: {
      xg: number;
      npxg: number;
      penaltiesWon: number;
      penaltiesConceded: number;
      bigChances: number;
      bigChanceConversion: number;
      finishingRatio: number;
      setPieceGoals: number;
      setPieceGoalsConceded: number;
      corners: number;
      boxTouches: number;
      shotsOnTarget: number;
    };
    away: {
      xg: number;
      npxg: number;
      penaltiesWon: number;
      penaltiesConceded: number;
      bigChances: number;
      bigChanceConversion: number;
      finishingRatio: number;
      setPieceGoals: number;
      setPieceGoalsConceded: number;
      corners: number;
      boxTouches: number;
      shotsOnTarget: number;
    };
    goalkeepers: {
      home: { name: string; goalsPrevented: number | null; savePercentage: number | null; factor: number; note: string };
      away: { name: string; goalsPrevented: number | null; savePercentage: number | null; factor: number; note: string };
    };
  };
  absences: {
    home: {
      items: { name: string; type: string; role: string; impact: number; longTerm: boolean; note: string }[];
      attackImpact: number;
      defenceImpact: number;
      keyPlayers: number;
      longTerm: number;
      note: string;
    };
    away: {
      items: { name: string; type: string; role: string; impact: number; longTerm: boolean; note: string }[];
      attackImpact: number;
      defenceImpact: number;
      keyPlayers: number;
      longTerm: number;
      note: string;
    };
    officialLineup: {
      available: boolean;
      home?: { formation?: string | null; strength: number; rotation: number; note: string };
      away?: { formation?: string | null; strength: number; rotation: number; note: string };
      note: string;
    };
  };
  tactics: {
    home: { profile: string; tempo: number; possession?: number; press?: number; direct?: number; block?: number; note: string };
    away: { profile: string; tempo: number; possession?: number; press?: number; direct?: number; block?: number; note: string };
    matchup: { label: string; tempoFactor: number; rhoAdjustment: number; effects: string[]; note: string };
  };
  market: {
    available: boolean;
    method: string;
    overround: number;
    devigged: { home: number; draw: number; away: number; over25: number | null };
    pureModel: { home: number; draw: number; away: number; over25: number };
    calibrated: { home: number; draw: number; away: number; over25: number };
    weights: { model: number; market: number };
    edges: { home: number; draw: number; away: number; over25: number | null };
    value: { pick: string; label: string; edge: number };
    note: string;
  };
  context: {
    home: {
      matches7: number;
      matches14: number;
      restDays: number | null;
      european: { found: boolean; competition: string; date: string; days: number | null; travel: boolean; note: string };
      fatigue: number;
      note: string;
    };
    away: {
      matches7: number;
      matches14: number;
      restDays: number | null;
      european: { found: boolean; competition: string; date: string; days: number | null; travel: boolean; note: string };
      fatigue: number;
      note: string;
    };
    stakes: { home: string; away: string; homeFactor: number; awayFactor: number; note: string };
    referee: { name: string; yellowPerMatch: number | null; penaltiesPerMatch: number | null; foulsPerMatch: number | null; effect: number; note: string };
    weather: { temperature: number | null; wind: number | null; precipitation: number | null; effect: number; note: string };
  };
  simulation: {
    runs: number;
    seed: number;
    home: number;
    draw: number;
    away: number;
    over15: number;
    over25: number;
    over35: number;
    btts: number;
    expectedGoals: { home: number; away: number; total: number };
    goalRange: { low: number; high: number; mean: number };
    firstHalf: { over05: number; averageGoals: number };
    lateGoalProbability: number;
    topScores: { h: number; a: number; p: number }[];
    scenarios: { label: string; probability: number }[];
  };
  synthesis: { headline: string; verdict: string; bullets: string[]; text: string };
  modules: AnalystModuleCard[];
};

/* ------------------------------------------------------------------ */
/* Helpers de lecture des statistiques d'équipe                         */
/* ------------------------------------------------------------------ */

function statValue(team: AnalystTeamInput, key: string): number | null {
  const entry = team.stats?.[key];
  if (!entry || !Number.isFinite(entry.value)) return null;
  if (typeof entry.perMatch === 'number' && Number.isFinite(entry.perMatch)) return entry.perMatch;
  return entry.value;
}

function goalsFor(row?: AnalystTableRow | null): number {
  if (!row) return 0;
  if (typeof row.goalsScored === 'number') return row.goalsScored;
  return 0;
}

function goalsAgainst(row?: AnalystTableRow | null): number {
  if (!row) return 0;
  if (typeof row.goalsConceded === 'number') return row.goalsConceded;
  return 0;
}

/* ------------------------------------------------------------------ */
/* MODULE 01 — Dixon-Coles + décroissance exponentielle                */
/* ------------------------------------------------------------------ */

const XI_DECAY = 0.0075; // ~92 jours de demi-vie
const RHO_PRIOR = -0.05;

function dixonColesTau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function buildScoreMatrix(lh: number, la: number, rho: number, maxGoals = 8): number[][] {
  const matrix: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const row: number[] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const base = poissonPmf(h, lh) * poissonPmf(a, la);
      const tau = dixonColesTau(h, a, lh, la, rho);
      const value = Math.max(0, base * tau);
      row.push(value);
      total += value;
    }
    matrix.push(row);
  }
  if (total > 0) {
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= total;
    }
  }
  return matrix;
}

function matrixProbabilities(matrix: number[][], lh: number, la: number) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let btts = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let firstHalfGoals = 0;
  let secondHalfGoals = 0;
  const scores: { h: number; a: number; p: number }[] = [];

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix.length; a++) {
      const p = matrix[h][a];
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h >= 1 && a >= 1) btts += p;
      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;

      // Répartition empirique : 44 % des buts en 1re période, 56 % en 2e
      const pH1 = 0.44;
      const pH2 = 0.56;
      const gh1 = (h + a) * pH1;
      firstHalfGoals += p * gh1;
      const gh2 = (h + a) * pH2;
      secondHalfGoals += p * gh2;

      if (h <= 6 && a <= 6) scores.push({ h, a, p: round(p, 4) });
    }
  }

  scores.sort((x, y) => y.p - x.p);

  // Probabilité d'au moins un but par période (Poisson sur les λ partiels)
  const lambdaTotal = lh + la;
  const firstHalfOver05 = 1 - Math.exp(-lambdaTotal * 0.44);
  const secondHalfOver05 = 1 - Math.exp(-lambdaTotal * 0.56);

  return {
    home: pHome,
    draw: pDraw,
    away: pAway,
    btts,
    over15,
    over25,
    over35,
    firstHalfOver05,
    secondHalfOver05,
    firstHalfGoals,
    secondHalfGoals,
    scores,
  };
}

/**
 * Estimation de ρ par moindres carrés sur la matrice de scores (1,0), (0,1),
 * (0,0), (1,1) — méthode Dixon & Coles (1997) appliquée aux matchs récents.
 */
function estimateRho(matches: AnalystRecentMatch[], lh: number, la: number): { rho: number; samples: number } {
  // L'échantillon utile est constitué des matchs à score bas (0-0, 1-0, 0-1, 1-1).
  const counts = { '0-0': 0, '1-0': 0, '0-1': 0, '1-1': 0 } as Record<string, number>;
  let usable = 0;
  for (const m of matches) {
    const hs = m.homeScore;
    const as = m.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    if (hs <= 1 && as <= 1) {
      counts[`${hs}-${as}`] += 1;
      usable += 1;
    }
  }
  if (usable < 16) return { rho: RHO_PRIOR, samples: usable };

  let bestRho = RHO_PRIOR;
  let bestError = Number.POSITIVE_INFINITY;
  for (let rho = -0.25; rho <= 0.2501; rho += 0.005) {
    const matrix = buildScoreMatrix(lh, la, rho, 4);
    let error = 0;
    for (const key of Object.keys(counts)) {
      const parts = key.split('-');
      const obs = counts[key] / usable;
      const pred = matrix[Number(parts[0])][Number(parts[1])];
      error += (obs - pred) * (obs - pred);
    }
    if (error < bestError) {
      bestError = error;
      bestRho = rho;
    }
  }
  return { rho: clamp(bestRho, -0.2, 0.2), samples: usable };
}

/* ------------------------------------------------------------------ */
/* MODULE 02 — Force du calendrier + splits domicile/extérieur          */
/* ------------------------------------------------------------------ */

type FormAggregate = {
  attack: number;
  defence: number;
  sos: number;
  matches: number;
  weighted: number;
  note: string;
};

function opponentStrengthMap(league: AnalystLeagueInput): Map<number, number> {
  const map = new Map<number, number>();
  const xgRows = league.xgRows || [];
  const strengths: number[] = [];

  for (const row of xgRows) {
    if (!row.id || !row.played) continue;
    const xp = (row.xPoints ?? 0) / row.played;
    strengths.push(xp);
    map.set(row.id, xp);
  }
  if (!strengths.length) {
    for (const row of league.rowsAll || []) {
      if (!row.id || !row.played) continue;
      const xp = (row.pts ?? 0) / row.played;
      strengths.push(xp);
      map.set(row.id, xp);
    }
  }
  if (!strengths.length) return map;

  const avg = mean(strengths);
  const sd = stdDev(strengths) || 0.35;
  const out = new Map<number, number>();
  map.forEach((value, key) => {
    // 1.0 = adversaire de force moyenne ; > 1 = adversaire plus fort
    const rel = 1 + (value - avg) / (2.4 * sd);
    out.set(key, clamp(rel, 0.55, 1.65));
  });
  return out;
}

function aggregateForm(
  team: AnalystTeamInput,
  strengthMap: Map<number, number>,
  kickoffIso: string,
  maxMatches = 12
): FormAggregate {
  const matches = (team.recentMatches || [])
    .filter(m => m.utcTime && daysBetween(m.utcTime, kickoffIso) >= -1)
    .sort((a, b) => Date.parse(b.utcTime) - Date.parse(a.utcTime))
    .slice(0, maxMatches);

  if (!matches.length) {
    return { attack: 0, defence: 0, sos: 1, matches: 0, weighted: 0, note: 'Aucun match récent exploitable.' };
  }

  let wSum = 0;
  let wSos = 0;
  let gfAdj = 0;
  let gaAdj = 0;
  let rawSos = 0;

  for (const m of matches) {
    const ageDays = Math.max(0, daysBetween(m.utcTime, kickoffIso));
    const w = Math.exp(-XI_DECAY * ageDays);
    const isHome = m.homeId === team.teamId;
    const opponentId = isHome ? m.awayId : m.homeId;
    const oppStrength = strengthMap.get(opponentId) ?? 1;
    const goalsFor = isHome ? m.homeScore : m.awayScore;
    const goalsAgainst = isHome ? m.awayScore : m.homeScore;

    // Ajustement « force de l'adversaire » : marquer face à une grande équipe
    // vaut davantage que face à une équipe faible ; encaisser face à une grande
    // équipe est plus banal que face à une équipe faible.
    const venueBonus = isHome ? 1.06 : 0.96;
    gfAdj += w * goalsFor * oppStrength * venueBonus;
    gaAdj += w * (goalsAgainst / oppStrength) * (isHome ? 1.04 : 0.97);
    wSum += w;
    wSos += w * oppStrength;
    rawSos += oppStrength;
  }

  const denom = Math.max(0.0001, wSum);
  const attack = gfAdj / denom;
  const defence = gaAdj / denom;
  const sos = wSum > 0 ? wSos / wSum : rawSos / matches.length;

  return {
    attack: round(attack, 3),
    defence: round(defence, 3),
    sos: round(sos, 3),
    matches: matches.length,
    weighted: round(wSum, 2),
    note:
      `${matches.length} matchs pondérés (demi-vie ${Math.round(Math.log(2) / XI_DECAY)} j), ` +
      `adversaires de force moyenne ${(sos * 100 - 100).toFixed(0)} %.`,
  };
}

/* ------------------------------------------------------------------ */
/* MODULE 03 — npxG, coups de pied arrêtés, finition & gardiens         */
/* ------------------------------------------------------------------ */

type FinishingProfile = AnalystReport['finishing']['home'];

function buildFinishingProfile(
  team: AnalystTeamInput,
  playedFallback: number,
  goalsPerMatch: number
): FinishingProfile {
  const xgRaw = statValue(team, 'expected_goals_team');
  const xgConRaw = statValue(team, 'expected_goals_conceded_team');

  const perMatchOf = (key: string): number => {
    const entry = team.stats?.[key];
    if (!entry || !Number.isFinite(entry.value)) return 0;
    if (typeof entry.perMatch === 'number' && Number.isFinite(entry.perMatch)) return entry.perMatch;
    return entry.value;
  };

  const xg = xgRaw !== null ? perMatchOf('expected_goals_team') : goalsPerMatch;
  const xga = xgConRaw !== null ? perMatchOf('expected_goals_conceded_team') : goalsPerMatch;

  const penaltiesWon = statValue(team, 'penalty_won_team') ?? 0;
  const penaltiesConceded = statValue(team, 'penalty_conceded_team') ?? 0;
  const bigChances = statValue(team, 'big_chance_team') ?? 0;
  const bigMissed = statValue(team, 'big_chance_missed_team') ?? 0;
  const corners = statValue(team, 'corner_taken_team') ?? 0;
  const boxTouches = statValue(team, 'touches_in_opp_box_team') ?? 0;
  const shotsOnTarget = statValue(team, 'ontarget_scoring_att_team') ?? 0;
  const setPieceGoals = statValue(team, '_set_piece_goals_team') ?? 0;
  const setPieceGoalsConceded = statValue(team, '_set_piece_goals_conceded_team') ?? 0;

  const penaltyXG = 0.78; // xG moyen d'un penalty
  const npxg = Math.max(0.05, xg - penaltyXG * penaltiesWon);
  const conversion = bigChances > 0 ? clamp((bigChances - bigMissed) / bigChances, 0, 1) : 0;
  const finishingRatio = xg > 0.2 ? clamp(goalsPerMatch / xg, 0.45, 1.85) : 1;
  void playedFallback;
  void xga;

  return {
    xg: round(xg, 2),
    npxg: round(npxg, 2),
    penaltiesWon: round(penaltiesWon, 2),
    penaltiesConceded: round(penaltiesConceded, 2),
    bigChances: round(bigChances, 1),
    bigChanceConversion: round(conversion, 2),
    finishingRatio: round(finishingRatio, 2),
    setPieceGoals: round(setPieceGoals, 1),
    setPieceGoalsConceded: round(setPieceGoalsConceded, 1),
    corners: round(corners, 1),
    boxTouches: round(boxTouches, 1),
    shotsOnTarget: round(shotsOnTarget, 1),
  };
}

function goalkeeperProfile(team: AnalystTeamInput): AnalystReport['finishing']['goalkeepers']['home'] {
  const raw = (team as any)?.playerStats || {};
  const prevented = raw._goals_prevented?.value;
  const savePct = raw._save_percentage?.value;
  const name = raw._goals_prevented?.name || raw._save_percentage?.name || '';

  let factor = 1;
  let note = 'Statistiques de gardien indisponibles : aucun ajustement appliqué.';
  if (typeof prevented === 'number' && Number.isFinite(prevented)) {
    // Goals Prevented (par 90) : xGOT − buts encaissés (positif = excellent gardien)
    factor = 1 + clamp(prevented * 0.07, -0.09, 0.09);
    note = `${prevented >= 0 ? '+' : ''}${round(prevented, 2)} but évité(s) par 90 par rapport au xGOT : garde ×${round(factor, 3)}.`;
  } else if (typeof savePct === 'number' && Number.isFinite(savePct)) {
    factor = 1 + clamp(((savePct - 70) / 100) * 0.8, -0.07, 0.08);
    note = `${round(savePct, 1)} % d'arrêts (moyenne championnat ≈ 70 %) : garde ×${round(factor, 3)}.`;
  }

  return {
    name: String(name || 'Gardien'),
    goalsPrevented: typeof prevented === 'number' ? round(prevented, 2) : null,
    savePercentage: typeof savePct === 'number' ? round(savePct, 1) : null,
    factor: round(factor, 3),
    note,
  };
}

/* ------------------------------------------------------------------ */
/* MODULE 04 — Absences intelligentes & onze officiel                   */
/* ------------------------------------------------------------------ */

type AbsenceAnalysis = AnalystReport['absences']['home'];

function analyseAbsences(team: AnalystTeamInput): AbsenceAnalysis {
  const squad = team.squad || [];
  const totalSquadValue = squad.reduce((acc, m) => acc + (m.marketValue || 0), 0);
  const teamGa = squad.reduce((acc, m) => acc + (m.goals || 0) + (m.assists || 0), 0);

  const items: AbsenceAnalysis['items'] = [];
  let attackImpact = 0;
  let defenceImpact = 0;
  let keyPlayers = 0;
  let longTerm = 0;

  for (const abs of team.absences || []) {
    const member = squad.find(m => m.id === abs.id);
    const exclude = member?.excludeFromRanking ?? abs.excludeFromRanking;
    const expectedReturn = member?.expectedReturn ?? abs.expectedReturn;
    const value = abs.marketValue ?? member?.marketValue ?? 0;
    const goals = abs.goals ?? member?.goals ?? 0;
    const assists = abs.assists ?? member?.assists ?? 0;
    const rating = abs.rating ?? member?.rating ?? null;
    const position = (abs.position || member?.position || '').toUpperCase();

    // Joueur de banc / longue absence : son poids est déjà intégré dans
    // les moyennes de saison → on ne le pénalise pas une seconde fois.
    const fringe = exclude === true;
    // Retour prévu au-delà de 30 jours = absence de longue durée (déjà absente des xG de saison)
    const longAbsence = Boolean(expectedReturn && /january|february|march|avril|mai|juin|2027|2028/i.test(String(expectedReturn)));

    const valueShare = totalSquadValue > 0 && value > 0 ? value / totalSquadValue : 0;
    const gaShare = teamGa > 0 ? (goals + assists) / teamGa : 0;

    let weight = fringe ? 0.22 : 1;
    if (longAbsence) weight *= 0.35;
    if (abs.type === 'doubtful') weight *= 0.45;

    const ratingBoost = rating && rating >= 7.1 ? 1.25 : rating && rating <= 6.5 ? 0.85 : 1;
    const impact = clamp(weight * (0.55 * clamp(valueShare * 6, 0, 1) + 0.45 * clamp(gaShare * 3.2, 0, 1)) * ratingBoost, 0, 0.16);

    const isAttacker = /ST|CF|FW|LW|RW|CAM|AM|W/.test(position) || goals >= 2;
    const isDefender = /GK|CB|LB|RB|LWB|RWB|CM|DM/.test(position);

    if (isAttacker) attackImpact += impact * 1.15;
    else if (isDefender) defenceImpact += impact * 1.05;
    else {
      attackImpact += impact * 0.7;
      defenceImpact += impact * 0.7;
    }

    if (impact >= 0.045) keyPlayers += 1;
    if (longAbsence || fringe) longTerm += 1;

    const role = fringe
      ? 'Remplaçant / longue absence (déjà intégré dans les xG de saison)'
      : longAbsence
      ? 'Absence de longue durée (retour lointain, déjà intégrée)'
      : 'Titulaire régulier';

    items.push({
      name: abs.name,
      type: abs.type || 'injury',
      role,
      impact: round(impact, 3),
      longTerm: fringe || longAbsence,
      note: `G+A ${goals + assists} · note ${rating ?? '—'} · poids ${round(impact * 100, 1)} %`,
    });
  }

  items.sort((a, b) => b.impact - a.impact);

  return {
    items,
    attackImpact: round(clamp(attackImpact, 0, 0.24), 3),
    defenceImpact: round(clamp(defenceImpact, 0, 0.2), 3),
    keyPlayers,
    longTerm,
    note: items.length
      ? `${items.length} absence(s) signalée(s), dont ${longTerm} déjà intégrée(s) aux moyennes de saison (pas de double pénalisation).`
      : 'Aucun absent signalé : effectif au complet.',
  };
}

function lineupStrength(lineup: AnalystLineup | null | undefined, squad: AnalystSquadMember[]) {
  if (!lineup || !Array.isArray(lineup.starters) || !lineup.starters.length) return null;
  const starters = lineup.starters;
  const starterValue = starters.reduce((acc, p) => acc + (p.marketValue || 0), 0);
  const starterRating = starters.map(p => p.rating).filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
  const core = squad
    .filter(m => m.excludeFromRanking === false)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, 11);
  const coreValue = core.reduce((acc, m) => acc + (m.marketValue || 0), 0);
  const coreRating = core.map(m => m.rating).filter((r): r is number => typeof r === 'number' && Number.isFinite(r));

  const strength = starterRating.length ? mean(starterRating) : coreRating.length ? mean(coreRating) : 0;
  const rotation = coreValue > 0 && starterValue > 0 ? starterValue / coreValue : 1;
  return {
    formation: lineup.formation || null,
    strength: round(strength, 2),
    rotation: round(rotation, 3),
    note:
      starterRating.length
        ? `Note moyenne du onze officiel ${round(strength, 2)} (11 titulaires), valeur ${round(rotation, 2)} × le noyau habitual.`
        : `Onze officiel publié (11 titulaires), valeur ${round(rotation, 2)} × le noyau habituel.`,
  };
}

/* ------------------------------------------------------------------ */
/* MODULE 05 — Confrontation tactique                                   */
/* ------------------------------------------------------------------ */

type TacticalProfile = AnalystReport['tactics']['home'];

function buildTacticalProfile(team: AnalystTeamInput): TacticalProfile {
  const possession = statValue(team, 'possession_percentage_team');
  const press = statValue(team, 'poss_won_att_3rd_team');
  const longBalls = statValue(team, 'accurate_long_balls_team');
  const passes = statValue(team, 'accurate_pass_team');
  const crosses = statValue(team, 'accurate_cross_team');
  const clearances = statValue(team, 'effective_clearance_team');
  const interceptions = statValue(team, 'interception_team');
  const tackles = statValue(team, 'total_tackle_team');
  const distance = statValue(team, 'phys_tdc_team');
  const bigChances = statValue(team, 'big_chance_team');

  const scores = {
    pressing: press !== null ? clamp((press - 2.2) / 4, 0, 1) : 0,
    block: clearances !== null ? clamp((clearances - 16) / 16, 0, 1) : 0,
    direct: longBalls !== null ? clamp((longBalls - 14) / 16, 0, 1) : 0,
    possession: possession !== null ? clamp((possession - 38) / 30, 0, 1) : 0,
    transition: bigChances !== null ? clamp((bigChances - 1.6) / 2.4, 0, 1) : 0,
  };

  let profile = 'Équilibré / contrôle du match';
  let tempo = 1;
  const ranked = scores.pressing + scores.block + scores.direct + scores.possession + scores.transition;

  if (ranked < 0.9) {
    profile = 'Profil discret — peu de volume offensif';
    tempo = 0.88;
  } else if (scores.pressing >= 0.6 && scores.possession >= 0.45) {
    profile = 'Pressing haut & possession';
    tempo = 1.18;
  } else if (scores.pressing >= 0.6) {
    profile = 'Pressing haut & récupération';
    tempo = 1.14;
  } else if (scores.direct >= 0.55 && (crosses || 0) >= 5) {
    profile = 'Jeu direct & centres';
    tempo = 1.08;
  } else if (scores.block >= 0.55 && scores.possession <= 0.45) {
    profile = 'Bloc bas compact';
    tempo = 0.86;
  } else if (scores.transition >= 0.55) {
    profile = 'Transitions rapides';
    tempo = 1.12;
  } else if (scores.possession >= 0.6) {
    profile = 'Possession & construction';
    tempo = 1.04;
  } else if (scores.block >= 0.45) {
    profile = 'Bloc médian & contestations';
    tempo = 0.92;
  }

  const physical = distance !== null ? distance : null;
  const notes: string[] = [];
  if (possession !== null) notes.push(`${round(possession, 1)} % de possession`);
  if (press !== null) notes.push(`${round(press, 1)} ballons récupérés dans le 3e tiers adverse`);
  if (crosses !== null) notes.push(`${round(crosses, 1)} centres réussis`);
  if (clearances !== null) notes.push(`${round(clearances, 1)} dégagements`);
  if (physical !== null) notes.push(`${round(physical, 0)} m parcourus par match`);

  return {
    profile,
    tempo: round(tempo, 3),
    possession: possession !== null ? round(possession, 1) : undefined,
    press: press !== null ? round(press, 1) : undefined,
    direct: longBalls !== null ? round(longBalls, 1) : undefined,
    block: clearances !== null ? round(clearances, 1) : undefined,
    note: notes.length ? notes.join(' · ') : 'Statistiques de style partielles.',
  };
}

type TacticalMatchup = {
  label: string;
  tempoFactor: number;
  rhoAdjustment: number;
  effects: string[];
  note: string;
  homeAdj: number;
  awayAdj: number;
};

function tacticalMatchup(home: TacticalProfile, away: TacticalProfile): TacticalMatchup {
  const effects: string[] = [];
  let tempoFactor = (home.tempo + away.tempo) / 2;
  let homeAdj = 0;
  let awayAdj = 0;

  const homePresses = /Pressing/.test(home.profile);
  const awayPresses = /Pressing/.test(away.profile);
  const homeBlock = /Bloc bas/.test(home.profile);
  const awayBlock = /Bloc bas/.test(away.profile);
  const homeDirect = /direct/.test(home.profile);
  const awayDirect = /direct/.test(away.profile);

  if (homePresses && awayBlock) {
    homeAdj += 0.05;
    awayAdj -= 0.03;
    effects.push('Pressing haut contre bloc bas : espace dans l’axe et volume de tirs élevé pour l’équipe à domicile.');
  }
  if (awayPresses && homeBlock) {
    awayAdj += 0.05;
    homeAdj -= 0.03;
    effects.push('Bloc bas domicile soumis au pressing adverse : volume offensif réduit pour l’équipe à l’extérieur.');
  }
  if (homePresses && awayPresses) {
    tempoFactor += 0.05;
    effects.push('Deux pressings hauts : match ouvert, turnover fréquents et второй tempo élevé.');
  }
  if (homeBlock && awayBlock) {
    tempoFactor -= 0.07;
    effects.push('Deux blocs bas : duel serré, peu d’occasions et score plus bas attendu.');
  }
  if (homeDirect && awayBlock) {
    tempoFactor += 0.04;
    effects.push('Jeu direct contre bloc bas : Ballonsoureux, coups de pied arrêtés et situations de second Ballon.');
  }
  if (awayDirect && homeBlock) {
    tempoFactor += 0.04;
    effects.push('L’adversaire joue direct face à un bloc bas : plus de coups de pied arrêtés à défendre.');
  }
  if (Math.abs(home.tempo - away.tempo) > 0.18) {
    effects.push(
      `Écart de tempo marqué (${home.tempo.toFixed(2)} contre ${away.tempo.toFixed(2)}) : l'équipe au tempo le plus élevé impose son rythme.`
    );
  }

  const rhoAdjustment = clamp((tempoFactor - 1) * 0.12, -0.05, 0.05);
  const label =
    tempoFactor >= 1.08
      ? 'Rencontre ouverte, beaucoup de buts attendus'
      : tempoFactor <= 0.94
      ? 'Rencontre fermée, peu de buts attendus'
      : 'Confrontation équilibrée';

  return {
    label,
    tempoFactor: round(clamp(tempoFactor, 0.78, 1.32), 3),
    rhoAdjustment: round(rhoAdjustment, 3),
    effects: effects.length ? effects : ['Aucun effet de style majeur : les profils se compensent.'],
    note: `Facteur de tempo global ${round(tempoFactor, 2)} × appliqué au total de buts attendus.`,
    homeAdj: round(homeAdj, 3),
    awayAdj: round(awayAdj, 3),
  };
}

/* ------------------------------------------------------------------ */
/* MODULE 06 — Calibration bayésienne avec le marché                   */
/* ------------------------------------------------------------------ */

function normaliseProbs(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 1 / values.length);
  return values.map(v => v / total);
}

/** Méthode « power » : retrait de marge proportionnel à la puissance des cotes */
function devigPower(implied: number[]): { probs: number[]; overround: number } {
  const overround = implied.reduce((a, b) => a + b, 0);
  if (!implied.length || overround <= 0) return { probs: normaliseProbs(implied), overround };
  let lo = 0.2;
  let hi = 3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = implied.reduce((acc, q) => acc + Math.pow(q, mid), 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return { probs: normaliseProbs(implied.map(q => Math.pow(q, k))), overround };
}

/** Méthode de Shin : retrait de marge corrigé du biais « favorite-longshot » */
function devigShin(implied: number[]): { probs: number[]; overround: number } | null {
  if (implied.length < 2) return null;
  const overround = implied.reduce((a, b) => a + b, 0);
  if (overround <= 1.0001) return { probs: normaliseProbs(implied), overround };
  const sumSq = implied.reduce((a, b) => a + b * b, 0);
  if (sumSq <= 0) return null;

  const shinProb = (z: number): number[] => {
    const out: number[] = [];
    for (const q of implied) {
      const inner = z * z + ((4 * (1 - z) * q * q) / sumSq);
      const value = (Math.sqrt(Math.max(0, inner)) - z) / (2 * (1 - z));
      out.push(Math.max(0.0001, value));
    }
    return normaliseProbs(out);
  };

  let lo = 0;
  let hi = 0.6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = shinProb(mid).reduce((a, b) => a + b, 0);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  return { probs: shinProb(z), overround };
}

function extractMarket(market: any) {
  if (!market || typeof market !== 'object') return null;
  const read = (keys: string[]): number | null => {
    for (const key of keys) {
      const value = market[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return null;
  };
  const home = read(['home', 'homeWin', '1']);
  const draw = read(['draw', 'X']);
  const away = read(['away', 'awayWin', '2']);
  if (home === null || draw === null || away === null) return null;
  const over25 = read(['over25', 'over_2_5']);
  const under25 = read(['under25', 'under_2_5']);

  // Les valeurs > 1.5 sont des cotes décimales, sinon ce sont des probabilités.
  const isDecimal = home > 1.5 || draw > 1.5 || away > 1.5;
  const impliedRaw = isDecimal ? [1 / home, 1 / draw, 1 / away] : [home, draw, away];
  const over25Raw = over25 !== null ? (isDecimal ? 1 / over25 : over25) : null;
  const under25Raw = under25 !== null ? (isDecimal ? 1 / under25 : under25) : null;

  const shin = devigShin(impliedRaw);
  const devig = shin || devigPower(impliedRaw);
  const method = shin ? 'Shin' : 'Power';

  let over25Prob: number | null = null;
  if (over25Raw !== null && under25Raw !== null) {
    over25Prob = over25Raw / (over25Raw + under25Raw);
  } else if (over25Raw !== null) {
    // Sans la cote adverse on ne peut pas retirer la marge : on conserve l'implicite
    over25Prob = isDecimal ? clamp(over25Raw, 0.05, 0.95) : clamp(over25Raw, 0.02, 0.98);
  }

  return {
    method,
    overround: round(devig.overround, 4),
    probs: {
      home: devig.probs[0],
      draw: devig.probs[1],
      away: devig.probs[2],
    },
    over25: over25Prob,
    raw: { home, draw, away, over25 },
  };
}

/* ------------------------------------------------------------------ */
/* MODULE 07 — Congestion, calendrier européen, enjeux, arbitre, météo  */
/* ------------------------------------------------------------------ */

type CalendarBlock = {
  matches7: number;
  matches14: number;
  restDays: number | null;
  european: { found: boolean; competition: string; date: string; days: number | null; travel: boolean; note: string };
  fatigue: number;
  note: string;
};

function analyseCalendar(
  team: AnalystTeamInput,
  kickoffIso: string,
  allTeamMatches: AnalystRecentMatch[]
): CalendarBlock {
  const kickMs = Date.parse(kickoffIso);
  const played = (allTeamMatches || [])
    .filter(m => m.utcTime && Date.parse(m.utcTime) <= kickMs)
    .sort((a, b) => Date.parse(b.utcTime) - Date.parse(a.utcTime));

  const last7 = played.filter(m => (kickMs - Date.parse(m.utcTime)) / 86_400_000 <= 7);
  const last14 = played.filter(m => (kickMs - Date.parse(m.utcTime)) / 86_400_000 <= 14);
  const restDays = played.length ? Math.round((kickMs - Date.parse(played[0].utcTime)) / 86_400_000) : null;

  let european = {
    found: false,
    competition: '',
    date: '',
    days: null as number | null,
    travel: false,
    note: 'Aucun engagement européen à ±4 jours.',
  };

  const candidates = played
    .filter(m => m.competition && EUROPEAN_COMPETITIONS.test(m.competition))
    .filter(m => {
      const delta = Math.abs((Date.parse(m.utcTime) - kickMs) / 86_400_000);
      return delta <= 4;
    });

  if (candidates.length) {
    const best = candidates.sort(
      (a, b) => Math.abs(Date.parse(a.utcTime) - kickMs) - Math.abs(Date.parse(b.utcTime) - kickMs)
    )[0];
    const days = Math.round((Date.parse(best.utcTime) - kickMs) / 86_400_000);
    const travel = best.awayId === team.teamId;
    european = {
      found: true,
      competition: best.competition || 'Compétition européenne',
      date: best.utcTime.slice(0, 10),
      days,
      travel,
      note:
        days < 0
          ? `${best.competition} ${Math.abs(days)} jour(s) AVANT ce match${travel ? ' en déplacement' : ''} : fatigue et calendrier à anticiper.`
          : `${best.competition} ${days} jour(s) APRÈS ce match : rotation probable à anticiper.`,
    };
  }

  // Indice de fatigue : 0 = repos total ; 1 = charge maximale
  let fatigue = clamp((last7.length * 0.16 + last14.length * 0.06), 0, 1);
  if (european.found && (european.days ?? 0) < 0) fatigue = clamp(fatigue + (european.travel ? 0.22 : 0.14), 0, 1);
  if (restDays !== null && restDays >= 6) fatigue = clamp(fatigue - 0.12, 0, 1);
  if (restDays !== null && restDays <= 3) fatigue = clamp(fatigue + 0.12, 0, 1);

  const notes: string[] = [];
  notes.push(`${last7.length} match(s) sur 7 jours, ${last14.length} sur 14 jours`);
  if (restDays !== null) notes.push(`${restDays} jour(s) de repos depuis le dernier match`);
  notes.push(european.note);

  return {
    matches7: last7.length,
    matches14: last14.length,
    restDays,
    european,
    fatigue: round(fatigue, 3),
    note: notes.join(' · '),
  };
}

function analyseStakes(team: AnalystTeamInput, legend: { title: string; indices: number[] }[]) {
  const rank = team.tableAll?.idx ?? null;
  let label = 'Match de milieu de tableau (enjeu limité)';
  let factor = 0.985;

  if (rank !== null) {
    for (const zone of legend || []) {
      const idx = zone.indices || [];
      if (idx.some(i => i === rank - 1)) {
        const title = String(zone.title || '').toLowerCase();
        if (title.includes('champions')) {
          label = 'Course européenne — enjeu majeur';
          factor = 1.035;
        } else if (title.includes('europa')) {
          label = 'Course à l’Europe — enjeu significatif';
          factor = 1.025;
        } else if (title.includes('relegation') || title.includes('relégation')) {
          label = 'Survie en jeu — pression maximale';
          factor = 1.04;
        } else {
          label = `Enjeu : ${zone.title}`;
          factor = 1.02;
        }
        break;
      }
    }
    if (rank <= 4 && label.startsWith('Match de milieu')) {
      label = 'Haut de tableau — pression sur le podium';
      factor = 1.02;
    }
  }

  return { label, factor };
}

/* ------------------------------------------------------------------ */
/* MODULE 08 — Monte-Carlo minute par minute                            */
/* ------------------------------------------------------------------ */

const MINUTE_CURVE: number[] = (() => {
  const weights: number[] = [];
  for (let m = 1; m <= 90; m++) {
    let w: number;
    if (m <= 10) w = 0.72;
    else if (m <= 30) w = 1.18;
    else if (m <= 45) w = 1.02;
    else if (m <= 60) w = 1.16;
    else if (m <= 75) w = 1.1;
    else if (m <= 88) w = 0.86;
    else w = 0.74;
    weights.push(w);
  }
  return weights;
})();

function runMonteCarlo(params: {
  runs: number;
  seed: number;
  lambdaHome: number;
  lambdaAway: number;
  tempoFactor: number;
}) {
  const { runs, seed, lambdaHome, lambdaAway } = params;
  const tempoFactor = clamp(params.tempoFactor, 0.7, 1.4);
  const rand = mulberry32(seed);

  const curveSum = MINUTE_CURVE.reduce((a, b) => a + b, 0);
  const lhPerMinute = (lambdaHome * tempoFactor) / curveSum;
  const laPerMinute = (lambdaAway * tempoFactor) / curveSum;

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let btts = 0;
  let htOver05 = 0;
  let lateGoal = 0;
  let totalGoalsSum = 0;
  let homeGoalsSum = 0;
  let awayGoalsSum = 0;
  let firstGoalEarly = 0;
  let htDraw = 0;
  let winByTwo = 0;
  let goalsAfter70 = 0;
  const scoreCounts = new Map<string, number>();
  const totals: number[] = [];

  for (let run = 0; run < runs; run++) {
    let hg = 0;
    let ag = 0;
    let htHome = 0;
    let htAway = 0;
    let firstGoalMinute = -1;
    let late = 0;
    let firstHalf = 0;

    for (let minute = 1; minute <= 90; minute++) {
      const curve = MINUTE_CURVE[minute - 1];
      let homeMult = 1;
      let awayMult = 1;

      const diff = hg - ag;
      if (minute > 45) {
        if (diff > 0) {
          homeMult *= 0.87; // l'équipe qui mène protège son avance
          awayMult *= 1.16; // l'équipe qui est menée monte en avant
        } else if (diff < 0) {
          awayMult *= 0.87;
          homeMult *= 1.16;
        } else {
          homeMult *= 1.06;
          awayMult *= 1.06;
        }
      }
      if (minute > 70) {
        homeMult *= 1.1;
        awayMult *= 1.1;
      }
      if (minute > 84) {
        homeMult *= 1.12;
        awayMult *= 1.12;
      }
      if (minute <= 12) {
        homeMult *= 0.9;
        awayMult *= 0.9;
      }

      const pHome = 1 - Math.exp(-lhPerMinute * curve * homeMult);
      const pAway = 1 - Math.exp(-laPerMinute * curve * awayMult);

      if (rand() < pHome) {
        hg += 1;
        if (firstGoalMinute < 0) firstGoalMinute = minute;
        if (minute >= 70) late += 1;
        if (minute > 45) goalsAfter70 += 1;
      }
      if (rand() < pAway) {
        ag += 1;
        if (firstGoalMinute < 0) firstGoalMinute = minute;
        if (minute >= 70) late += 1;
        if (minute > 45) goalsAfter70 += 1;
      }

      if (minute === 45) {
        htHome = hg;
        htAway = ag;
        firstHalf = hg + ag;
      }
    }

    // Arrêt de jeu : quelques minutes de temps additionnel
    const added = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < added; k++) {
      const pHome = 1 - Math.exp(-lhPerMinute * 0.9);
      const pAway = 1 - Math.exp(-laPerMinute * 0.9);
      if (rand() < pHome) {
        hg += 1;
        if (firstGoalMinute < 0) firstGoalMinute = 91;
        if (91 >= 70) late += 1;
      }
      if (rand() < pAway) {
        ag += 1;
        if (firstGoalMinute < 0) firstGoalMinute = 91;
        if (91 >= 70) late += 1;
      }
    }

    const total = hg + ag;
    totalGoalsSum += total;
    homeGoalsSum += hg;
    awayGoalsSum += ag;
    totals.push(total);

    if (hg > ag) homeWins += 1;
    else if (hg === ag) draws += 1;
    else awayWins += 1;

    if (total >= 2) over15 += 1;
    if (total >= 3) over25 += 1;
    if (total >= 4) over35 += 1;
    if (hg >= 1 && ag >= 1) btts += 1;
    if (firstHalf >= 1) htOver05 += 1;
    if (htHome === htAway) htDraw += 1;
    if (late > 0) lateGoal += 1;
    if (Math.abs(hg - ag) >= 2) winByTwo += 1;
    if (firstGoalMinute > 0 && firstGoalMinute <= 15) firstGoalEarly += 1;

    const key = `${hg}-${ag}`;
    scoreCounts.set(key, (scoreCounts.get(key) || 0) + 1);
  }

  const sortedTotals = totals.slice().sort((a, b) => a - b);
  const percentile = (p: number) => sortedTotals[clamp(Math.floor(p * (sortedTotals.length - 1)), 0, sortedTotals.length - 1)] || 0;

  const topScores = Array.from(scoreCounts.entries())
    .map(([key, count]) => {
      const parts = key.split('-');
      return { h: Number(parts[0]), a: Number(parts[1]), p: round(count / runs, 4) };
    })
    .sort((x, y) => y.p - x.p)
    .slice(0, 6);

  return {
    runs,
    seed,
    home: homeWins / runs,
    draw: draws / runs,
    away: awayWins / runs,
    over15: over15 / runs,
    over25: over25 / runs,
    over35: over35 / runs,
    btts: btts / runs,
    firstHalf: { over05: htOver05 / runs, averageGoals: 0 },
    lateGoalProbability: lateGoal / runs,
    expectedGoals: { home: homeGoalsSum / runs, away: awayGoalsSum / runs, total: totalGoalsSum / runs },
    goalRange: { low: percentile(0.05), high: percentile(0.95), mean: totalGoalsSum / runs },
    topScores,
    scenarios: [
      { label: "Ouverture rapide (but ≤ 15')", probability: firstGoalEarly / runs },
      { label: 'Match nul à la pause', probability: htDraw / runs },
      { label: 'Rupture après la 70e minute', probability: lateGoal / runs },
      { label: 'Écart de 2 buts ou plus', probability: winByTwo / runs },
      { label: 'Les deux équipes marquent', probability: btts / runs },
      { label: 'Plus de 2,5 buts', probability: over25 / runs },
    ],
    _htGoalsSum: 0,
    _goalsAfter70: goalsAfter70 / runs,
  };
}

/* ------------------------------------------------------------------ */
/* Assemblage principal                                                */
/* ------------------------------------------------------------------ */

export function runQuantitativeAnalyst(input: AnalystInput): AnalystReport {
  const kickoffIso = input.kickoffIso || new Date().toISOString();
  const { home, away, league } = input;

  /* --- Module 02 : base de référence du championnat ------------------- */
  const xgRows = league.xgRows || [];
  const leagueAvgXg = useAvg(xgRows.map(r => (r.xg || 0) / Math.max(1, r.played)), 1.35);
  const leagueAvgXga = useAvg(xgRows.map(r => (r.xgConceded || 0) / Math.max(1, r.played)), leagueAvgXg);
  const leagueAvgGoals = useAvg(
    (league.rowsAll || []).map(r => goalsFor(r) / Math.max(1, r.played)),
    1.45
  );
  const leagueAvgGoalsAgainst = useAvg(
    (league.rowsAll || []).map(r => goalsAgainst(r) / Math.max(1, r.played)),
    leagueAvgGoals
  );
  const leagueHomeGoals = useAvg(
    (league.rowsHome || []).map(r => goalsFor(r) / Math.max(1, r.played)),
    leagueAvgGoals * 1.14
  );
  const leagueAwayGoals = useAvg(
    (league.rowsAway || []).map(r => goalsFor(r) / Math.max(1, r.played)),
    leagueAvgGoals * 0.86
  );
  const leagueHomeAgainst = useAvg(
    (league.rowsHome || []).map(r => goalsAgainst(r) / Math.max(1, r.played)),
    leagueAvgGoalsAgainst * 0.94
  );
  const leagueAwayAgainst = useAvg(
    (league.rowsAway || []).map(r => goalsAgainst(r) / Math.max(1, r.played)),
    leagueAvgGoalsAgainst * 1.06
  );
  // Avantage domicile spécifique à la ligue
  const leagueHomeAdvantage = clamp(leagueHomeGoals / Math.max(0.2, leagueAwayGoals), 0.95, 1.45);

  const strengthMap = opponentStrengthMap(league);

  /* --- Module 02 : forme ajustée adversaires (décroissance exponentielle) */
  const formHome = aggregateForm(home, strengthMap, kickoffIso);
  const formAway = aggregateForm(away, strengthMap, kickoffIso);

  const homeSeasonAttack = (home.xgRow?.xg || 0) / Math.max(1, home.xgRow?.played || home.tableAll?.played || 1);
  const homeSeasonDefence = (home.xgRow?.xgConceded || 0) / Math.max(1, home.xgRow?.played || home.tableAll?.played || 1);
  const awaySeasonAttack = (away.xgRow?.xg || 0) / Math.max(1, away.xgRow?.played || away.tableAll?.played || 1);
  const awaySeasonDefence = (away.xgRow?.xgConceded || 0) / Math.max(1, away.xgRow?.played || away.tableAll?.played || 1);

  const homeSplitAttack = goalsFor(home.tableHome) / Math.max(1, home.tableHome?.played || 1);
  const homeSplitDefence = goalsAgainst(home.tableHome) / Math.max(1, home.tableHome?.played || 1);
  const awaySplitAttack = goalsFor(away.tableAway) / Math.max(1, away.tableAway?.played || 1);
  const awaySplitDefence = goalsAgainst(away.tableAway) / Math.max(1, away.tableAway?.played || 1);

  const relSeasonAttackHome = homeSeasonAttack > 0 ? clamp(homeSeasonAttack / leagueAvgXg, 0.35, 2.6) : 1;
  const relSeasonDefHome = homeSeasonDefence > 0 ? clamp(homeSeasonDefence / leagueAvgXga, 0.35, 2.6) : 1;
  const relSeasonAttackAway = awaySeasonAttack > 0 ? clamp(awaySeasonAttack / leagueAvgXg, 0.35, 2.6) : 1;
  const relSeasonDefAway = awaySeasonDefence > 0 ? clamp(awaySeasonDefence / leagueAvgXga, 0.35, 2.6) : 1;

  const relFormAttackHome = formHome.matches ? clamp(formHome.attack / leagueAvgGoals, 0.35, 2.6) : 1;
  const relFormDefHome = formHome.matches ? clamp(formHome.defence / leagueAvgGoalsAgainst, 0.35, 2.6) : 1;
  const relFormAttackAway = formAway.matches ? clamp(formAway.attack / leagueAvgGoals, 0.35, 2.6) : 1;
  const relFormDefAway = formAway.matches ? clamp(formAway.defence / leagueAvgGoalsAgainst, 0.35, 2.6) : 1;

  const relSplitAttackHome = homeSplitAttack > 0 ? clamp(homeSplitAttack / leagueHomeGoals, 0.35, 2.6) : 1;
  const relSplitDefHome = homeSplitDefence > 0 ? clamp(homeSplitDefence / leagueHomeAgainst, 0.35, 2.6) : 1;
  const relSplitAttackAway = awaySplitAttack > 0 ? clamp(awaySplitAttack / leagueAwayGoals, 0.35, 2.6) : 1;
  const relSplitDefAway = awaySplitDefence > 0 ? clamp(awaySplitDefence / leagueAwayAgainst, 0.35, 2.6) : 1;

  const attackHome = 0.42 * relSeasonAttackHome + 0.33 * relFormAttackHome + 0.25 * relSplitAttackHome;
  const defenceHome = 0.42 * relSeasonDefHome + 0.33 * relFormDefHome + 0.25 * relSplitDefHome;
  const attackAway = 0.42 * relSeasonAttackAway + 0.33 * relFormAttackAway + 0.25 * relSplitAttackAway;
  const defenceAway = 0.42 * relSeasonDefAway + 0.33 * relFormDefAway + 0.25 * relSplitDefAway;

  let lambdaHome = leagueAvgXg * Math.sqrt(Math.max(0.05, attackHome) * Math.max(0.05, defenceAway)) * leagueHomeAdvantage;
  let lambdaAway = leagueAvgXg * Math.sqrt(Math.max(0.05, attackAway) * Math.max(0.05, defenceHome));

  // Ancrage sur le modèle amont lorsque les données)xG sont insuffisantes
  const dataRich = Boolean(home.xgRow?.played && away.xgRow?.played);
  const anchor = dataRich ? 0.72 : 0.35;
  lambdaHome = lambdaHome * anchor + input.baseLambdas.home * (1 - anchor);
  lambdaAway = lambdaAway * anchor + input.baseLambdas.away * (1 - anchor);

  /* --- Module 03 : npxG, finition, gardiens --------------------------- */
  const homeGoalsPerMatch = goalsFor(home.tableAll) / Math.max(1, home.tableAll?.played || 1);
  const awayGoalsPerMatch = goalsFor(away.tableAll) / Math.max(1, away.tableAll?.played || 1);
  const finishingHome = buildFinishingProfile(home, home.tableAll?.played || 1, homeGoalsPerMatch || 1.2);
  const finishingAway = buildFinishingProfile(away, away.tableAll?.played || 1, awayGoalsPerMatch || 1.2);
  const gkHome = goalkeeperProfile(home);
  const gkAway = goalkeeperProfile(away);

  // FinITION : surperformance / sous-performance pondérée (shrinkage)
  const finishingAdjHome = 1 + clamp((finishingHome.finishingRatio - 1) * 0.35, -0.16, 0.18);
  const finishingAdjAway = 1 + clamp((finishingAway.finishingRatio - 1) * 0.35, -0.16, 0.18);
  lambdaHome *= finishingAdjHome;
  lambdaAway *= finishingAdjAway;

  // Gardien : la qualité du gardien adverse réduit les buts attendus
  lambdaHome *= 1 + (1 - gkAway.factor);
  lambdaAway *= 1 + (1 - gkHome.factor);

  // Coups de pied arrêtés : un bloc qui en concède beaucoup nous offre des occasions
  const homeSetPieceEdge = clamp((finishingAway.setPieceGoalsConceded - finishingHome.setPieceGoalsConceded) * 0.012, -0.03, 0.045);
  const awaySetPieceEdge = clamp((finishingHome.setPieceGoalsConceded - finishingAway.setPieceGoalsConceded) * 0.012, -0.03, 0.045);
  lambdaHome *= 1 + homeSetPieceEdge;
  lambdaAway *= 1 + awaySetPieceEdge;

  // Grandes occasions : volume et conversion
  const bigChanceHome = clamp((finishingHome.bigChances - 2.2) * 0.02, -0.03, 0.05);
  const bigChanceAway = clamp((finishingAway.bigChances - 2.2) * 0.02, -0.03, 0.05);
  lambdaHome *= 1 + bigChanceHome;
  lambdaAway *= 1 + bigChanceAway;

  /* --- Module 04 : absences & onze officiel --------------------------- */
  const absencesHome = analyseAbsences(home);
  const absencesAway = analyseAbsences(away);
  lambdaHome *= 1 - absencesHome.attackImpact;
  lambdaAway *= 1 - absencesAway.attackImpact;
  lambdaHome *= 1 + absencesAway.defenceImpact;
  lambdaAway *= 1 + absencesHome.defenceImpact;

  const lineupHome = lineupStrength(home.lineup, home.squad || []);
  const lineupAway = lineupStrength(away.lineup, away.squad || []);
  if (lineupHome && lineupHome.rotation !== 1) {
    const adj = clamp(1 + (lineupHome.rotation - 1) * 0.35, 0.9, 1.1);
    lambdaHome *= adj;
  }
  if (lineupAway && lineupAway.rotation !== 1) {
    const adj = clamp(1 + (lineupAway.rotation - 1) * 0.35, 0.9, 1.1);
    lambdaAway *= adj;
  }

  /* --- Module 05 : confrontation tactique ----------------------------- */
  const tacticsHome = buildTacticalProfile(home);
  const tacticsAway = buildTacticalProfile(away);
  const matchup = tacticalMatchup(tacticsHome, tacticsAway);
  const totalBeforeTactics = lambdaHome + lambdaAway;
  const totalAfterTactics = totalBeforeTactics * matchup.tempoFactor;
  const tempoRatio = totalAfterTactics / Math.max(0.01, totalBeforeTactics);
  lambdaHome *= tempoRatio * (1 + matchup.homeAdj);
  lambdaAway *= tempoRatio * (1 + matchup.awayAdj);

  /* --- Module 07 : calendrier, enjeux, arbitre, météo ------------------ */
  const calendarHome = analyseCalendar(home, kickoffIso, home.recentMatches || []);
  const calendarAway = analyseCalendar(away, kickoffIso, away.recentMatches || []);
  const fatigueHome = clamp(1 - calendarHome.fatigue * 0.16, 0.9, 1.06);
  const fatigueAway = clamp(1 - calendarAway.fatigue * 0.16, 0.9, 1.06);
  lambdaHome *= fatigueHome;
  lambdaAway *= fatigueAway;

  const stakesHome = analyseStakes(home, league.legend || []);
  const stakesAway = analyseStakes(away, league.legend || []);
  lambdaHome *= stakesHome.factor;
  lambdaAway *= stakesAway.factor;

  const referee = input.referee || null;
  const yellowPerMatch = typeof referee?.yellowPerMatch === 'number' ? referee.yellowPerMatch : null;
  const penaltiesPerMatch = typeof referee?.penaltiesPerMatch === 'number' ? referee.penaltiesPerMatch : null;
  const foulsPerMatch = typeof referee?.foulsPerMatch === 'number' ? referee.foulsPerMatch : null;
  let refereeEffect = 1;
  const refereeNotes: string[] = [];
  if (yellowPerMatch !== null) {
    if (yellowPerMatch >= 4.6) {
      refereeEffect *= 0.98; // plus de coupures de jeu : moins de jeu fluide
      refereeNotes.push(`arbitre sévère (${round(yellowPerMatch, 1)} cartons/match) : jeu fluide en baisse, volatilité disciplinaire accrue`);
    } else {
      refereeNotes.push(`arbitre mesuré (${round(yellowPerMatch, 1)} cartons/match)`);
    }
  }
  if (penaltiesPerMatch !== null) {
    // Les penalties représentent ~16 % des buts : on n'applique l'effet qu'à cette part
    const penFactor = clamp(penaltiesPerMatch / 0.3, 0.7, 1.7);
    refereeEffect *= 1 + (penFactor - 1) * 0.16;
    refereeNotes.push(`${round(penaltiesPerMatch, 2)} penalty(s) par match (moyenne ≈ 0,30) : part penalty ajustée (×${round(penFactor, 2)})`);
  }
  if (foulsPerMatch !== null && foulsPerMatch >= 24) {
    refereeEffect *= 1.01;
    refereeNotes.push(`${round(foulsPerMatch, 1)} fautes par match : légèrement plus de coups de pied arrêtés`);
  }

  const weather = input.weather || null;
  const temperature = typeof weather?.temperature === 'number' ? weather.temperature : null;
  const windSpeed = typeof weather?.windSpeed === 'number' ? weather.windSpeed : null;
  const precipitation = typeof weather?.precipitation === 'number' ? weather.precipitation : null;
  let weatherEffect = 1;
  const weatherNotes: string[] = [];
  if (temperature !== null) {
    if (temperature <= 3) {
      weatherEffect *= 0.965;
      weatherNotes.push(`froid (${round(temperature, 0)} °C) : rythme et volume en baisse`);
    } else if (temperature >= 30) {
      weatherEffect *= 0.975;
      weatherNotes.push(`chaleur (${round(temperature, 0)} °C) : fatigue plus rapide`);
    } else {
      weatherNotes.push(`${round(temperature, 0)} °C : conditions neutres`);
    }
  }
  if (windSpeed !== null && windSpeed >= 28) {
    weatherEffect *= 0.985;
    weatherNotes.push(`vent fort (${round(windSpeed, 0)} km/h) : ballons longs moins fiables`);
  }
  if (precipitation !== null && precipitation > 0) {
    weatherEffect *= 0.975;
    weatherNotes.push('pluie : précision en baisse, plus d’erreurs');
  }

  lambdaHome = clamp(lambdaHome * refereeEffect * weatherEffect, 0.22, 3.9);
  lambdaAway = clamp(lambdaAway * refereeEffect * weatherEffect, 0.2, 3.9);

  /* --- Module 01 : estimation de ρ ------------------------------------ */
  const rhoSamplePool = [
    ...(home.recentMatches || []).slice(0, 20),
    ...(away.recentMatches || []).slice(0, 20),
  ];
  const rhoFit = estimateRho(rhoSamplePool, lambdaHome, lambdaAway);
  // Stabilisation : l'estimation est pondérée avec la valeur de référence du championnat
  const rhoBlend = rhoFit.samples >= 40 ? 0.75 : rhoFit.samples >= 16 ? 0.5 : 0;
  const rhoBase = rhoBlend > 0 ? rhoFit.rho * rhoBlend + RHO_PRIOR * (1 - rhoBlend) : RHO_PRIOR;
  const rho = clamp(rhoBase + matchup.rhoAdjustment, -0.22, 0.22);

  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, rho);
  const probs = matrixProbabilities(matrix, lambdaHome, lambdaAway);

  const lambdaTotal = lambdaHome + lambdaAway;
  const overK = (lambda: number, threshold: number) => {
    let cdf = 0;
    for (let k = 0; k <= threshold; k++) cdf += poissonPmf(k, lambda);
    return Math.max(0, Math.min(1, 1 - cdf));
  };
  const lH1 = lambdaTotal * 0.44;
  const lH2 = lambdaTotal * 0.56;
  const noGoalProb = Math.exp(-lambdaTotal);

  const modelBundle: AnalystReport['model'] = {
    btts: round(probs.btts, 4),
    over15: round(probs.over15, 4),
    over25: round(probs.over25, 4),
    over35: round(probs.over35, 4),
    noGoal: round(noGoalProb, 4),
    firstHome: round(lambdaTotal > 0 ? (1 - noGoalProb) * (lambdaHome / lambdaTotal) : 0, 4),
    firstAway: round(lambdaTotal > 0 ? (1 - noGoalProb) * (lambdaAway / lambdaTotal) : 0, 4),
    firstHalf: {
      over05: round(probs.firstHalfOver05, 4),
      over15: round(overK(lH1, 1), 4),
      over25: round(overK(lH1, 2), 4),
    },
    secondHalf: {
      over05: round(probs.secondHalfOver05, 4),
      over15: round(overK(lH2, 1), 4),
      over25: round(overK(lH2, 2), 4),
    },
    topScores: probs.scores.slice(0, 6),
  };

  /* --- Module 06 : calibration marché --------------------------------- */
  const market = extractMarket(input.market);
  const completeness = computeCompleteness(home, away, league, input);
  const modelWeight = clamp(0.78 * (0.72 + 0.4 * completeness), 0.55, 0.86);

  const pureModel = {
    home: probs.home,
    draw: probs.draw,
    away: probs.away,
    over25: probs.over25,
  };

  let calibrated = { ...pureModel };
  let devigged = { home: 0, draw: 0, away: 0, over25: null as number | null };
  let edges = { home: 0, draw: 0, away: 0, over25: null as number | null };
  let value = { pick: '', label: 'Aucune valeur nette détectée', edge: 0 };
  let method = 'aucun marché';
  let overround = 0;

  if (market) {
    method = market.method;
    overround = market.overround;
    devigged = {
      home: market.probs.home,
      draw: market.probs.draw,
      away: market.probs.away,
      over25: market.over25,
    };
    calibrated = {
      home: modelWeight * pureModel.home + (1 - modelWeight) * market.probs.home,
      draw: modelWeight * pureModel.draw + (1 - modelWeight) * market.probs.draw,
      away: modelWeight * pureModel.away + (1 - modelWeight) * market.probs.away,
      over25:
        market.over25 !== null
          ? modelWeight * pureModel.over25 + (1 - modelWeight) * market.over25
          : pureModel.over25,
    };
    edges = {
      home: calibrated.home - market.probs.home,
      draw: calibrated.draw - market.probs.draw,
      away: calibrated.away - market.probs.away,
      over25: market.over25 !== null ? calibrated.over25 - market.over25 : null,
    };

    const ranked = [
      { key: 'home', label: `Victoire ${home.name}`, edge: edges.home },
      { key: 'draw', label: 'Match nul', edge: edges.draw },
      { key: 'away', label: `Victoire ${away.name}`, edge: edges.away },
    ].sort((a, b) => b.edge - a.edge);
    const best = ranked[0];
    if (best.edge >= 0.03) {
      value = { pick: best.key, label: `Valeur détectée : ${best.label}`, edge: round(best.edge, 4) };
    } else if (best.edge <= -0.05) {
      value = { pick: best.key, label: `Le marché est plus optimiste que le modèle (${best.label})`, edge: round(best.edge, 4) };
    }
  }

  /* --- Module 08 : Monte-Carlo ---------------------------------------- */
  const seed = hashString(`${input.matchId || ''}|${kickoffIso}|${home.teamId}-${away.teamId}`);
  const mc = runMonteCarlo({
    runs: 10_000,
    seed,
    lambdaHome,
    lambdaAway,
    tempoFactor: matchup.tempoFactor,
  });

  const sim = {
    runs: mc.runs,
    seed: mc.seed,
    home: mc.home,
    draw: mc.draw,
    away: mc.away,
    over15: mc.over15,
    over25: mc.over25,
    over35: mc.over35,
    btts: mc.btts,
    expectedGoals: {
      home: round(mc.expectedGoals.home, 2),
      away: round(mc.expectedGoals.away, 2),
      total: round(mc.expectedGoals.total, 2),
    },
    goalRange: {
      low: mc.goalRange.low,
      high: mc.goalRange.high,
      mean: round(mc.goalRange.mean, 2),
    },
    firstHalf: { over05: round(mc.firstHalf.over05, 4), averageGoals: round(probs.firstHalfGoals, 2) },
    lateGoalProbability: round(mc.lateGoalProbability, 4),
    topScores: mc.topScores,
    scenarios: mc.scenarios.map(s => ({ label: s.label, probability: round(s.probability, 4) })),
  };

  /* --- Confiance ------------------------------------------------------- */
  const simRanked = [
    { key: 'home', p: sim.home },
    { key: 'draw', p: sim.draw },
    { key: 'away', p: sim.away },
  ].sort((a, b) => b.p - a.p);
  const separation = clamp((simRanked[0].p - simRanked[1].p) / 0.3, 0, 1);
  const maxEdge = market ? Math.max(Math.abs(edges.home), Math.abs(edges.draw), Math.abs(edges.away)) : 0;
  const agreement = clamp(1 - maxEdge / 0.15, 0, 1);
  const confidenceScore = Math.round(100 * (0.5 * separation + 0.32 * completeness + 0.18 * agreement));
  const confidenceLabel = confidenceScore >= 75 ? 'Très élevée' : confidenceScore >= 60 ? 'Élevée' : confidenceScore >= 45 ? 'Modérée' : 'Faible';

  /* --- Synthèse -------------------------------------------------------- */
  const synthesis = buildSynthesis({
    home,
    away,
    lambdaHome,
    lambdaAway,
    rho,
    rhoSamples: rhoFit.samples,
    pureModel,
    calibrated,
    market,
    edges,
    value,
    tacticsHome,
    tacticsAway,
    matchup,
    absencesHome,
    absencesAway,
    calendarHome,
    calendarAway,
    sosHome: formHome.sos,
    sosAway: formAway.sos,
    stakesHome,
    stakesAway,
    gkHome,
    gkAway,
    finishingHome,
    finishingAway,
    sim,
    confidenceScore,
    confidenceLabel,
    completeness,
  });

  /* --- Cartes de modules ------------------------------------------------ */
  const modules: AnalystModuleCard[] = [
    {
      id: 1,
      title: 'Dixon-Coles & décroissance exponentielle',
      status: rhoFit.samples >= 30 ? 'ok' : 'partial',
      summary:
        `ρ = ${rho >= 0 ? '+' : ''}${round(rho, 3)} (${rhoFit.samples} matchs ajustables), ` +
        `forme pondérée e^(−ξΔt) avec ξ = ${XI_DECAY} (demi-vie ${Math.round(Math.log(2) / XI_DECAY)} j).`,
      metrics: [
        { label: 'ρ (corrélation)', value: `${rho >= 0 ? '+' : ''}${round(rho, 3)}` },
        { label: 'Demi-vie forme', value: `${Math.round(Math.log(2) / XI_DECAY)} j` },
        { label: 'λ ajustés', value: `${round(lambdaHome, 2)} – ${round(lambdaAway, 2)}` },
      ],
    },
    {
      id: 2,
      title: 'Force du calendrier & splits terrain',
      status: formHome.matches >= 3 && formAway.matches >= 3 ? 'ok' : 'partial',
      summary:
        `Adversaires de force moyenne ${Math.round(formHome.sos * 100)} % / ${Math.round(formAway.sos * 100)} %. ` +
        `Avantage domicile du championnat : ×${round(leagueHomeAdvantage, 2)}.`,
      metrics: [
        { label: 'Force adv. (dom.)', value: `${Math.round(formHome.sos * 100)} %` },
        { label: 'Force adv. (ext.)', value: `${Math.round(formAway.sos * 100)} %` },
        { label: 'Avantage domicile', value: `×${round(leagueHomeAdvantage, 2)}` },
      ],
    },
    {
      id: 3,
      title: 'xG hors penalties, coups de pied arrêtés & gardiens',
      status: finishingHome.xg > 0 ? 'ok' : 'unavailable',
      summary:
        `xG ${finishingHome.xg} / ${finishingAway.xg} · npxG ${finishingHome.npxg} / ${finishingAway.npxg}. ` +
        `Coups de pied arrêtés : ${finishingHome.setPieceGoals} buts marqués / ${finishingHome.setPieceGoalsConceded} encaissés (dom.) contre ${finishingAway.setPieceGoals} / ${finishingAway.setPieceGoalsConceded} (ext.). ` +
        `Buts évités gardiens : ${gkHome.goalsPrevented ?? '—'} (dom.) / ${gkAway.goalsPrevented ?? '—'} (ext.).`,
      metrics: [
        { label: 'npxG (dom./ext.)', value: `${finishingHome.npxg} / ${finishingAway.npxg}` },
        { label: 'Pen. obtenus (m.)', value: `${round(finishingHome.penaltiesWon, 2)} / ${round(finishingAway.penaltiesWon, 2)}` },
        { label: 'Gains Keeper', value: `${gkHome.goalsPrevented ?? '—'} / ${gkAway.goalsPrevented ?? '—'}` },
      ],
    },
    {
      id: 4,
      title: 'Effectifs, absences & onze officiel',
      status: lineupHome || lineupAway ? 'ok' : absencesHome.items.length || absencesAway.items.length ? 'ok' : 'partial',
      summary:
        `Impact absences : −${Math.round(absencesHome.attackImpact * 100)} % / −${Math.round(absencesAway.attackImpact * 100)} % en attaque. ` +
        `${lineupHome || lineupAway ? 'Onze officiel publié : pondération directe du onze titulaire.' : 'Onze officiel non encore publié : modèle d\'effectif utilisé.'}`,
      metrics: [
        { label: 'Absences critiques', value: `${absencesHome.keyPlayers} / ${absencesAway.keyPlayers}` },
        { label: 'Longues absences', value: `${absencesHome.longTerm} / ${absencesAway.longTerm}` },
        { label: 'Onze officiel', value: lineupHome || lineupAway ? 'Oui' : 'Non' },
      ],
    },
    {
      id: 5,
      title: 'Confrontation tactique',
      status: 'ok',
      summary: `${tacticsHome.profile} contre ${tacticsAway.profile}. ${matchup.label}.`,
      metrics: [
        { label: 'Tempo', value: `${tacticsHome.tempo} / ${tacticsAway.tempo}` },
        { label: 'Facteur de tempo', value: `×${matchup.tempoFactor}` },
        { label: 'Ajustement ρ', value: `${matchup.rhoAdjustment >= 0 ? '+' : ''}${matchup.rhoAdjustment}` },
      ],
    },
    {
      id: 6,
      title: 'Calibration bayésienne vs marché',
      status: market ? 'ok' : 'unavailable',
      summary: market
        ? `Marge retirée (${method}) : ${Math.round(overround * 100 - 100)} % de surcote. Poids modèle ${Math.round(modelWeight * 100)} % / marché ${Math.round((1 - modelWeight) * 100)} %.`
        : 'Cotes indisponibles : modèle pur conservé (aucune calibration possible).',
      metrics: [
        { label: 'Poids modèle', value: `${Math.round(modelWeight * 100)} %` },
        { label: 'Écart max', value: `${Math.round(maxEdge * 1000) / 10} pts` },
        { label: 'Valeur', value: value.pick ? value.pick : 'aucune' },
      ],
    },
    {
      id: 7,
      title: 'Congestion 14 j, enjeux, arbitre & météo',
      status: 'ok',
      summary:
        `${calendarHome.matches14} match(s) en 14 j (dom.) / ${calendarAway.matches14} (ext.). ` +
        `${stakesHome.label} · ${stakesAway.label}.`,
      metrics: [
        { label: 'Fatigue (dom./ext.)', value: `${Math.round(calendarHome.fatigue * 100)} % / ${Math.round(calendarAway.fatigue * 100)} %` },
        { label: 'Effet arbitre', value: `×${round(refereeEffect, 3)}` },
        { label: 'Effet météo', value: `×${round(weatherEffect, 3)}` },
      ],
    },
    {
      id: 8,
      title: 'Monte-Carlo 10 000 itérations',
      status: 'ok',
      summary:
        `${sim.runs.toLocaleString('fr-FR')} simulations minute par minute (90' + arrêts, états de jeu dynamiques). ` +
        `Intervalle de buts 5-95 % : ${sim.goalRange.low} à ${sim.goalRange.high}.`,
      metrics: [
        { label: 'Victoire dom.', value: pctFr(sim.home) },
        { label: 'Nul', value: pctFr(sim.draw) },
        { label: 'Victoire ext.', value: pctFr(sim.away) },
      ],
    },
  ];

  return {
    version: '2.0',
    generatedAt: new Date().toISOString(),
    homeName: home.name,
    awayName: away.name,
    kickoffIso,
    confidence: {
      score: confidenceScore,
      label: confidenceLabel,
      completeness: round(completeness, 3),
      separation: round(separation, 3),
      agreement: round(agreement, 3),
    },
    lambdas: {
      home: round(lambdaHome, 2),
      away: round(lambdaAway, 2),
      total: round(lambdaHome + lambdaAway, 2),
      startHome: round(input.baseLambdas.home, 2),
      startAway: round(input.baseLambdas.away, 2),
    },
    model: modelBundle,
    dixonColes: {
      rho: round(rho, 4),
      prior: RHO_PRIOR,
      fitted: rhoFit.samples >= 16,
      samples: rhoFit.samples,
      note:
        rhoFit.samples >= 16
          ? `ρ estimé par moindres carrés sur ${rhoFit.samples} matchs à score bas (stabilisé avec la valeur de référence du championnat).`
          : `Échantillon insuffisant (${rhoFit.samples} matchs) : ρ recadré sur la valeur de référence du championnat.`,
    },
    timeDecay: {
      xi: XI_DECAY,
      halfLifeDays: Math.round(Math.log(2) / XI_DECAY),
      homeMatches: formHome.matches,
      awayMatches: formAway.matches,
      homeWeight: formHome.weighted,
      awayWeight: formAway.weighted,
      note:
        `Les ${formHome.matches} derniers matchs de ${home.name} et les ${formAway.matches} de ${away.name} sont pondérés par e^(−${XI_DECAY}Δt) : les plus récents pèsent ${round(
          Math.exp(-XI_DECAY * 7) * 100
        )} % contre ${round(Math.exp(-XI_DECAY * 90) * 100)} % pour un match vieux de 90 jours.`,
    },
    scheduleStrength: {
      home: {
        sos: formHome.sos,
        attack: formHome.attack,
        defence: formHome.defence,
        matches: formHome.matches,
        note: formHome.note,
      },
      away: {
        sos: formAway.sos,
        attack: formAway.attack,
        defence: formAway.defence,
        matches: formAway.matches,
        note: formAway.note,
      },
      splits: {
        homeAttack: round(homeSplitAttack, 2),
        homeDefence: round(homeSplitDefence, 2),
        awayAttack: round(awaySplitAttack, 2),
        awayDefence: round(awaySplitDefence, 2),
        leagueHomeAdvantage: round(leagueHomeAdvantage, 3),
        note:
          `Splits de l'équipe à domicile : ${round(homeSplitAttack, 2)} buts marqués / ${round(homeSplitDefence, 2)} encaissés par match. ` +
          `Équipe à l'extérieur : ${round(awaySplitAttack, 2)} / ${round(awaySplitDefence, 2)}. ` +
          `Moyennes du championnat : ${round(leagueHomeGoals, 2)} buts à domicile contre ${round(leagueAwayGoals, 2)} à l'extérieur (×${round(leagueHomeAdvantage, 2)}).`,
      },
    },
    finishing: {
      home: finishingHome,
      away: finishingAway,
      goalkeepers: { home: gkHome, away: gkAway },
    },
    absences: {
      home: absencesHome,
      away: absencesAway,
      officialLineup: {
        available: Boolean(lineupHome || lineupAway),
        home: lineupHome || undefined,
        away: lineupAway || undefined,
        note: lineupHome || lineupAway
          ? 'Compositions officielles intégrées : la force réelle du onze remplace l\'estimation d\'effectif.'
          : 'Compositions officielles non encore publiées (attendue environ 1 h avant le coup d\'envoi) : estimation d\'effectif utilisée.',
      },
    },
    tactics: {
      home: tacticsHome,
      away: tacticsAway,
      matchup: {
        label: matchup.label,
        tempoFactor: matchup.tempoFactor,
        rhoAdjustment: matchup.rhoAdjustment,
        effects: matchup.effects,
        note: matchup.note,
      },
    },
    market: {
      available: Boolean(market),
      method,
      overround: round(overround, 4),
      devigged: {
        home: round(devigged.home, 4),
        draw: round(devigged.draw, 4),
        away: round(devigged.away, 4),
        over25: devigged.over25 !== null ? round(devigged.over25, 4) : null,
      },
      pureModel: {
        home: round(pureModel.home, 4),
        draw: round(pureModel.draw, 4),
        away: round(pureModel.away, 4),
        over25: round(pureModel.over25, 4),
      },
      calibrated: {
        home: round(calibrated.home, 4),
        draw: round(calibrated.draw, 4),
        away: round(calibrated.away, 4),
        over25: round(calibrated.over25, 4),
      },
      weights: { model: round(modelWeight, 3), market: round(1 - modelWeight, 3) },
      edges: {
        home: round(edges.home, 4),
        draw: round(edges.draw, 4),
        away: round(edges.away, 4),
        over25: edges.over25 !== null ? round(edges.over25, 4) : null,
      },
      value,
      note: market
        ? `Marge bookmaker retirée par la méthode ${method} (surcharge ${Math.max(0, Math.round((overround - 1) * 1000) / 10)} %). ` +
          `Le modèle pur conserve ${Math.round(modelWeight * 100)} % de la décision finale, le marché ${Math.round((1 - modelWeight) * 100)} %.`
        : 'Aucune cote disponible : le modèle pur est conservé sans calibrage de marché.',
    },
    context: {
      home: calendarHome,
      away: calendarAway,
      stakes: {
        home: stakesHome.label,
        away: stakesAway.label,
        homeFactor: stakesHome.factor,
        awayFactor: stakesAway.factor,
        note: `Les enjeux de classement sont traduits en intensité : ×${stakesHome.factor} pour ${home.name}, ×${stakesAway.factor} pour ${away.name}.`,
      },
      referee: {
        name: String(referee?.name || 'Non désigné'),
        yellowPerMatch: yellowPerMatch !== null ? round(yellowPerMatch, 2) : null,
        penaltiesPerMatch: penaltiesPerMatch !== null ? round(penaltiesPerMatch, 2) : null,
        foulsPerMatch: foulsPerMatch !== null ? round(foulsPerMatch, 1) : null,
        effect: round(refereeEffect, 4),
        note: refereeNotes.length ? refereeNotes.join(' · ') : 'Profil d\'arbitre indisponible.',
      },
      weather: {
        temperature: temperature !== null ? round(temperature, 1) : null,
        wind: windSpeed !== null ? round(windSpeed, 1) : null,
        precipitation: precipitation !== null ? round(precipitation, 1) : null,
        effect: round(weatherEffect, 4),
        note: weatherNotes.length ? weatherNotes.join(' · ') : 'Conditions météo non renseignées.',
      },
    },
    simulation: sim,
    synthesis,
    modules,
  };
}

/* ------------------------------------------------------------------ */
/* Complétude des données & synthèse                                   */
/* ------------------------------------------------------------------ */

function useAvg(values: number[], fallback: number): number {
  const clean = values.filter(v => Number.isFinite(v) && v > 0);
  if (!clean.length) return fallback;
  return mean(clean);
}

function pctFr(v: number): string {
  return `${Math.round((Number.isFinite(v) ? v : 0) * 100)} %`;
}

function computeCompleteness(
  home: AnalystTeamInput,
  away: AnalystTeamInput,
  league: AnalystLeagueInput,
  input: AnalystInput
): number {
  let score = 0;
  let max = 0;

  const add = (weight: number, condition: boolean) => {
    max += weight;
    if (condition) score += weight;
  };

  add(0.22, Boolean(home.xgRow?.played && away.xgRow?.played));
  add(0.12, (home.recentMatches?.length || 0) >= 5 && (away.recentMatches?.length || 0) >= 5);
  add(0.1, Object.keys(home.stats || {}).length >= 8 && Object.keys(away.stats || {}).length >= 8);
  add(0.08, (league.rowsAll?.length || 0) >= 10);
  add(0.08, Boolean(home.tableHome && away.tableAway));
  add(0.1, Boolean(input.h2h && input.h2h.count >= 3));
  add(0.1, Boolean(home.lineup?.starters?.length || away.lineup?.starters?.length));
  add(0.08, Boolean(input.referee?.name));
  add(0.06, Boolean(input.weather));
  add(0.06, Boolean(input.market));

  return max > 0 ? clamp(score / max, 0, 1) : 0.5;
}

type SynthesisInput = {
  home: AnalystTeamInput;
  away: AnalystTeamInput;
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  rhoSamples: number;
  pureModel: { home: number; draw: number; away: number; over25: number };
  calibrated: { home: number; draw: number; away: number; over25: number };
  market: any;
  edges: { home: number; draw: number; away: number; over25: number | null };
  value: { pick: string; label: string; edge: number };
  tacticsHome: AnalystReport['tactics']['home'];
  tacticsAway: AnalystReport['tactics']['away'];
  matchup: AnalystReport['tactics']['matchup'];
  absencesHome: AbsenceAnalysis;
  absencesAway: AbsenceAnalysis;
  calendarHome: CalendarBlock;
  calendarAway: CalendarBlock;
  sosHome: number;
  sosAway: number;
  stakesHome: { label: string; factor: number };
  stakesAway: { label: string; factor: number };
  gkHome: AnalystReport['finishing']['goalkeepers']['home'];
  gkAway: AnalystReport['finishing']['goalkeepers']['home'];
  finishingHome: FinishingProfile;
  finishingAway: FinishingProfile;
  sim: AnalystReport['simulation'];
  confidenceScore: number;
  confidenceLabel: string;
  completeness: number;
};

function buildSynthesis(s: SynthesisInput): AnalystReport['synthesis'] {
  const outcomes = [
    { key: 'home', label: `victoire de ${s.home.name}`, p: s.calibrated.home },
    { key: 'draw', label: 'match nul', p: s.calibrated.draw },
    { key: 'away', label: `victoire de ${s.away.name}`, p: s.calibrated.away },
  ].sort((a, b) => b.p - a.p);

  const favourite = outcomes[0];
  const second = outcomes[1];
  const headline = `Le modèle retient ${favourite.label} (${pctFr(favourite.p)}) devant ${second.label} (${pctFr(second.p)}).`;

  const bullets: string[] = [];

  bullets.push(
    `Modèle bivarié de Dixon-Coles : λ = ${round(s.lambdaHome, 2)} / ${round(s.lambdaAway, 2)} buts attendus, ρ = ${s.rho >= 0 ? '+' : ''}${round(s.rho, 3)} (corrélation sur les scores serrés, ${s.rhoSamples} matchs).`
  );

  bullets.push(
    `Force du calendrier : ${s.home.name} a evolutionné face à des adversaires de force moyenne ${Math.round(
      s.sosHome * 100
    )} % et ${s.away.name} face à des adversaires de force moyenne ${Math.round(s.sosAway * 100)} %, ` +
      `soit une attaque ajustée à ${round(s.finishingHome.xg, 2)} xG par match (npxG ${s.finishingHome.npxg}) et ${round(
        s.finishingAway.xg,
        2
      )} xG (npxG ${s.finishingAway.npxg}).`
  );

  if (s.absencesHome.keyPlayers || s.absencesAway.keyPlayers) {
    bullets.push(
      `Effectif : ${s.absencesHome.keyPlayers} absence(s) critique(s) côté ${s.home.name} et ${s.absencesAway.keyPlayers} côté ${s.away.name}; ` +
        `les absences de longue durée sont déjà intégrées dans les xG de saison et ne sont donc pas comptées deux fois.`
    );
  } else {
    bullets.push(
      `Effectif : aucune absence critique détectée, ${s.absencesHome.longTerm + s.absencesAway.longTerm} absence(s) longue durée déjà intégrée(s) aux xG de saison.`
    );
  }

  bullets.push(
    `Tactique : ${s.tacticsHome.profile} (tempo ${s.tacticsHome.tempo}) contre ${s.tacticsAway.profile} (tempo ${s.tacticsAway.tempo}) — ${s.matchup.label.toLowerCase()}, facteur de tempo ×${s.matchup.tempoFactor}.`
  );

  bullets.push(
    `Contexte : ${s.calendarHome.matches14} match(s) en 14 jours pour ${s.home.name} (${s.calendarHome.matches7} en 7 jours) et ${s.calendarAway.matches14} pour ${s.away.name} (${s.calendarAway.matches7} en 7 jours). ${s.stakesHome.label} / ${s.stakesAway.label}.`
  );

  if (s.market) {
    bullets.push(
      `Marché : cotes retraitées (marge ${Math.round((s.market.overround - 1) * 1000) / 10} % retirée). ` +
        `Modèle pur ${pctFr(s.pureModel.home)} / ${pctFr(s.pureModel.draw)} / ${pctFr(s.pureModel.away)} contre marché ${pctFr(
          s.market.probs.home
        )} / ${pctFr(s.market.probs.draw)} / ${pctFr(s.market.probs.away)}.`
    );
    if (s.value.pick) {
      bullets.push(`${s.value.label} : écart de ${Math.round(Math.abs(s.value.edge) * 1000) / 10} points entre le modèle calibré et le marché.`);
    }
  }

  bullets.push(
    `Simulation : ${s.sim.runs.toLocaleString('fr-FR')} scénarios minute par minute donnent ${pctFr(s.sim.home)} / ${pctFr(
      s.sim.draw
    )} / ${pctFr(s.sim.away)}, un intervalle de buts de ${s.sim.goalRange.low} à ${s.sim.goalRange.high} et une probabilité de but après la 70e minute de ${pctFr(
      s.sim.lateGoalProbability
    )}.`
  );

  const text =
    `Les 8 modules d'analyse convergent vers une estimation de ${round(s.lambdaHome + s.lambdaAway, 2)} buts au total. ` +
    `La confiance de l'analyste est estimée à ${s.confidenceScore}/100 (${s.confidenceLabel.toLowerCase()}), ` +
    `avec ${Math.round(s.completeness * 100)} % de complétude des données disponibles. ` +
    `Il s'agit d'une estimation statistique, jamais d'une certitude.`;

  return {
    headline,
    verdict: `${favourite.label} · ${pctFr(favourite.p)} · confiance ${s.confidenceScore}/100`,
    bullets,
    text,
  };
}

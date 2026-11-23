/* ------------------------------------------------------------------ */
/* BACKTEST WALK-FORWARD & AJUSTEMENT DES PARAMÈTRES                   */
/* ------------------------------------------------------------------ */
/*
 * Le backtest rejoue le moteur sur des rencontres TERMINÉES, en ne
 * donnant à chaque match que l'information disponible AVANT le coup
 * d'envoi (classement cumulé, forme, xG de saison, absences, compositions,
 * cotes). C'est la seule façon de mesurer si les paramètres du modèle
 * (temperature, poids du marché, seuil de « valeur », confiance) sont
 * corrects — et de les ajuster sur des mesures plutôt que sur des
 * intuition.
 *
 * POLITIQUE DE FUITE TEMPORELLE (leakage) :
 *   - le classement, la forme et les xG sont reconstruits-match par match à
 *     partir des SEULEMENTS rencontres antérieures ;
 *   - les instantanés d'équipe (totaux de saison, statistiques de joueurs)
 *     sont EXCLUS de l'ajustement : ils sont courants au moment de la
 *     collecte etnous donneraient un avantage rétrospectif indu ;
 *   - les absences et les compositions CONFIRMÉES sont conservées : elles
 *     sont connues avant le coup d'envoi (annonce des compositions) ;
 *   - les cotes utilisées sont celles relevées avant le coup d'envoi.
 *
 * Les métriques produites :
 *   - log-loss multi-classes (3 issues) : qualité probabiliste ;
 *   - score de Brier multi-classes ;
 *   - accuracy ;
 *   - ROI sur les paris à « valeur » (edge au-delà du seuil) ;
 *   - courbe de calibration (probabilité annoncée vs fréquence observée) ;
 *   - régression logistique : probabilité MESURÉE que l'issue retenue
 *     par le modèle soit la bonne.
 */

import { devigThreeWayDecimal } from './devig';
import {
  runQuantitativeAnalyst,
  shrunkMean,
  shrunkRatio,
  type AnalystInput,
  type AnalystTableRow,
} from './analystEngine';
import { credibleInterval, poissonPmf } from './poissonModels';
import type { CalibrationParams, CalibrationMetrics, ConfidenceBin, OutcomeProbs } from './calibration';
import { applyCalibration } from './calibration';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type BacktestPlayer = {
  id: number;
  name: string;
  position?: string;
  rating?: number | null;
  goals?: number;
  assists?: number;
  marketValue?: number;
  minutes?: number;
  xg?: number;
  xa?: number;
};

export type BacktestTeamSnapshot = {
  id: number;
  name: string;
  /** Statistiques d'équipe (moyennes par match) utilisées par le moteur. */
  stats?: Record<string, number>;
  players?: BacktestPlayer[];
};

export type BacktestMatch = {
  id: string;
  date: string;
  league: string;
  homeId: number;
  homeName: string;
  awayId: number;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  homeXg: number | null;
  awayXg: number | null;
  htHome: number | null;
  htAway: number | null;
  /** xG de la première période (souvent indisponible). */
  htXgHome?: number | null;
  htXgAway?: number | null;
  homeShots: number | null;
  awayShots: number | null;
  homeXgot: number | null;
  awayXgot: number | null;
  odds: { home: number; draw: number; away: number } | null;
  provider: string | null;
  unavailableHome: number[];
  unavailableAway: number[];
  startersHome: number[];
  startersAway: number[];
  /** Compositions officielles publiées avant le coup d'envoi. */
  lineupConfirmedHome?: boolean;
  lineupConfirmedAway?: boolean;
  referee?: { yellowPerMatch?: number; yellowAverage?: number; foulsPerMatch?: number; foulsAverage?: number; penaltiesPerMatch?: number } | null;
  weather?: { temperature?: number; windSpeed?: number; precipitation?: number } | null;
  pitch?: { surface?: string } | null;
};

export type BacktestDataset = {
  league: string;
  period: string;
  teams: BacktestTeamSnapshot[];
  matches: BacktestMatch[];
};

export type BacktestSample = {
  matchId: string;
  date: string;
  outcome: 0 | 1 | 2;
  model: OutcomeProbs;
  market: OutcomeProbs | null;
  /** Probabilité du marché pour l'issue retenue par le modèle. */
  marketPick: number;
  naive: OutcomeProbs;
  separation: number;
  agreement: number;
  confidenceScore: number;
  homeGoals: number;
  awayGoals: number;
  odds: { home: number; draw: number; away: number } | null;
};

export type BacktestResult = {
  metrics: CalibrationMetrics;
  params: CalibrationParams;
  samples: BacktestSample[];
  calibrationCurve: { bin: string; predicted: number; observed: number; samples: number }[];
  edgeBuckets: {
    edge: string;
    min: number;
    max: number;
    samples: number;
    roi: number;
    hitRate: number;
  }[];
  notes: string[];
};

/* ------------------------------------------------------------------ */
/* Construction des entrées walk-forward                               */
/* ------------------------------------------------------------------ */

type TeamAggregate = {
  id: number;
  name: string;
  played: number;
  pts: number;
  goalsScored: number;
  goalsConceded: number;
  xg: number;
  xgConceded: number;
  homePlayed: number;
  homeGoals: number;
  homeConceded: number;
  awayPlayed: number;
  awayGoals: number;
  awayConceded: number;
};

function emptyAggregate(id: number, name: string): TeamAggregate {
  return {
    id,
    name,
    played: 0,
    pts: 0,
    goalsScored: 0,
    goalsConceded: 0,
    xg: 0,
    xgConceded: 0,
    homePlayed: 0,
    homeGoals: 0,
    homeConceded: 0,
    awayPlayed: 0,
    awayGoals: 0,
    awayConceded: 0,
  };
}

/**
 * Reconstruit l'état du championnat AVANT chaque match (cumulatif),
 * puis les entrées du moteur.
 */
export function buildWalkForwardInputs(
  dataset: BacktestDataset
): { inputs: AnalystInput[]; naive: OutcomeProbs[] } {
  const matches = dataset.matches.slice().sort((a, b) => a.date.localeCompare(b.date));
  const teamNames = new Map<number, string>();
  for (const m of matches) {
    teamNames.set(m.homeId, m.homeName);
    teamNames.set(m.awayId, m.awayName);
  }

  const aggregates = new Map<number, TeamAggregate>();
  teamNames.forEach((name, id) => aggregates.set(id, emptyAggregate(id, name)));
  const snapshots = new Map<number, BacktestTeamSnapshot>();
  for (const t of dataset.teams) snapshots.set(t.id, t);

  const inputs: AnalystInput[] = [];
  const naive: OutcomeProbs[] = [];

  const historyFor = (id: number) =>
    matches.filter(m => m.homeId === id || m.awayId === id);

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const history = matches.slice(0, i);

    // --- Moyennes de la league sur l'historique (rétrécies) -------------
    // Prior de 5 matchs fictifs : sans cela, un seul match à 3-0 ferait
    // exploser la moyenne de championnat et rendrait la référence
    // naïve inutilisable en début de saison.
    const leagueHomeGoals = shrunkMean(history.map(m => m.homeGoals), 1.45, 5);
    const leagueAwayGoals = shrunkMean(history.map(m => m.awayGoals), 1.15, 5);
    const leagueTeamGoals = (leagueHomeGoals + leagueAwayGoals) / 2;

    // --- Agrégats cumulés par équipe -----------------------------------
    for (const past of history) {
      const home = aggregates.get(past.homeId);
      const away = aggregates.get(past.awayId);
      if (home) {
        home.played += 1;
        home.goalsScored += past.homeGoals;
        home.goalsConceded += past.awayGoals;
        home.homePlayed += 1;
        home.homeGoals += past.homeGoals;
        home.homeConceded += past.awayGoals;
        home.xg += past.homeXg ?? 0;
        home.xgConceded += past.awayXg ?? 0;
        home.pts += past.homeGoals > past.awayGoals ? 3 : past.homeGoals === past.awayGoals ? 1 : 0;
      }
      if (away) {
        away.played += 1;
        away.goalsScored += past.awayGoals;
        away.goalsConceded += past.homeGoals;
        away.awayPlayed += 1;
        away.awayGoals += past.awayGoals;
        away.awayConceded += past.homeGoals;
        away.xg += past.awayXg ?? 0;
        away.xgConceded += past.homeXg ?? 0;
        away.pts += past.awayGoals > past.homeGoals ? 3 : past.awayGoals === past.homeGoals ? 1 : 0;
      }
    }

    // --- Lignes de tableau ---------------------------------------------
    const ranked = Array.from(aggregates.values())
      .filter(a => a.played > 0)
      .sort((a, b) => b.pts - a.pts || b.goalsScored - b.goalsConceded - (a.goalsScored - a.goalsConceded));
    const idxById = new Map<number, number>();
    ranked.forEach((a, index) => idxById.set(a.id, index + 1));

    const rowsAll: AnalystTableRow[] = ranked.map(a => ({
      id: a.id,
      name: a.name,
      played: a.played,
      pts: a.pts,
      idx: idxById.get(a.id) ?? null,
      goalsScored: a.goalsScored,
      goalsConceded: a.goalsConceded,
      xg: Number(a.xg.toFixed(2)),
      xgConceded: Number(a.xgConceded.toFixed(2)),
      xPoints: a.pts,
    }));
    const rowsHome: AnalystTableRow[] = ranked
      .filter(a => a.homePlayed > 0)
      .map(a => ({
        id: a.id,
        name: a.name,
        played: a.homePlayed,
        goalsScored: a.homeGoals,
        goalsConceded: a.homeConceded,
      }));
    const rowsAway: AnalystTableRow[] = ranked
      .filter(a => a.awayPlayed > 0)
      .map(a => ({
        id: a.id,
        name: a.name,
        played: a.awayPlayed,
        goalsScored: a.awayGoals,
        goalsConceded: a.awayConceded,
      }));

    // --- Équipes du match ----------------------------------------------
    const homeAgg = aggregates.get(match.homeId)!;
    const awayAgg = aggregates.get(match.awayId)!;
    const homeSnapshot = snapshots.get(match.homeId);
    const awaySnapshot = snapshots.get(match.awayId);

    const homeAttackRel =
      homeAgg.homePlayed > 0 && leagueTeamGoals > 0
        ? shrunkRatio(homeAgg.homeGoals / homeAgg.homePlayed, leagueTeamGoals, homeAgg.homePlayed)
        : 1;
    const awayDefenceRel =
      awayAgg.awayPlayed > 0 && leagueTeamGoals > 0
        ? shrunkRatio(awayAgg.awayConceded / awayAgg.awayPlayed, leagueTeamGoals, awayAgg.awayPlayed)
        : 1;
    const awayAttackRel =
      awayAgg.awayPlayed > 0 && leagueTeamGoals > 0
        ? shrunkRatio(awayAgg.awayGoals / awayAgg.awayPlayed, leagueTeamGoals, awayAgg.awayPlayed)
        : 1;
    const homeDefenceRel =
      homeAgg.homePlayed > 0 && leagueTeamGoals > 0
        ? shrunkRatio(homeAgg.homeConceded / homeAgg.homePlayed, leagueTeamGoals, homeAgg.homePlayed)
        : 1;

    const baseLambdas = {
      home: Math.max(0.2, leagueHomeGoals * homeAttackRel * awayDefenceRel),
      away: Math.max(0.15, leagueAwayGoals * awayAttackRel * homeDefenceRel),
    };

    const naiveProbs = poissonOutcomeProbs(baseLambdas.home, baseLambdas.away);

    const recentFor = (id: number) =>
      historyFor(id)
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-6)
        .map(m => ({
          utcTime: `${m.date}T15:00:00.000Z`,
          homeId: m.homeId,
          awayId: m.awayId,
          homeName: m.homeName,
          awayName: m.awayName,
          homeScore: m.homeGoals,
          awayScore: m.awayGoals,
          competition: m.league,
        }));

    // Identité statique uniquement : les compteurs de saison seraient
    // une fuite temporelle (ils incluent des matchs postérieurs).
    const squadFor = (snapshot: BacktestTeamSnapshot | undefined) =>
      (snapshot?.players || []).map(p => ({
        id: p.id,
        name: p.name,
        position: p.position,
        rating: null,
        goals: 0,
        assists: 0,
        marketValue: 0,
        minutes: 0,
        xg: 0,
        xa: 0,
      }));

    const absencesFor = (ids: number[], snapshot: BacktestTeamSnapshot | undefined) =>
      (ids || [])
        .map(id => {
          const player = (snapshot?.players || []).find(p => p.id === id);
          return {
            id,
            name: player?.name || `Joueur #${id}`,
            type: 'injury',
            position: player?.position,
            marketValue: 0,
            rating: null,
            goals: 0,
            assists: 0,
          };
        })
        .filter(a => a.id);

    const lineupFor = (
      ids: number[],
      snapshot: BacktestTeamSnapshot | undefined,
      confirmed?: boolean
    ) => {
      // Compositions confirmées mais identifiants indisponibles dans le
      // jeu de données anti-fuite : on conserve l'information d'état.
      if (!ids?.length) return confirmed ? { formation: null, starters: [], confirmed: true } : null;
      return {
        formation: null,
        starters: ids.map(id => {
          const player = (snapshot?.players || []).find(p => p.id === id);
          return {
            id,
            name: player?.name || `Joueur #${id}`,
            marketValue: 0,
            rating: null,
            position: player?.position,
          };
        }),
      };
    };

    // Les statistiques d'instantané (totaux de saison au moment de la
    // collecte) sont volontairement écartées : elles incluent des matchs
    // joués APRÈS la rencontre prédite.
    const statsFor = (aggregate: TeamAggregate) => {
      const stats: Record<string, { value: number; format?: string; perMatch?: number }> = {};
      if (aggregate.played > 0) {
        stats.expected_goals_team = {
          value: aggregate.xg / aggregate.played,
          format: 'fraction',
          perMatch: aggregate.xg / aggregate.played,
        };
        stats.expected_goals_conceded_team = {
          value: aggregate.xgConceded / aggregate.played,
          format: 'fraction',
          perMatch: aggregate.xgConceded / aggregate.played,
        };
      }
      return stats;
    };

    // Échantillons disponibles AVANT le coup d'envoi uniquement.
    const priorWithHalfTime = history
      .filter(
        m =>
          (m.homeId === match.homeId || m.awayId === match.homeId || m.homeId === match.awayId || m.awayId === match.awayId) &&
          m.htHome !== null &&
          m.htAway !== null
      )
      .slice(-24)
      .map(m => ({
        htHome: m.htHome as number,
        htAway: m.htAway as number,
        homeGoals: m.homeGoals,
        awayGoals: m.awayGoals,
      }));

    const priorForCovariance = history
      .slice(-60)
      .map(m => ({ homeGoals: m.homeGoals, awayGoals: m.awayGoals }));

    const input: AnalystInput = {
      matchId: match.id,
      kickoffIso: `${match.date}T15:00:00.000Z`,
      baseLambdas,
      covarianceSamples: priorForCovariance,
      halfTimeSamples: priorWithHalfTime,
      market: match.odds
        ? { ...match.odds, format: 'decimal', source: 'Backtest', providerLabel: match.provider }
        : null,
      referee: match.referee
        ? {
            name: 'Arbitre backtest',
            ...match.referee,
          }
        : null,
      weather: match.weather ?? null,
      h2h: null,
      league: { rowsAll, rowsHome, rowsAway, xgRows: rowsAll, legend: [] },
      home: {
        teamId: match.homeId,
        name: match.homeName,
        tableAll: rowsAll.find(r => r.id === match.homeId) ?? null,
        tableHome: rowsHome.find(r => r.id === match.homeId) ?? null,
        tableAway: rowsAway.find(r => r.id === match.homeId) ?? null,
        xgRow: rowsAll.find(r => r.id === match.homeId) ?? null,
        recentMatches: recentFor(match.homeId),
        stats: statsFor(homeAgg),
        squad: squadFor(homeSnapshot),
        absences: absencesFor(match.unavailableHome, homeSnapshot),
        lineup: lineupFor(match.startersHome, homeSnapshot, match.lineupConfirmedHome),
        formation: null,
        playerStats: {},
      },
      away: {
        teamId: match.awayId,
        name: match.awayName,
        tableAll: rowsAll.find(r => r.id === match.awayId) ?? null,
        tableHome: rowsHome.find(r => r.id === match.awayId) ?? null,
        tableAway: rowsAway.find(r => r.id === match.awayId) ?? null,
        xgRow: rowsAll.find(r => r.id === match.awayId) ?? null,
        recentMatches: recentFor(match.awayId),
        stats: statsFor(awayAgg),
        squad: squadFor(awaySnapshot),
        absences: absencesFor(match.unavailableAway, awaySnapshot),
        lineup: lineupFor(match.startersAway, awaySnapshot, match.lineupConfirmedAway),
        formation: null,
        playerStats: {},
      },
    };

    inputs.push(input);
    naive.push(naiveProbs);
  }

  return { inputs, naive };
}

/** Issues 1X2 issues d'un Poisson indépendant (référence naïve). */
export function poissonOutcomeProbs(lambdaHome: number, lambdaAway: number): OutcomeProbs {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= 9; h++) {
    for (let a = 0; a <= 9; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away || 1;
  return { home: home / total, draw: draw / total, away: away / total };
}

/* ------------------------------------------------------------------ */
/* Métriques                                                            */
/* ------------------------------------------------------------------ */

function logLoss(probs: OutcomeProbs, outcome: 0 | 1 | 2): number {
  const p = outcome === 0 ? probs.home : outcome === 1 ? probs.draw : probs.away;
  return -Math.log(Math.max(1e-9, p));
}

function brierScore(probs: OutcomeProbs, outcome: 0 | 1 | 2): number {
  const actual = [outcome === 0 ? 1 : 0, outcome === 1 ? 1 : 0, outcome === 2 ? 1 : 0];
  const predicted = [probs.home, probs.draw, probs.away];
  return actual.reduce((acc, a, i) => acc + Math.pow(a - predicted[i], 2), 0);
}

/** Probabilité du marché pour l'issue la plus probable du modèle. */
function pickMarketProbability(
  match: BacktestMatch,
  model: OutcomeProbs,
  market: OutcomeProbs | null
): number {
  if (!market) return 0;
  const pick = topPick(model);
  const value = pick === 0 ? market.home : pick === 1 ? market.draw : market.away;
  void match;
  return Math.max(0, Math.min(1, value));
}

function topPick(probs: OutcomeProbs): 0 | 1 | 2 {
  if (probs.home >= probs.draw && probs.home >= probs.away) return 0;
  if (probs.draw >= probs.away) return 1;
  return 2;
}

/* ------------------------------------------------------------------ */
/* Exécution du backtest                                               */
/* ------------------------------------------------------------------ */

export function runBacktest(
  dataset: BacktestDataset,
  options?: { maxMatches?: number; calibration?: Partial<CalibrationParams> }
): BacktestResult {
  const matches = dataset.matches.slice().sort((a, b) => a.date.localeCompare(b.date));
  const limit = options?.maxMatches ?? matches.length;
  const { inputs, naive } = buildWalkForwardInputs(dataset);

  const samples: BacktestSample[] = [];
  const start = Math.max(0, matches.length - limit);

  for (let i = start; i < matches.length; i++) {
    const match = matches[i];
    const input = inputs[i];
    if (!input) continue;

    let report: ReturnType<typeof runQuantitativeAnalyst>;
    try {
      report = runQuantitativeAnalyst({ ...input, calibration: options?.calibration });
    } catch {
      continue;
    }

    const model: OutcomeProbs = {
      home: report.market.pureModel.home,
      draw: report.market.pureModel.draw,
      away: report.market.pureModel.away,
    };
    const devig = match.odds ? devigThreeWayDecimal(match.odds) : null;
    const market: OutcomeProbs | null = devig
      ? { home: devig.probs.home, draw: devig.probs.draw, away: devig.probs.away }
      : null;

    const outcome: 0 | 1 | 2 =
      match.homeGoals > match.awayGoals ? 0 : match.homeGoals === match.awayGoals ? 1 : 2;

    samples.push({
      matchId: match.id,
      date: match.date,
      outcome,
      model,
      market,
      naive: naive[i] ?? { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
      separation: report.confidence.separation,
      agreement: report.confidence.agreement,
      marketPick: pickMarketProbability(match, report.market.pureModel, devig ? devig.probs : null),
      confidenceScore: report.confidence.score,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
      odds: match.odds,
    });
  }

  return evaluateSamples(samples, dataset, options?.calibration);
}

/* ------------------------------------------------------------------ */
/* Évaluation & ajustement                                              */
/* ------------------------------------------------------------------ */

export function evaluateSamples(
  samples: BacktestSample[],
  dataset: BacktestDataset,
  calibrationOverride?: Partial<CalibrationParams>
): BacktestResult {
  const notes: string[] = [];

  // --- 1. Température & poids du marché : minimisation de la log-loss ---
  let best: { weight: number; sharpness: number; loss: number } | null = null;
  for (let sharpness = 0.4; sharpness <= 2.0001; sharpness += 0.05) {
    for (let weight = 0; weight <= 1.0001; weight += 0.02) {
      let loss = 0;
      let n = 0;
      for (const sample of samples) {
        const probs = applyCalibration(
          sample.model,
          sample.market,
          { sharpness, modelWeight: weight } as CalibrationParams
        ).probs;
        loss += logLoss(probs, sample.outcome);
        n += 1;
      }
      const mean = n ? loss / n : Infinity;
      if (!best || mean < best.loss) best = { weight, sharpness, loss: mean };
    }
  }

  const modelWeight = calibrationOverride?.modelWeight ?? best?.weight ?? 0.6;
  const sharpness = calibrationOverride?.sharpness ?? best?.sharpness ?? 1;

  // --- 2. Seuil de « valeur » : premier palier d'edge au ROI positif ---
  const edgeBuckets = computeEdgeBuckets(samples, modelWeight, sharpness);
  const valueThreshold = calibrationOverride?.valueThreshold ?? deriveValueThreshold(edgeBuckets);

  // --- 3. Confiance : régression logistique ----------------------------
  const logistic = calibrationOverride?.logistic ?? fitLogistic(samples);
  const confidenceBins = buildConfidenceBins(samples, logistic);

  // --- 4. Intervalle de crédibilité : concentration effective ----------
  const effectiveSampleSize =
    calibrationOverride?.effectiveSampleSize ?? fitEffectiveSampleSize(samples, modelWeight, sharpness);

  // --- 5. Métriques -----------------------------------------------------
  let modelLoss = 0;
  let marketLoss = 0;
  let calibratedLoss = 0;
  let naiveLoss = 0;
  let brier = 0;
  let correct = 0;
  let marketN = 0;
  let marketLossSum = 0;

  for (const sample of samples) {
    modelLoss += logLoss(sample.model, sample.outcome);
    calibratedLoss += logLoss(
      applyCalibration(sample.model, sample.market, { sharpness, modelWeight } as CalibrationParams).probs,
      sample.outcome
    );
    naiveLoss += logLoss(sample.naive, sample.outcome);
    brier += brierScore(
      applyCalibration(sample.model, sample.market, { sharpness, modelWeight } as CalibrationParams).probs,
      sample.outcome
    );
    if (topPick(sample.model) === sample.outcome) correct += 1;
    if (sample.market) {
      marketLossSum += logLoss(sample.market, sample.outcome);
      marketN += 1;
    }
  }

  const n = samples.length || 1;
  const metrics: CalibrationMetrics = {
    sampleSize: samples.length,
    league: dataset.league,
    period: dataset.period,
    modelLogLoss: Number((modelLoss / n).toFixed(4)),
    marketLogLoss: marketN ? Number((marketLossSum / marketN).toFixed(4)) : null,
    calibratedLogLoss: Number((calibratedLoss / n).toFixed(4)),
    naiveLogLoss: Number((naiveLoss / n).toFixed(4)),
    brier: Number((brier / n).toFixed(4)),
    accuracy: Number((correct / n).toFixed(4)),
    valueRoi: null,
    valueBets: 0,
    valueThreshold: Number(valueThreshold.toFixed(4)),
  };

  const valueStats = computeValueRoi(samples, modelWeight, sharpness, valueThreshold);
  metrics.valueRoi = valueStats.roi;
  metrics.valueBets = valueStats.bets;

  const calibrationCurve = buildCalibrationCurve(samples, modelWeight, sharpness);

  if (samples.length < 30) {
    notes.push(
      `Échantillon de ${samples.length} match(s) : l'ajustement reste exploratoire, l'intervalle de confiance sur les paramètres est large.`
    );
  }
  notes.push(
    `Log-loss : modèle pur ${metrics.modelLogLoss} · calibré ${metrics.calibratedLogLoss} · marché ${metrics.marketLogLoss ?? '—'} · naïf ${metrics.naiveLogLoss}.`
  );
  notes.push(
    'Ajustement sans fuite temporelle : seuls les cumuls antérieurs, les absences et les compositions confirmées sont utilisés ; les totaux de saison collectés après coup sont exclus.'
  );
  if (metrics.calibratedLogLoss > metrics.naiveLogLoss) {
    notes.push(
      'Le modèle calibré est moins bon que la référence naïve sur cet échantillon : le poids du marché et la température sont à revisar.'
    );
  } else {
    notes.push('Le modèle calibré bat la référence naïve (moyennes de league) sur cet échantillon.');
  }

  const params: CalibrationParams = {
    version: '3.0',
    modelWeight: Number(modelWeight.toFixed(4)),
    sharpness: Number(sharpness.toFixed(4)),
    valueThreshold: Number(valueThreshold.toFixed(4)),
    effectiveSampleSize: Number(effectiveSampleSize.toFixed(2)),
    logistic,
    confidenceBins,
    metrics,
    dataset: `${dataset.league} · ${dataset.period}`,
    fittedAt: new Date().toISOString(),
  };

  return { metrics, params, samples, calibrationCurve, edgeBuckets, notes };
}

/** Découpage par tranche d'écart modèle/marché. */
function computeEdgeBuckets(
  samples: BacktestSample[],
  modelWeight: number,
  sharpness: number
): BacktestResult['edgeBuckets'] {
  const buckets: {
    edge: string;
    min: number;
    max: number;
    samples: number;
    roi: number;
    hitRate: number;
  }[] = [];
  const edges: { edge: number; roi: number; hit: boolean }[] = [];

  for (const sample of samples) {
    if (!sample.market || !sample.odds) continue;
    const calibrated = applyCalibration(
      sample.model,
      sample.market,
      { sharpness, modelWeight } as CalibrationParams
    ).probs;
    const picks: { index: 0 | 1 | 2; edge: number; odds: number }[] = [
      { index: 0, edge: calibrated.home - sample.market.home, odds: sample.odds.home },
      { index: 1, edge: calibrated.draw - sample.market.draw, odds: sample.odds.draw },
      { index: 2, edge: calibrated.away - sample.market.away, odds: sample.odds.away },
    ];
    const best = picks.sort((a, b) => b.edge - a.edge)[0];
    if (best.edge <= 0) continue;
    const hit = best.index === sample.outcome;
    const ret = hit ? best.odds - 1 : -1;
    edges.push({ edge: best.edge, roi: ret, hit });
  }

  const ranges: [number, number, string][] = [
    [0, 0.02, '0–2 pts'],
    [0.02, 0.04, '2–4 pts'],
    [0.04, 0.06, '4–6 pts'],
    [0.06, 0.09, '6–9 pts'],
    [0.09, 0.13, '9–13 pts'],
    [0.13, Infinity, '13+ pts'],
  ];

  for (const [min, max, label] of ranges) {
    const slice = edges.filter(e => e.edge >= min && e.edge < max);
    if (!slice.length) {
      buckets.push({ edge: label, min, max: Number.isFinite(max) ? max : 1, samples: 0, roi: 0, hitRate: 0 });
      continue;
    }
    const roi = slice.reduce((a, e) => a + e.roi, 0) / slice.length;
    const hitRate = slice.filter(e => e.hit).length / slice.length;
    buckets.push({
      edge: label,
      min,
      max: Number.isFinite(max) ? max : 1,
      samples: slice.length,
      roi: Number(roi.toFixed(4)),
      hitRate: Number(hitRate.toFixed(4)),
    });
  }

  return buckets;
}

function deriveValueThreshold(buckets: BacktestResult['edgeBuckets']): number {
  // On retient le plus petit seuil (en unités de probabilité) à partir
  // duquel le ROI reste positif sur toutes les tranches supérieures, avec
  // un minimum de 8 paris par tranche.
  for (const bucket of buckets) {
    if (!bucket.samples || bucket.samples < 8) continue;
    if (bucket.roi > 0) return Number(bucket.min.toFixed(4));
  }
  return 0.08;
}

function computeValueRoi(
  samples: BacktestSample[],
  modelWeight: number,
  sharpness: number,
  threshold: number
): { roi: number | null; bets: number } {
  let returns = 0;
  let bets = 0;
  for (const sample of samples) {
    if (!sample.market || !sample.odds) continue;
    const calibrated = applyCalibration(
      sample.model,
      sample.market,
      { sharpness, modelWeight } as CalibrationParams
    ).probs;
    const picks: { index: 0 | 1 | 2; edge: number; odds: number }[] = [
      { index: 0, edge: calibrated.home - sample.market.home, odds: sample.odds.home },
      { index: 1, edge: calibrated.draw - sample.market.draw, odds: sample.odds.draw },
      { index: 2, edge: calibrated.away - sample.market.away, odds: sample.odds.away },
    ];
    const best = picks.sort((a, b) => b.edge - a.edge)[0];
    if (best.edge < threshold) continue;
    bets += 1;
    returns += best.index === sample.outcome ? best.odds - 1 : -1;
  }
  return { roi: bets ? Number((returns / bets).toFixed(4)) : null, bets };
}

function buildCalibrationCurve(
  samples: BacktestSample[],
  modelWeight: number,
  sharpness: number
): BacktestResult['calibrationCurve'] {
  const bins = new Map<string, { predicted: number; hits: number; n: number }>();
  for (const sample of samples) {
    const calibrated = applyCalibration(
      sample.model,
      sample.market,
      { sharpness, modelWeight } as CalibrationParams
    ).probs;
    const pick = topPick(calibrated);
    const p = pick === 0 ? calibrated.home : pick === 1 ? calibrated.draw : calibrated.away;
    const key = `${Math.min(9, Math.floor(p * 10)) * 10}-${Math.min(9, Math.floor(p * 10)) * 10 + 10} %`;
    const entry = bins.get(key) || { predicted: 0, hits: 0, n: 0 };
    entry.predicted += p;
    entry.n += 1;
    if (pick === sample.outcome) entry.hits += 1;
    bins.set(key, entry);
  }
  return Array.from(bins.entries())
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    .map(([bin, entry]) => ({
      bin,
      predicted: Number((entry.predicted / entry.n).toFixed(4)),
      observed: Number((entry.hits / entry.n).toFixed(4)),
      samples: entry.n,
    }));
}

/**
 * Régression logistique (descente de gradient) : probabilité que l'issue
 * retenue par le modèle soit la bonne, en fonction de la séparation des
 * probabilités et de l'accord avec le marché.
 */
export function fitLogistic(samples: BacktestSample[]): CalibrationParams['logistic'] {
  const rows = samples.map(s => {
    const pick = topPick(s.model);
    return {
      x1: s.separation,
      x2: s.agreement,
      x3: s.marketPick ?? 0,
      y: pick === s.outcome ? 1 : 0,
    };
  });
  if (rows.length < 20) {
    return { intercept: 0, separation: 0, agreement: 0, marketPick: 0 };
  }

  // Régression logistique pénalisée (L2) avec coefficients contraints à
  // être positifs : la séparation du modèle et l'accord avec le marché
  // ne peuvent, par construction, qu'aider à prédire une réussite. Sans
  // cette contrainte, un échantillon bruité (109 matchs) produit des
  // coefficients de signe contraire à la réalité.
  let intercept = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  const learningRate = 0.15;
  const epochs = 6000;
  const lambda = 1.2;
  const n = rows.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let g0 = 0;
    let g1 = 0;
    let g2 = 0;
    let g3 = 0;
    for (const row of rows) {
      const z = intercept + b1 * row.x1 + b2 * row.x2 + b3 * row.x3;
      const p = 1 / (1 + Math.exp(-z));
      const error = p - row.y;
      g0 += error;
      g1 += error * row.x1;
      g2 += error * row.x2;
      g3 += error * row.x3;
    }
    intercept -= (learningRate * g0) / n;
    b1 = Math.max(0, b1 - (learningRate * (g1 + lambda * b1)) / n);
    b2 = Math.max(0, b2 - (learningRate * (g2 + lambda * b2)) / n);
    b3 = Math.max(0, b3 - (learningRate * (g3 + lambda * b3)) / n);
  }

  return {
    intercept: Number(intercept.toFixed(5)),
    separation: Number(b1.toFixed(5)),
    agreement: Number(b2.toFixed(5)),
    marketPick: Number(b3.toFixed(5)),
  };
}

function buildConfidenceBins(
  samples: BacktestSample[],
  logistic: CalibrationParams['logistic']
): ConfidenceBin[] {
  const edges = [0, 0.15, 0.3, 0.45, 0.6, 1.01];
  const bins: ConfidenceBin[] = [];
  const scored = samples.map(sample => {
    const z =
      logistic.intercept +
      logistic.separation * sample.separation +
      logistic.agreement * sample.agreement;
    const p = 1 / (1 + Math.exp(-z));
    return { p, hit: topPick(sample.model) === sample.outcome };
  });

  for (let i = 0; i < edges.length - 1; i++) {
    const slice = scored.filter(row => row.p >= edges[i] && row.p < edges[i + 1]);
    const hits = slice.filter(row => row.hit).length;
    const probability = slice.length
      ? Math.max(0.05, Math.min(0.95, (hits + 1) / (slice.length + 4)))
      : (edges[i] + edges[i + 1]) / 2;
    bins.push({
      min: Number(edges[i].toFixed(3)),
      max: Number(edges[i + 1].toFixed(3)),
      probability: Number(probability.toFixed(4)),
      samples: slice.length,
    });
  }
  return bins;
}

/**
 * Concentration effective de l'intervalle de crédibilité : on cherche la
 * valeur n telle que l'intervalle à 80 % contienne le résultat observé dans
 * 80 % des cas (critère de couverture directement interprétable).
 */
export function fitEffectiveSampleSize(
  samples: BacktestSample[],
  modelWeight: number,
  sharpness: number
): number {
  const rows = samples.map(sample => {
    const calibrated = applyCalibration(
      sample.model,
      sample.market,
      { sharpness, modelWeight } as CalibrationParams
    ).probs;
    const pick = topPick(calibrated);
    const p = pick === 0 ? calibrated.home : pick === 1 ? calibrated.draw : calibrated.away;
    return { p, probs: calibrated, outcome: sample.outcome, pick };
  });
  if (rows.length < 20) return 60;

  // La concentration effective est calibrée DIRECTEMENT sur la largeur
  // des intervalles de crédibilité :
  //
  //   - on regroupe les matchs par tranche de probabilité annoncée ;
  //   - pour chaque tranche, on compare la fréquence réellement observée
  //     à l'intervalle de crédibilité à 80 % calculé autour de la
  //     probabilité moyenne de la tranche ;
  //   - on retient la PLUS GRANDE concentration dont la couverture
  //     empirique reste ≥ 80 %, c'est-à-dire l'intervalle le plus
  //     étroit qui reste correctement calibré hors échantillon.
  //
  // En augmentant n, l'intervalle se resserre : on s'arrête donc au
  // dernier n qui ne casse pas la couverture nominale.
  const bins = new Map<number, { n: number; hits: number; sum: number }>();
  for (const row of rows) {
    const key = Math.min(9, Math.floor(row.p * 10));
    const entry = bins.get(key) || { n: 0, hits: 0, sum: 0 };
    entry.n += 1;
    entry.sum += row.p;
    if (row.pick === row.outcome) entry.hits += 1;
    bins.set(key, entry);
  }
  const slices = Array.from(bins.values()).filter(b => b.n >= 5);
  if (!slices.length) return 60;

  const coverageFor = (n: number): number => {
    let covered = 0;
    let total = 0;
    for (const slice of slices) {
      const meanP = slice.sum / slice.n;
      const observed = slice.hits / slice.n;
      const { low, high } = credibleInterval(meanP, n, 0.8);
      if (observed >= low && observed <= high) covered += slice.n;
      total += slice.n;
    }
    return total ? covered / total : 0;
  };

  let bestN = 1;
  for (let n = 1; n <= 800; n += 1) {
    if (coverageFor(n) >= 0.8) bestN = n;
  }
  return bestN;
}

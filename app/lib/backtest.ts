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
 *     collecte et nous donneraient un avantage rétrospectif indu ;
 *   - les absences et l'INDICATEUR « compositions confirmées » sont
 *     conservés : ils sont connus avant le coup d'envoi (annonce des
 *     compositions) ;
 *   - les cotes utilisées sont celles relevées avant le coup d'envoi.
 *
 * COMPOSITIONS ET JOUEURS : CE QUE LE JEU DE DONNÉES CONSERVE — ET CE
 * QU'IL NE CONSERVE PAS. La distinction est volontaire et documentée :
 *
 *   CONSERVÉ (disponible avant le coup d'envoi)
 *     - la confirmation des compositions (drapeau `lineupConfirmed*`) ;
 *     - la liste des joueurs ABSENTS (`unavailable*`), annoncée par le club
 *       ou loweek avant la rencontre ;
 *     - la structure du onze quand les identifiants sont disponibles.
 *
 *   NON CONSERVÉ (fuite temporelle ou reconstruction impossible)
 *     - les EFFECTIFS nominatifs (`teams[].players`) et les statistiques
 *       de joueur (xG, xA, minutes, note, valeur marchande) : ce sont des
 *       instantanés « au moment de la collecte », calculés sur des
 *       rencontres jouées APRÈS la rencontre prédite ;
 *     - les identifiants de titulaires (`startersHome` / `startersAway`)
 *       dans le jeu de données de référence : sans la fiche joueur
 *       correspondante (valeur, note, position), un identifiant isolé
 *       n'apporte rien au moteur et$rouvrirait la porte à des
 *       agrégats de joueur postérieurs au match ;
 *     - les totaux de saison des équipes (`teams[].stats`).
 *
 *   CONSÉQUENCE, ÉNONCÉE ET MESURÉE : le backtest rejoue un moteur
 *   allégé (module « effectif » sans pondération du onze titulaire),
 *   dont le poids de marché ajusté est donc une borne INFÉRIEURE de
 *   celui du moteur de production. Le rééquilibrage obtenu reste
 *   applicable en production ; il ne doit simplement pas être lu comme
 *   le réglage optimal du moteur complet.
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
import { applyCalibration, MIN_MEANINGFUL_EDGE } from './calibration';

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
  /**
   * Statistiques d'équipe (moyennes par match) utilisées par le moteur.
   * VOLONTAIREMENT VIDES dans le jeu de données de référence : ce sont des
   * totaux de saison collectés après coup (fuite temporelle).
   */
  stats?: Record<string, number>;
  /**
   * Fiches joueurs. VOLONTAIREMENT VIDES dans le jeu de données de
   * référence : les statistiques individuelles (xG, xA, minutes, note)
   * sont des instantanés postérieurs à la rencontre prédite.
   */
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
  /**
   * Cotes 1X2 par fournisseur (ex. Bet365, Pinnacle). Le triplet `odds`
   * ci-dessus reste le marché de référence de la calibration.
   */
  oddsByProvider?: Record<string, { home: number; draw: number; away: number }>;
  /**
   * Marchés dérivés avec cotes réelles (validation des pronostics) :
   * over/under 2,5, BTTS, Asian handicap.
   */
  derivedOdds?: {
    over25?: { over: number; under: number };
    btts?: { yes: number; no: number };
    ah?: { line: number; home: number; away: number };
  };
  provider: string | null;
  /** Joueurs absents annoncés avant le coup d'envoi (information publique). */
  unavailableHome: number[];
  unavailableAway: number[];
  /**
   * Identifiants de titulaires. VOLONTAIREMENT VIDES dans le jeu de
   * données de référence : sans la fiche joueur correspondante, un
   * identifiant isolé n'apporte rien et rouvrirait la porte à des
   * agrégats de joueur collected après la rencontre (fuite temporelle).
   * L'information conservée est le drapeau `lineupConfirmed*` ci-dessous.
   */
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
  /**
   * Libellé du jeu de données. Pour un jeu multi-championnats, il
   * regroupe les Championnat concerned (ex. « eng.1 + esp.1 »).
   */
  league: string;
  period: string;
  /**
   * Championnats couverts. Si absent, on déduit un seul championnat
   * depuis `league` (cas historique). Chaque championnat est rejoué
   * INDÉPENDAMMENT : classement, forme, moyennes et xG ne sont jamais
   * mélangés entre championnats.
   */
  leagues?: string[];
  teams: BacktestTeamSnapshot[];
  matches: BacktestMatch[];
};

export type BacktestSample = {
  matchId: string;
  date: string;
  /** Championnat de la rencontre (pour les diagnostics par ligue). */
  league: string;
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
  /** Probabilité « plus de 2,5 buts » annoncée par le modèle. */
  over25: number | null;
  /** Probabilité « les deux équipes marquent » annoncée par le modèle. */
  btts: number | null;
  /**
   * Probabilités dé-vigguées par fournisseur (ex. Bet365, Pinnacle).
   * Permet de comparer plusieurs marchés sur le même jeu de rencontres.
   */
  markets: Record<string, OutcomeProbs>;
  /** Cotes brutes 1X2 par fournisseur (pour le ROI). */
  rawOdds: Record<string, { home: number; draw: number; away: number }>;
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
 *
 * MULTI-CHAMPIONNATS : le replay est fait LIGUE PAR LIGUE. Le
 * classement, les moyennes de buts et les xG ne sont jamais mélangés
 * entre championnats — une rencontre de La Liga ne doit jamais voir le
 * classement de Premier League. Les rencontres sont ensuite ré-assemblées
 * par date pour l'évaluation conjointe.
 */
export function buildWalkForwardInputs(
  dataset: BacktestDataset,
  options?: { simulationRuns?: number }
): { inputs: AnalystInput[]; naive: OutcomeProbs[] } {
  const matches = dataset.matches.slice().sort((a, b) => a.date.localeCompare(b.date));

  const snapshots = new Map<number, BacktestTeamSnapshot>();
  for (const t of dataset.teams) snapshots.set(t.id, t);

  // Regroupement par championnat (l'ordre global par date est conservé).
  const groups = new Map<string, BacktestMatch[]>();
  for (const match of matches) {
    const key = match.league || dataset.league;
    const list = groups.get(key);
    if (list) list.push(match);
    else groups.set(key, [match]);
  }

  // Rejeu indépendant par championnat.
  const byId = new Map<string, { input: AnalystInput; naive: OutcomeProbs }>();
  groups.forEach((group, league) => {
    const built = buildLeagueWalkForward(group, snapshots, league, options);
    group.forEach((match, index) => {
      byId.set(match.id, { input: built.inputs[index], naive: built.naive[index] });
    });
  });

  const inputs: AnalystInput[] = [];
  const naive: OutcomeProbs[] = [];
  for (const match of matches) {
    const entry = byId.get(match.id);
    inputs.push(entry ? entry.input : emptyInput(match));
    naive.push(entry ? entry.naive : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 });
  }
  return { inputs, naive };
}

/** Entrée de repli : le match n'a pas pu être rejoué. */
function emptyInput(match: BacktestMatch): AnalystInput {
  return {
    matchId: match.id,
    kickoffIso: `${match.date}T15:00:00.000Z`,
    baseLambdas: { home: 1.3, away: 1.15 },
    covarianceSamples: [],
    halfTimeSamples: [],
    market: match.odds
      ? { ...match.odds, format: 'decimal', source: 'Backtest', providerLabel: match.provider }
      : null,
    referee: null,
    weather: match.weather ?? null,
    h2h: null,
    league: { rowsAll: [], rowsHome: [], rowsAway: [], xgRows: [], legend: [] },
    home: {
      teamId: match.homeId,
      name: match.homeName,
      tableAll: null,
      tableHome: null,
      tableAway: null,
      xgRow: null,
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
      lineup: null,
      formation: null,
      playerStats: {},
    },
    away: {
      teamId: match.awayId,
      name: match.awayName,
      tableAll: null,
      tableHome: null,
      tableAway: null,
      xgRow: null,
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
      lineup: null,
      formation: null,
      playerStats: {},
    },
  };
}

/**
 * Rejeu d'un championnat : pour chaque rencontre, l'état du championnat
 * est reconstruit à partir des seules rencontres ANTÉRIEURES de ce
 * championnat.
 */
function buildLeagueWalkForward(
  leagueMatches: BacktestMatch[],
  snapshots: Map<number, BacktestTeamSnapshot>,
  league: string,
  options?: { simulationRuns?: number }
): { inputs: AnalystInput[]; naive: OutcomeProbs[] } {
  const matches = leagueMatches;
  const teamNames = new Map<number, string>();
  for (const m of matches) {
    teamNames.set(m.homeId, m.homeName);
    teamNames.set(m.awayId, m.awayName);
  }

  const aggregates = new Map<number, TeamAggregate>();
  teamNames.forEach((name, id) => aggregates.set(id, emptyAggregate(id, name)));

  const inputs: AnalystInput[] = [];
  const naive: OutcomeProbs[] = [];

  // Historique d'une équipe RESTREINT aux rencontres déjà jouées.
  // Cette liste ne doit contenir que les matchs antérieurs à la rencontre
  // en cours de rejeu : prendre toute la saison revenait à laisser entrer
  // dans le modèle des matchs postérieurs (fuite temporelle).
  const historyFor = (id: number, prior: BacktestMatch[]) =>
    prior.filter(m => m.homeId === id || m.awayId === id);

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
    // Un but marqué à domicile n'est pas le même objet qu'un but marqué à
    // l'extérieur : on conserve deux références distinctes pour que les
    // ratios d'attaque et de défense soient comparés à la bonne base.
    const leagueHomeConceded = leagueAwayGoals;
    const leagueAwayConceded = leagueHomeGoals;

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

    // Référence de comparaison de chaque ratio :
    //   - attaque à domicile  → moyenne des buts marqués à domicile ;
    //   - défense à l'extérieur → moyenne des buts encaissés à l'extérieur ;
    //   - attaque à l'extérieur → moyenne des buts marqués à l'extérieur ;
    //   - défense à domicile → moyenne des buts encaissés à domicile.
    // Comparer chaque ratio à la moyenne GLOBALE (moyenne de tous les
    // buts du championnat) revient à surestimer l'attaque à domicile et
    // à sous-estimer l'attaque à l'extérieur : c'est un biais
    // systématique en faveur du favoured, Amplifié à chaque match.
    const homeAttackRel =
      homeAgg.homePlayed > 0 && leagueHomeGoals > 0
        ? shrunkRatio(homeAgg.homeGoals / homeAgg.homePlayed, leagueHomeGoals, homeAgg.homePlayed)
        : 1;
    const awayDefenceRel =
      awayAgg.awayPlayed > 0 && leagueAwayConceded > 0
        ? shrunkRatio(awayAgg.awayConceded / awayAgg.awayPlayed, leagueAwayConceded, awayAgg.awayPlayed)
        : 1;
    const awayAttackRel =
      awayAgg.awayPlayed > 0 && leagueAwayGoals > 0
        ? shrunkRatio(awayAgg.awayGoals / awayAgg.awayPlayed, leagueAwayGoals, awayAgg.awayPlayed)
        : 1;
    const homeDefenceRel =
      homeAgg.homePlayed > 0 && leagueHomeConceded > 0
        ? shrunkRatio(homeAgg.homeConceded / homeAgg.homePlayed, leagueHomeConceded, homeAgg.homePlayed)
        : 1;

    const baseLambdas = {
      home: Math.max(0.2, leagueHomeGoals * homeAttackRel * awayDefenceRel),
      away: Math.max(0.15, leagueAwayGoals * awayAttackRel * homeDefenceRel),
    };

    // Référence naïve : les MOYENNES DE CHAMPIONNAT seules, sans aucune
    // information d'équipe. C'est le point de comparaison honnête du
    // modèle : on mesure l'apport des ratios d'équipe, pas celui d'une
    // référence qui les contient déjà.
    const naiveProbs = poissonOutcomeProbs(leagueHomeGoals, leagueAwayGoals);

    // Forme récente : uniquement des matchs ANTERIEURS à la rencontre.
    // On écarte aussi les matchs du même jour : l'heure de coup d'envoi
    // n'est pas connue dans le jeu de données, donc leur ordre par
    // rapport à la rencontre prédite n'est pas garanti.
    const recentFor = (id: number) =>
      historyFor(id, history)
        .filter(m => m.date < match.date)
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
      simulationRuns: options?.simulationRuns,
      baseLambdas,
      covarianceSamples: priorForCovariance,
      halfTimeSamples: priorWithHalfTime,
      market: match.odds
        ? { ...match.odds, format: 'decimal', source: 'Backtest', providerLabel: match.provider }
        : null,
      // ANTI-FUITE : ni l'arbitre ni la météo ne sont utilisés dans le
      // rejeu. Le profil d'arbitre collecté est un cumul de carrière lu
      // à la date de collecte : il inclut les matchs POSTÉRIEURS à la
      // rencontre prédite. La météo collectée est la météo RÉELLE du
      // match, qui n'est pas une information d'avant-match (seule la
      // prévision l'est, et elle n'est pas conservée).
      // Impact mesuré sur le jeu de référence : log-loss 1,0576 → 1,0573
      // (sans arbitre ni météo) : négligeable, la correction est donc
      // sans risque. En production, l'analyse d'un match à venir utilise
      // bien l'arbitre désigné et la prévision météo.
      referee: null,
      weather: null,
      h2h: null,
      league: { rowsAll, rowsHome, rowsAway, xgRows: rowsAll, legend: [], name: league },
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
  options?: {
    maxMatches?: number;
    calibration?: Partial<CalibrationParams>;
    simulationRuns?: number;
  }
): BacktestResult {
  const matches = dataset.matches.slice().sort((a, b) => a.date.localeCompare(b.date));
  const limit = options?.maxMatches ?? matches.length;
  const { inputs, naive } = buildWalkForwardInputs(dataset, {
    simulationRuns: options?.simulationRuns,
  });

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

    // Marchés additionnels (Bet365, Pinnacle, moyenne) : chacun est
    // dé-viggué séparément pour être comparable.
    const markets: Record<string, OutcomeProbs> = {};
    const rawOdds: Record<string, { home: number; draw: number; away: number }> = {};
    for (const [provider, triple] of Object.entries(match.oddsByProvider || {})) {
      if (!triple || !Number.isFinite(triple.home) || !Number.isFinite(triple.draw) || !Number.isFinite(triple.away)) continue;
      const providerDevig = devigThreeWayDecimal(triple);
      if (!providerDevig) continue;
      markets[provider] = {
        home: providerDevig.probs.home,
        draw: providerDevig.probs.draw,
        away: providerDevig.probs.away,
      };
      rawOdds[provider] = { ...triple };
    }

    const outcome: 0 | 1 | 2 =
      match.homeGoals > match.awayGoals ? 0 : match.homeGoals === match.awayGoals ? 1 : 2;

    samples.push({
      matchId: match.id,
      date: match.date,
      league: match.league || dataset.league,
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
      over25: Number.isFinite(report.market.pureModel.over25) ? report.market.pureModel.over25 : null,
      btts: Number.isFinite(report.market.pureModel.btts) ? report.market.pureModel.btts : null,
      markets,
      rawOdds,
    });
  }

  return evaluateSamples(samples, dataset, options?.calibration);
}

/* ------------------------------------------------------------------ */
/* Évaluation & ajustement                                              */
/* ------------------------------------------------------------------ */

/**
 * Ajuste le poids du modèle et la température par balayage de la
 * log-loss calibrée.
 *
 * La surface de perte est très plate autour de l'optimum (le poids et
 * la température se compensent partiellement) : on retient donc, parmi
 * les couples équivalents à 5·10⁻⁴ de log-loss près du minimum, celui
 * dont la température est la plus proche de 1 (valeur neutre). Sans
 * cette règle de parcimonie, l'ajustement glisse vers la borne de la
 * grille et le paramètre devient ininterprétable.
 */
export function fitBlendParams(
  samples: BacktestSample[]
): { weight: number; sharpness: number; loss: number } | null {
  if (!samples.length) return null;
  const tolerance = 5e-4;
  let min = Infinity;
  const grid: { weight: number; sharpness: number; loss: number }[] = [];

  for (let sharpness = 0.4; sharpness <= 2.2001; sharpness += 0.05) {
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
      grid.push({ weight, sharpness, loss: mean });
      if (mean < min) min = mean;
    }
  }

  const near = grid
    .filter(g => g.loss <= min + tolerance)
    .sort((a, b) => Math.abs(a.sharpness - 1) - Math.abs(b.sharpness - 1) || a.loss - b.loss);
  return near[0] ?? null;
}

/**
 * Log-loss calibrée hors échantillon : pour chaque bloc, les paramètres
 * sont ajustés sur les autres blocs puis évalués sur le bloc écarté.
 */
/**
 * Répartit les échantillons en blocs TEMPORELS contigus.
 *
 * L'ancien découpage (`index % folds`) entrelaçait les blocs : un match
 * était évalué avec des matchs du même échantillon situés APRÈS lui,
 * donc la validation croisée laissait passer de l'information future.
 * Ici, une fois les échantillons triés par date, l'indice de bloc est
 * croissant : chaque bloc couvre une période continue.
 */
export function temporalFoldIndex(samples: BacktestSample[], folds: number): number[] {
  const result = new Array(samples.length).fill(0);
  if (samples.length === 0 || folds < 2) return result;
  const order = samples
    .map((_, index) => index)
    .sort((a, b) => samples[a].date.localeCompare(samples[b].date));
  const size = Math.max(1, Math.floor(order.length / folds));
  order.forEach((sampleIndex, position) => {
    result[sampleIndex] = Math.min(folds - 1, Math.floor(position / size));
  });
  return result;
}

export function crossValidatedLogLoss(samples: BacktestSample[], folds: number): number {
  if (samples.length < 20 || folds < 2) {
    let loss = 0;
    for (const sample of samples) {
      loss += logLoss(
        applyCalibration(sample.model, sample.market, { sharpness: 1, modelWeight: 0 } as CalibrationParams).probs,
        sample.outcome
      );
    }
    return samples.length ? loss / samples.length : 0;
  }

  const foldIndex = temporalFoldIndex(samples, folds);
  let total = 0;
  let count = 0;
  for (let fold = 0; fold < folds; fold++) {
    const train = samples.filter((_, index) => foldIndex[index] !== fold);
    const test = samples.filter((_, index) => foldIndex[index] === fold);
    if (!train.length || !test.length) continue;
    const best = fitBlendParams(train);
    if (!best) continue;
    for (const sample of test) {
      const probs = applyCalibration(
        sample.model,
        sample.market,
        { sharpness: best.sharpness, modelWeight: best.weight } as CalibrationParams
      ).probs;
      total += logLoss(probs, sample.outcome);
      count += 1;
    }
  }
  return count ? total / count : 0;
}

/**
 * Log-loss en marche avant STRICTE : chaque bloc est évalué avec une
 * calibration ajustée uniquement sur les blocs qui le PRÉCÈDENT dans le
 * temps. Aucun match n'est donc jamais évalué avec une calibration
 * qui a vu son avenir.
 *
 * Le premier bloc n'a pas d'historique d'ajustement : il n'est pas
 * évalué. Le résultat indique donc combien de rencontres ont été
 * effectivement couvertes.
 */
export function walkForwardLogLoss(
  samples: BacktestSample[],
  folds: number
): { loss: number; evaluated: number; covered: number } {
  if (samples.length < 20 || folds < 2) {
    return { loss: crossValidatedLogLoss(samples, folds), evaluated: samples.length, covered: samples.length };
  }
  const foldIndex = temporalFoldIndex(samples, folds);
  let total = 0;
  let evaluated = 0;
  for (let fold = 1; fold < folds; fold++) {
    const train = samples.filter((_, index) => foldIndex[index] < fold);
    const test = samples.filter((_, index) => foldIndex[index] === fold);
    if (!train.length || !test.length) continue;
    const best = fitBlendParams(train);
    if (!best) continue;
    for (const sample of test) {
      const probs = applyCalibration(
        sample.model,
        sample.market,
        { sharpness: best.sharpness, modelWeight: best.weight } as CalibrationParams
      ).probs;
      total += logLoss(probs, sample.outcome);
      evaluated += 1;
    }
  }
  return {
    loss: evaluated ? total / evaluated : 0,
    evaluated,
    covered: samples.length,
  };
}

export function evaluateSamples(
  samples: BacktestSample[],
  dataset: BacktestDataset,
  calibrationOverride?: Partial<CalibrationParams>
): BacktestResult {
  const notes: string[] = [];

  // --- 1. Température & poids du marché : minimisation de la log-loss ---
  const best = fitBlendParams(samples);

  const modelWeight = calibrationOverride?.modelWeight ?? best?.weight ?? 0.6;
  const sharpness = calibrationOverride?.sharpness ?? best?.sharpness ?? 1;

  // --- 2. Seuil de « valeur » : plus petit seuil au ROI cumulé positif ---
  const edgeBuckets = computeEdgeBuckets(samples, modelWeight, sharpness);
  const derived = deriveValueThreshold(samples, modelWeight, sharpness);
  const valueThreshold = calibrationOverride?.valueThreshold ?? derived.threshold;
  // Le seuil n'est « démontré » que si l'ajustement a trouvé un seuil dont
  // le ROI cumulé est positif sur l'historique. Sinon la détection de
  // valeur reste inactive (voir valueAssessment).
  const valueThresholdDemonstrated = derived.demonstrated;
  if (!derived.demonstrated) {
    notes.push(
      `Aucun seuil d\'edge ne démontre un ROI positif sur cet échantillon (${derived.bets} pari(s) à edge positif, ROI ${((derived.roi ?? 0) * 100).toFixed(1)} %). Le signal « valeur » reste INACTIF : il n\'est pas validé empiriquement.`
    );
  }

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
  // Log-loss calibrée HORS ÉCHANTILLON : les paramètres sont ajustés sur
  // k-1 blocs et évalués sur le bloc écarté. Sans cela, on mesure la
  // qualité de l'ajustement sur les matchs qui l'ont produit, pas sa
  // capacité à se généraliser.
  const folds = samples.length >= 100 ? 5 : samples.length >= 40 ? 4 : 3;
  const crossValidated = crossValidatedLogLoss(samples, folds);
  const walkForward = walkForwardLogLoss(samples, folds);
  const metrics: CalibrationMetrics = {
    sampleSize: samples.length,
    league: dataset.league,
    period: dataset.period,
    modelLogLoss: Number((modelLoss / n).toFixed(4)),
    marketLogLoss: marketN ? Number((marketLossSum / marketN).toFixed(4)) : null,
    calibratedLogLoss: Number(crossValidated.toFixed(4)),
    calibratedLogLossInSample: Number((calibratedLoss / n).toFixed(4)),
    crossValidationFolds: folds,
    walkForwardLogLoss: Number(walkForward.loss.toFixed(4)),
    walkForwardEvaluated: walkForward.evaluated,
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
    `Log-loss : modèle pur ${metrics.modelLogLoss} · calibré hors échantillon ${metrics.calibratedLogLoss} (in-sample ${metrics.calibratedLogLossInSample}, ${metrics.crossValidationFolds} blocs temporels) · marché ${metrics.marketLogLoss ?? '—'} · naïf ${metrics.naiveLogLoss}.`
  );
  notes.push(
    `Marche avant stricte : ${metrics.walkForwardLogLoss} sur ${metrics.walkForwardEvaluated} rencontre(s) évaluées avec une calibration ajustée uniquement sur les blocs PRÉCÉDENTS (aucun match n’est évalué avec une calibration qui a vu son avenir).`
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
    version: '3.1',
    modelWeight: Number(modelWeight.toFixed(4)),
    sharpness: Number(sharpness.toFixed(4)),
    valueThreshold: Number(valueThreshold.toFixed(4)),
    valueThresholdDemonstrated,
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

/**
 * Seuil de « valeur » : le plus petit seuil d'edge (en unités de
 * probabilité) tel que le ROI CUMULÉ de tous les paris au-delà de ce
 * seuil soit positif, avec au moins 8 paris.
 *
 * Le ROI cumulé est utilisé (et non le ROI de la seule tranche) parce
 * que c'est exactement ce que l'utilisateur applique : parier
 * sur tout ce qui dépasse le seuil. Si aucun seuil ne satisfait ces
 * deux conditions, on retient le seuil minimal et on signale
 * explicitement que le signal « valeur » n'est pas démontré.
 */
function deriveValueThreshold(
  samples: BacktestSample[],
  modelWeight: number,
  sharpness: number
): { threshold: number; roi: number | null; bets: number; demonstrated: boolean } {
  const candidates = [0, 0.02, 0.04, 0.06, 0.09, 0.13];
  for (const threshold of candidates) {
    const stats = computeValueRoi(samples, modelWeight, sharpness, threshold);
    if (stats.bets >= 8 && (stats.roi ?? 0) > 0) {
      return { threshold, roi: stats.roi, bets: stats.bets, demonstrated: true };
    }
  }
  const fallback = computeValueRoi(samples, modelWeight, sharpness, 0);
  return { threshold: 0, roi: fallback.roi, bets: fallback.bets, demonstrated: false };
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
    // Même définition d'un « pari » que la production (valueAssessment) :
    // un écart strictement positif ET au-dessus du seuil. Sans cette
    // contrainte, un écart nul (mélange = marché) comptait comme un pari
    // et le ROI mesuré était celui de la marge du bookmaker, pas celui
    // d'une stratégie de valeur.
    if (!(best.edge > MIN_MEANINGFUL_EDGE) || best.edge < threshold) continue;
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
  // La tranche doit décrire la MÊME chose que la confiance affichée : on
  // utilise donc exactement la formule de `calibratedConfidence`, terme
  // `marketPick` compris. Sans lui, les tranches mesuraient une autre
  // grandeur que celle affichée à l'utilisateur.
  const scored = samples.map(sample => {
    const z =
      logistic.intercept +
      logistic.separation * sample.separation +
      logistic.agreement * sample.agreement +
      (logistic.marketPick ?? 0) * (sample.marketPick ?? 0);
    const p = 1 / (1 + Math.exp(-z));
    return { p, hit: topPick(sample.model) === sample.outcome };
  });

  for (let i = 0; i < edges.length - 1; i++) {
    const slice = scored.filter(row => row.p >= edges[i] && row.p < edges[i + 1]);
    const hits = slice.filter(row => row.hit).length;
    // Une tranche sans échantillon n'a AUCUNE probabilité mesurée :
    // on la laisse vide plutôt que d'y mettre une valeur inventée.
    const probability = slice.length
      ? Math.max(0.05, Math.min(0.95, (hits + 1) / (slice.length + 4)))
      : null;
    bins.push({
      min: Number(edges[i].toFixed(3)),
      max: Number(edges[i + 1].toFixed(3)),
      probability: probability === null ? null : Number(probability.toFixed(4)),
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

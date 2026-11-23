/* ------------------------------------------------------------------ */
/* PARAMÈTRES DE CALIBRATION (ajustés sur backtest walk-forward)       */
/* ------------------------------------------------------------------ */
/*
 * Ces paramètres ne sont PAS des constantes choisies à la main : ils sont
 * ajustés par `npm run check:backtest -- --write` sur le jeu de données de
 * référence (app/lib/backtestDatasetCombined.ts = Premier League + La Liga),
 * puis versionnés ici.
 *
 * Le jeu de données est un backtest walk-forward : chaque match est rejoué
 * avec la seule information disponible avant son coup d'envoi, championnat
 * par championnat (aucun classement, aucune moyenne et aucun xG n'est
 * partagé entre les deux divisions).
 *
 * Pour ouvrir un nouveau calibrage :
 *   1. rafraîchir le jeu de données (route /api/backtest-data) ;
 *   2. lancer `npm run check:backtest -- --write` pour réécrire ce fichier ;
 *   3. vérifier que les métriques ne se dégradent pas.
 *
 * Ajustement du 2026-11-23 sur 236 rencontres
 * (eng.1 + esp.1 · 2026-08-15 → 2026-11-22).
 */

import type { CalibrationParams } from './calibration';

export const DEFAULT_CALIBRATION: CalibrationParams = {
  version: '3.0',
  modelWeight: 0.08,
  sharpness: 1.6,
  valueThreshold: 0.02,
  effectiveSampleSize: 137,
  logistic: {
    intercept: -2.22256,
    separation: 0.56887,
    agreement: 0.6187,
    marketPick: 2.59626,
  },
  confidenceBins: [
    { min: 0, max: 0.15, probability: 0.075, samples: 0 },
    { min: 0.15, max: 0.3, probability: 0.4667, samples: 236 },
    { min: 0.3, max: 0.45, probability: 0.375, samples: 0 },
    { min: 0.45, max: 0.6, probability: 0.525, samples: 0 },
    { min: 0.6, max: 1.01, probability: 0.805, samples: 0 },
  ],
  metrics: {
    sampleSize: 236,
    league: 'eng.1 + esp.1',
    period: '2026-08-15 → 2026-11-22',
    modelLogLoss: 1.0365,
    marketLogLoss: 0.9585,
    calibratedLogLoss: 0.9639,
    calibratedLogLossInSample: 0.9576,
    crossValidationFolds: 5,
    naiveLogLoss: 1.0853,
    brier: 0.5694,
    accuracy: 0.4703,
    valueRoi: 0.0226,
    valueBets: 50,
    valueThreshold: 0.02,
  },
  dataset: 'eng.1 + esp.1 · 2026-08-15 → 2026-11-22',
  fittedAt: '2026-11-23T20:26:13.443Z',
  limitations: [
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) ni la pondération du onze titulaire : les statistiques de joueur et les titulaires ne sont pas stockés dans le jeu de données de référence (ils seraient collectés après la rencontre). Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de 236 rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Évalué HORS ÉCHANTILLON (validation croisée à 5 blocs), le modèle calibré obtient une log-loss de 0.9639 contre 0.9585 pour le marché dé-viggué : sur cet échantillon, la calibration NE FAIT PAS MIEUX QUE LE MARCHÉ. La valeur in-sample (0.9576) est optimiste et ne doit jamais être citée seule.',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec 50 pari(s) sur l’échantillon (ROI 2.3 %), ce seuil reste indicatif et n’est PAS une preuve de rentabilité : il doit être réajusté sur un échantillon plus large.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
    'L’échantillon couvre deux championnats (eng.1 + esp.1) mais un seul jeu de paramètres : ceux-ci sont communs aux deux divisions.',
  ],
};

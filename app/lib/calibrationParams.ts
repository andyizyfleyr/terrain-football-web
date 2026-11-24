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
 * ATTENTION — la forme récente ne voit QUE les matchs antérieurs à la
 * rencontre prédite (correction de la fuite temporelle du 2026-11-23).
 * Avant cette correction, 70 % des entrées de forme venaient de matchs
 * postérieurs : l'ajustement était optimiste et le ROI « valeur » était
 * un artefact.
 *
 * Sur l'échantillon actuel, l'ajustement choisit un poids de modèle de
 * 0. C'est un résultat de MESURE, pas un choix : sur
 * 236 rencontres, le modèle n'apporte rien de mesurable
 * par-dessus le marché dé-viggué. L'ajustement reste PROVISOIRE tant que
 * l'échantillon de référence n'est pas élargi.
 *
 * Pour ouvrir un nouveau calibrage :
 *   1. rafraîchir le jeu de données (route /api/backtest-data) ;
 *   2. lancer `npm run check:backtest -- --write` pour réécrire ce fichier ;
 *   3. vérifier que les métriques ne se dégradent pas.
 *
 * Ajustement du 2026-11-24 sur 236 rencontres
 * (eng.1 + esp.1 · 2026-08-15 → 2026-11-22).
 */

import type { CalibrationParams } from './calibration';

export const DEFAULT_CALIBRATION: CalibrationParams = {
  version: '3.1',
  modelWeight: 0,
  sharpness: 1,
  valueThreshold: 0,
  valueThresholdDemonstrated: false,
  effectiveSampleSize: 26,
  logistic: {
    intercept: -1.94472,
    separation: 0.55181,
    agreement: 0.18117,
    marketPick: 2.87886,
  },
  confidenceBins: [
    { min: 0, max: 0.15, probability: null, samples: 0 },
    { min: 0.15, max: 0.3, probability: 0.2045, samples: 40 },
    { min: 0.3, max: 0.45, probability: 0.3171, samples: 78 },
    { min: 0.45, max: 0.6, probability: 0.4824, samples: 81 },
    { min: 0.6, max: 1.01, probability: 0.8293, samples: 37 },
  ],
  metrics: {
    sampleSize: 236,
    league: 'eng.1 + esp.1',
    period: '2026-08-15 → 2026-11-22',
    modelLogLoss: 1.0573,
    marketLogLoss: 0.9585,
    calibratedLogLoss: 0.9593,
    calibratedLogLossInSample: 0.9585,
    crossValidationFolds: 5,
    walkForwardLogLoss: 0.9664,
    walkForwardEvaluated: 189,
    naiveLogLoss: 1.0853,
    brier: 0.5699,
    accuracy: 0.4492,
    valueRoi: null,
    valueBets: 0,
    valueThreshold: 0,
  },
  dataset: 'eng.1 + esp.1 · 2026-08-15 → 2026-11-22',
  fittedAt: '2026-11-24T11:04:51.966Z',
  limitations: [
    'Ajustement SANS fuite temporelle : la forme récente ne contient que des matchs antérieurs à la rencontre prédite (correction du 2026-11-23). L’ajustement précédent, obtenu avec une forme incluant des matchs postérieurs, était optimiste et a été remplacé.',
    'Sur cet échantillon, le poids de modèle ajusté vaut 0 : le marché dé-viggué seul est au moins aussi bon que le mélange. La calibration reste PROVISOIRE tant que l’échantillon de référence n’est pas élargi à plusieurs saisons et plusieurs divisions.',
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) ni la pondération du onze titulaire : les statistiques de joueur et les titulaires ne sont pas stockés dans le jeu de données de référence (ils seraient collectés après la rencontre). Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de 236 rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Évalué HORS ÉCHANTILLON (validation croisée à 5 blocs), le modèle calibré obtient une log-loss de 0.9593 contre 0.9585 pour le marché dé-viggué : sur cet échantillon, la calibration NE FAIT PAS MIEUX QUE LE MARCHÉ. La valeur in-sample (0.9585) est optimiste et ne doit jamais être citée seule.',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec 0 pari(s) sur l’échantillon (ROI —), ce seuil reste indicatif et n’est PAS une preuve de rentabilité : il doit être réajusté sur un échantillon plus large.',
    'Le signal « valeur » est INACTIF tant qu’aucun seuil n’est démontré (valueThresholdDemonstrated = false) : sans seuil démontré, tout écart strictement positif serait déclaré « valeur », y compris le simple bruit de calcul d’un mélange dont le poids de modèle est nul.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
    'L’échantillon couvre deux championnats (eng.1 + esp.1) mais un seul jeu de paramètres : ceux-ci sont communs aux deux divisions.',
  ],
};

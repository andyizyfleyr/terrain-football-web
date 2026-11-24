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
    intercept: -2.34046,
    separation: 0.82525,
    agreement: 0.36141,
    marketPick: 3.01814,
  },
  confidenceBins: [
    { min: 0, max: 0.15, probability: 0.1429, samples: 3 },
    { min: 0.15, max: 0.3, probability: 0.16, samples: 46 },
    { min: 0.3, max: 0.45, probability: 0.3846, samples: 74 },
    { min: 0.45, max: 0.6, probability: 0.4737, samples: 72 },
    { min: 0.6, max: 1.01, probability: 0.7778, samples: 41 },
  ],
  metrics: {
    sampleSize: 236,
    league: 'eng.1 + esp.1',
    period: '2026-08-15 → 2026-11-22',
    modelLogLoss: 1.0612,
    marketLogLoss: 0.9585,
    calibratedLogLoss: 0.9592,
    calibratedLogLossInSample: 0.9585,
    crossValidationFolds: 5,
    walkForwardLogLoss: 0.9684,
    walkForwardEvaluated: 189,
    naiveLogLoss: 1.0853,
    brier: 0.5699,
    accuracy: 0.4449,
    valueRoi: null,
    valueBets: 0,
    valueThreshold: 0,
    // Validation à grande échelle (football-data.co.uk).
    scaleValidation: {
      sampleSize: 14608,
      leagues: 'eng.1, esp.1, ita.1, deu.1, fra.1',
      period: '2008-08-09 → 2016-05-17',
      modelLogLoss: 1.0173,
      calibratedLogLoss: 0.977,
      marketLogLoss: 0.9768,
      pinnacleLogLoss: 0.9701,
      accuracy: 0.531,
      brier: 0.194,
      valueBets: 0,
      valueRoi: null,
      valueDemonstrated: false,
    },
  },
  dataset: 'eng.1 + esp.1 · 2026-08-15 → 2026-11-22',
  fittedAt: '2026-11-24T12:45:44.762Z',
  limitations: [
    'Ajustement SANS fuite temporelle : la forme récente ne contient que des matchs antérieurs à la rencontre prédite (correction du 2026-11-23). L’ajustement précédent, obtenu avec une forme incluant des matchs postérieurs, était optimiste et a été remplacé.',
    'Sur cet échantillon, le poids de modèle ajusté vaut 0 : le marché dé-viggué seul est au moins aussi bon que le mélange. La calibration reste PROVISOIRE tant que l’échantillon de référence n’est pas élargi à plusieurs saisons et plusieurs divisions.',
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) ni la pondération du onze titulaire : les statistiques de joueur et les titulaires ne sont pas stockés dans le jeu de données de référence (ils seraient collectés après la rencontre). Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de 236 rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Évalué HORS ÉCHANTILLON (validation croisée à 5 blocs), le modèle calibré obtient une log-loss de 0.9592 contre 0.9585 pour le marché dé-viggué : sur cet échantillon, la calibration NE FAIT PAS MIEUX QUE LE MARCHÉ. La valeur in-sample (0.9585) est optimiste et ne doit jamais être citée seule.',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec 0 pari(s) sur l’échantillon (ROI —), ce seuil reste indicatif et n’est PAS une preuve de rentabilité : il doit être réajusté sur un échantillon plus large.',
    'Le signal « valeur » est INACTIF tant qu’aucun seuil n’est démontré (valueThresholdDemonstrated = false) : sans seuil démontré, tout écart strictement positif serait déclaré « valeur », y compris le simple bruit de calcul d’un mélange dont le poids de modèle est nul.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
    'L’échantillon couvre deux championnats (eng.1 + esp.1) mais un seul jeu de paramètres : ceux-ci sont communs aux deux divisions.',
    'VALIDATION À GRANDE ÉCHELLE (football-data.co.uk, 14608 rencontres, 5 championnats, 8 saisons, cotes Bet365 et Pinnacle) : le modèle calibré atteint une log-loss de 0.977 contre 0.9768 pour la moyenne de marché dé-vigguée. Le modèle pur (non calibré) atteint 1.0173, soit mieux que le tirage aléatoire (1,0986) mais moins bon que le marché. CONCLUSION : à cette échelle, le modèle n\'est PAS meilleur que le marché, et aucun pari à « valeur » ne survit au seuil de 2 points (0 pari retenu). Ce rejeu ne dispose ni des xG ni des statistiques de joueurs : c\'est une borne INFÉRIEURE de la performance du moteur de production, et un échantillon 60 fois plus grand que celui du calibrage publié.',
    'Les cotes employées dans cette validation sont des cotes d\'OUVERTURE (avant le coup d\'envoi) : l\'archive football-data.co.uk ne publie pas de cotes de clôture pour les saisons 0809 à 1516. Les conclusions sur la marge des bookmakers doivent donc être formulées en référence à des cotes d\'ouverture.',
    'Deux défauts de référence ont été corrigés grâce à cette validation : (1) sans données xG, la référence de buts attendus était rétrécie vers une moyenne de xG nulle, ce qui faisait s\'effondrer les buts attendus (0,53 au lieu de 1,63) ; (2) l\'absence de données tactiques était traitée comme un style « peu offensif » (tempo 0,88), ce qui retirait 12 % des buts attendus alors que la moyenne réelle du championnat est de 2,76. Une donnée absente n\'est jamais traitée comme une preuve.',
  ],
};

/* ------------------------------------------------------------------ */
/* PARAMÈTRES DE CALIBRATION (ajustés sur backtest walk-forward)       */
/* ------------------------------------------------------------------ */
/*
 * Ces paramètres ne sont PAS des constantes choisies à la main : ils sont
 * ajustés par `npm run check:backtest -- --write` sur le jeu de données de
 * référence (app/lib/backtestDataset.ts), puis versionnés ici.
 *
 * Le jeu de données est un backtest walk-forward : chaque match est rejoué
 * avec la seule information disponible avant son coup d'envoi.
 *
 * Pour ouvrir un nouveau calibrage :
 *   1. rafraîchir le jeu de données (route /api/backtest-data) ;
 *   2. lancer `npm run check:backtest -- --write` pour réécrire ce fichier ;
 *   3. vérifier que les métriques ne se dégradent pas.
 *
 * Ajustement du 2026-11-23 sur 109 rencontres
 * (eng.1 · 2026-08-21 → 2026-11-22).
 */

import type { CalibrationParams } from './calibration';

export const DEFAULT_CALIBRATION: CalibrationParams = {
  version: '3.0',
  modelWeight: 0.22,
  sharpness: 0.55,
  valueThreshold: 0.02,
  effectiveSampleSize: 66,
  logistic: {
    intercept: -0.80504,
    separation: 0,
    agreement: 0,
    marketPick: 1.24878,
  },
  confidenceBins: [
    { min: 0, max: 0.15, probability: 0.075, samples: 0 },
    { min: 0.15, max: 0.3, probability: 0.225, samples: 0 },
    { min: 0.3, max: 0.45, probability: 0.4336, samples: 109 },
    { min: 0.45, max: 0.6, probability: 0.525, samples: 0 },
    { min: 0.6, max: 1.01, probability: 0.805, samples: 0 },
  ],
  metrics: {
    sampleSize: 109,
    league: 'eng.1',
    period: '2026-08-21 → 2026-11-22',
    modelLogLoss: 1.0857,
    marketLogLoss: 1.0291,
    calibratedLogLoss: 1.0244,
    naiveLogLoss: 1.2713,
    brier: 0.6149,
    accuracy: 0.4404,
    valueRoi: 0.0784,
    valueBets: 51,
    valueThreshold: 0.02,
  },
  dataset: 'eng.1 · 2026-08-21 → 2026-11-22',
  fittedAt: '2026-11-23T20:03:33.113Z',
  limitations: [
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) : ces données ne sont pas reconstructibles à la date du match sans introduire de fuite temporelle. Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de 109 rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec 51 pari(s) sur l’échantillon, ce seuil est indicatif et doit être réajusté sur un échantillon plus large.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
  ],
};

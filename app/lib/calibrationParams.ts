/* ------------------------------------------------------------------ */
/* PARAMÈTRES DE CALIBRATION (ajustés sur backtest walk-forward)       */
/* ------------------------------------------------------------------ */
/*
 * Ces paramètres ne sont PAS des constantes choisies à la main : ils sont
 * ajustés par `npm run check:backtest` sur le jeu de données de référence
 * (app/lib/backtestDataset.ts), puis versionnés ici.
 *
 * Le jeu de données est un backtest walk-forward : chaque match est rejoué
 * avec la seule information disponible avant son coup d'envoi.
 *
 * Pour ouvrir un nouveau calibrage :
 *   1. rafraîchir le jeu de données (route /api/backtest-data) ;
 *   2. lancer `npm run check:backtest -- --write` pour réécrire ce fichier ;
 *   3. vérifier que les métriques ne se dégradent pas.
 *
 * Tant que le backtest n'a pas été rejoué sur des données réelles, les
 * valeurs ci-dessous constituent le PRÉCALIBRAGE (valeurs de référence
 * documentées), et le rapport l'indique explicitement.
 */

import type { CalibrationParams } from './calibration';

export const DEFAULT_CALIBRATION: CalibrationParams = {
  version: '3.0-précalibrage',
  modelWeight: 0.62,
  sharpness: 1.02,
  valueThreshold: 0.06,
  effectiveSampleSize: 60,
  logistic: { intercept: 0.18, separation: 1.35, agreement: 0.45 },
  confidenceBins: [
    { min: 0, max: 0.15, probability: 0.35, samples: 0 },
    { min: 0.15, max: 0.3, probability: 0.42, samples: 0 },
    { min: 0.3, max: 0.45, probability: 0.48, samples: 0 },
    { min: 0.45, max: 0.6, probability: 0.55, samples: 0 },
    { min: 0.6, max: 1.01, probability: 0.66, samples: 0 },
  ],
  metrics: {
    sampleSize: 0,
    league: 'eng.1',
    period: 'précalibrage',
    modelLogLoss: 0,
    marketLogLoss: null,
    calibratedLogLoss: 0,
    naiveLogLoss: 0,
    brier: 0,
    accuracy: 0,
    valueRoi: null,
    valueBets: 0,
    valueThreshold: 0.06,
  },
  dataset: 'Précalibrage (aucun backtest embarqué)',
  fittedAt: '',
};

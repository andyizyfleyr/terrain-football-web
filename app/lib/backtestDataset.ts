/* ------------------------------------------------------------------ */
/* JEU DE DONNÉES DE RÉFÉRENCE (backtest)                              */
/* ------------------------------------------------------------------ */
/*
 * Ce fichier contient le jeu de données sur lequel les paramètres de
 * calibration sont ajustés. Il est récolté par la route /api/backtest-data
 * (relecture des matchs terminés : score, score à la mi-temps, xG, xGOT,
 * tirs, absences, compositions, cotes, arbitre, météo, surface).
 *
 * Il est VERSIONNÉ dans le dépôt : le calibrage doit être reproductible
 * hors ligne, à l'identique, par `npm run check:backtest`.
 *
 * Structure d'un match : une seule rencontre de championnat, avec
 * l'identifiant, la date, les équipes, le résultat, les xG, le score à la
 * mi-temps, les cotes 1X2 (décimales) et les absences/compositions.
 */

import type { BacktestDataset } from './backtest';

export const BACKTEST_DATASET: BacktestDataset = {
  league: 'eng.1',
  period: 'à compléter',
  teams: [],
  matches: [],
};

/* ------------------------------------------------------------------ */
/* JEU DE DONNÉES DE RÉFÉRENCE — ÉCHANTILLON MULTI-CHAMPIONNATS        */
/* ------------------------------------------------------------------ */
/*
 * Union des deux jeux de référence collectés sur la même fenêtre :
 *
 *   - Premier League (eng.1) — 109 rencontres, 20 équipes,
 *     2026-08-21 → 2026-11-22 ;
 *   - La Liga (esp.1) — 127 rencontres, 20 équipes,
 *     2026-08-15 → 2026-11-22.
 *
 * Total : 236 rencontres, 40 équipes, un seul fournisseur de cotes
 * (Bet365) sur les deux championnats, la même politique anti-fuite
 * temporelle et les mêmes garde-fous de collecte.
 *
 * Le replay walk-forward est conduit LIGUE PAR LIGUE : le classement,
 * les moyennes de buts et les xG ne sont jamais mélangés entre
 * championnats (voir app/lib/backtest.ts). Les rencontres des deux
 * Divisions sont ensuite réunies par date pour l'ajustement des
 * paramètres (poids du marché, température, seuil de valeur, confiance).
 *
 * Échantillon multi-championnats = la calibration est mesurée sur deux
 * styles de championnat (plus physique, plus technique) plutôt que sur
 * un seul : c'est la condition pour parler d'une calibration
 * « générale » et non « propre à une league ».
 */

import type { BacktestDataset } from './backtest';
import { BACKTEST_DATASET } from './backtestDataset';
import { BACKTEST_DATASET_LALIGA } from './backtestDatasetLaLiga';

export const COMBINED_BACKTEST_DATASET: BacktestDataset = {
  league: 'eng.1 + esp.1',
  leagues: ['eng.1', 'esp.1'],
  period: '2026-08-15 → 2026-11-22',
  teams: [...BACKTEST_DATASET.teams, ...BACKTEST_DATASET_LALIGA.teams],
  matches: [...BACKTEST_DATASET.matches, ...BACKTEST_DATASET_LALIGA.matches],
};

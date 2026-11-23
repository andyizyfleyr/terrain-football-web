/* ------------------------------------------------------------------ */
/* JEU DE DONNÉES DE RÉFÉRENCE — CALIBRAGE EMPIRIQUE                   */
/* ------------------------------------------------------------------ */
/*
 * Eng.1 (Premier League), saison 2026/2027 : 109 rencontres terminées
 * entre le 2026-08-21 et le 2026-11-22.
 *
 * Collecte : /api/backtest-data?format=lean&provider=Bet365_Spain
 * Source : FotMob — score, score à la mi-temps, xG, xGOT, cotes Bet365,
 * absences, confirmation des compositions, arbitre, météo, surface.
 *
 * Politique ANTI-FUITE TEMPORELLE (voir app/lib/backtest.ts) :
 *   - classement, forme et xG reconstruits à partir des seules
 *     rencontres ANTÉRIEURES ;
 *   - totaux de saison (équipes et joueurs) exclus de l'ajustement car
 *     collectés après coup ;
 *   - absences et confirmation des compositions conservées (information
 *     disponible avant le coup d'envoi) ;
 *   - cotes relevées avant le coup d'envoi, fournisseur unique (Bet365).
 *
 * Couverture : cotes 109/109 · xG 109/109 · score à la mi-temps 101/109 ·
 * compositions confirmées 109/109 · absences 47/109 · arbitre 109/109 ·
 * météo 109/109 · surface 109/109.
 *
 * Part des buts marqués en 1re période (mesurée sur cet échantillon) :
 * 42.2 % — le moteur l'estime lui-même sur les rencontres antérieures.
 */

import type { BacktestDataset, BacktestMatch, BacktestTeamSnapshot } from './backtest';

/** Colonnes des lignes brutes (ordre de la collecte). */
const COLUMNS = [
  'id', 'date', 'homeId', 'homeName', 'awayId', 'awayName',
  'homeGoals', 'awayGoals', 'homeXg', 'awayXg', 'htHome', 'htAway',
  'homeXgot', 'awayXgot', 'odds', 'referee', 'weather', 'pitch',
  'unavailableHome', 'unavailableAway', 'lineupHome', 'lineupAway', 'provider',
] as const;

type RawRow = [
  string, string, number, string, number, string,
  number, number, number | null, number | null, number | null, number | null,
  number | null, number | null, [number, number, number] | null,
  [number, number, number] | null, [number, number, number] | null, string | null,
  number[], number[], boolean, boolean, string | null,
];

const RAW: RawRow[] = [
  ["5795363","2026-08-21",9825,"Arsenal",8669,"Coventry",3,0,1.88,0.2,2,0,2.44,0.04,[1.18,7.5,13],[3.91,21.03,0.3],[15,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795364","2026-08-22",8667,"Hull",10260,"Man United",2,0,1.01,1.83,2,0,1.93,0.6,[9,5,1.33],[4.4,22.21,0.16],[18,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795365","2026-08-22",8668,"Everton",9826,"Crystal Palace",2,0,1.12,1.96,1,0,1.65,0.94,[2.38,3.4,3],[3.33,20.17,0.08],[18,6,0],"grass",[1203512],[],true,true,"Bet365 Espagne"],
  ["5795366","2026-08-22",9902,"Ipswich",8472,"Sunderland",2,1,1.8,0.66,1,1,1.63,0.35,[2.9,3.25,2.55],[3.83,23.31,0.11],[21,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795367","2026-08-22",10203,"Nottm Forest",8463,"Leeds",0,1,0.66,0.47,0,0,0.33,0.53,[2.5,3.2,2.9],[4.33,22.67,0.28],[21,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795368","2026-08-22",9937,"Brentford",8586,"Tottenham",3,0,3.87,0.57,2,0,3.12,0.61,[2,3.9,3.5],[3.83,23.2,0.09],[21,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795369","2026-08-23",10204,"Brighton",10252,"Aston Villa",4,0,3.77,0.29,4,0,3.59,0,[2.1,3.5,3.3],[3.96,21.51,0.27],[21,4,0],"grass",[1352713],[268375,671331],true,true,"Bet365 Espagne"],
  ["5795370","2026-08-23",8456,"Man City",8678,"Bournemouth",2,1,2.25,0.65,0,1,2.68,1.7,[1.45,4.5,7],[3.86,20.24,0.24],[23,2,0],"grass",[1174337],[439369],true,true,"Bet365 Espagne"],
  ["5795371","2026-08-23",10261,"Newcastle",8650,"Liverpool",2,2,1.58,2.98,1,0,1.56,2.97,[3.9,3.9,1.85],[4.43,21.77,0.23],[19,4,0],"grass",[],[1310118],true,true,"Bet365 Espagne"],
  ["5795372","2026-08-24",9879,"Fulham",8455,"Chelsea",2,3,1.33,2.24,1,2,1.17,2.02,[3.6,3.5,2.05],[4.71,20.81,0.25],[18,3,0],"grass",[503659],[917802],true,true,"Bet365 Espagne"],
  ["5795429","2026-08-28",9826,"Crystal Palace",8456,"Man City",1,4,0.66,2.21,0,1,0.05,3.08,[5,4.2,1.62],[3.44,22.42,0.24],[18,4,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795431","2026-08-29",8650,"Liverpool",10203,"Nottm Forest",2,2,1.75,2.3,0,1,2.02,1.28,[1.48,4.75,6],[4.11,19.62,0.27],[17,4,0.25],"grass",[1310118],[],true,true,"Bet365 Espagne"],
  ["5795425","2026-08-29",8678,"Bournemouth",8668,"Everton",1,1,2.16,1.84,1,0,1.9,1.41,[2.2,3.5,3.25],[4.43,22.07,0.19],[19,9,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795428","2026-08-29",8669,"Coventry",8667,"Hull",0,1,1.29,0.72,0,0,1.33,0.5,[1.73,3.9,4.75],[3.94,21.15,0.26],[17,1,1.27],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795434","2026-08-29",8586,"Tottenham",10261,"Newcastle",0,2,1.12,0.72,0,0,0.91,0.69,[2.15,3.75,3.1],[3.98,21.55,0.26],[19,5,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795427","2026-08-30",8455,"Chelsea",10204,"Brighton",4,3,2.93,1.41,3,1,2.6,2.61,[1.83,3.8,4],[3.8,23.37,0.11],[22,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795430","2026-08-30",8463,"Leeds",9937,"Brentford",1,1,1.46,1.67,0,1,1.17,0.81,[2.8,3.4,2.45],[4.5,23.5,0.1],[19,4,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795433","2026-08-30",8472,"Sunderland",9879,"Fulham",1,0,2.02,0.95,0,0,1.33,0,[2.2,3.3,3.4],[3.69,22.21,0.35],[21,3,0],"grass",[1664716],[],true,true,"Bet365 Espagne"],
  ["5795432","2026-08-30",10260,"Man United",9902,"Ipswich",5,2,4.77,2.06,1,1,4.7,2.49,[1.36,5.5,7.5],[3.51,21.65,0.27],[18,2,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795426","2026-08-31",10252,"Aston Villa",9825,"Arsenal",0,1,0.33,1.04,0,0,0,0.8,[6.5,4.33,1.48],[3.84,20.29,0.24],[15,3,0],"grass",[1174672,671331],[],true,true,"Bet365 Espagne"],
  ["5795441","2026-09-04",9902,"Ipswich",8650,"Liverpool",0,2,0.75,0.69,0,2,0.76,1.94,[5,4.2,1.6],[4.35,22.13,0.16],[16,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795443","2026-09-05",10261,"Newcastle",8678,"Bournemouth",2,2,0.71,1.37,1,2,1.67,2,[2.1,3.6,3.2],[4.26,22.67,0.29],[18,7,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795436","2026-09-05",9937,"Brentford",8472,"Sunderland",1,1,1.21,1.71,0,0,1.07,0.89,[1.67,3.9,4.75],[3.85,21.09,0.29],[23,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795437","2026-09-05",10204,"Brighton",8463,"Leeds",1,1,2.19,2.49,0,1,0.68,1.9,[1.95,3.5,3.75],[4.53,22.03,0.26],[20,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795439","2026-09-05",9879,"Fulham",9826,"Crystal Palace",2,3,3.14,1.97,2,1,1.81,2.57,[2.1,3.25,3.5],[4.15,19.7,0.28],[23,3,0],"grass",[],[1669629],true,true,"Bet365 Espagne"],
  ["5795442","2026-09-05",8456,"Man City",8669,"Coventry",1,0,2.12,1.37,1,0,1.41,1.76,[1.17,7.5,14],[3.15,20.15,0.08],[19,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795444","2026-09-05",10203,"Nottm Forest",8586,"Tottenham",0,0,0.92,1.06,null,null,0.01,0,[2.63,3.25,2.63],[3.52,21.58,0.29],[20,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795440","2026-09-05",8667,"Hull",10252,"Aston Villa",0,0,0.57,1.93,null,null,0.17,0.08,[3.9,3.6,1.9],[3.78,23.48,0.11],[18,3,0],"grass",[],[1174672],true,true,"Bet365 Espagne"],
  ["5795438","2026-09-06",8668,"Everton",10260,"Man United",2,2,1.01,0.69,0,0,1.09,0.93,[3.6,3.75,1.91],[4.72,20.73,0.24],[24,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795435","2026-09-06",9825,"Arsenal",8455,"Chelsea",2,1,2.05,0.39,1,1,2,0.35,[1.67,3.75,4.75],[4.39,22.13,0.19],[24,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795445","2026-09-12",8678,"Bournemouth",9937,"Brentford",2,2,1.75,0.5,1,1,1.65,0.22,[2.3,3.5,2.88],[3.79,20.53,0.24],[19,8,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795446","2026-09-12",10252,"Aston Villa",10203,"Nottm Forest",1,2,0.82,2.28,0,0,0.9,2.34,[2.2,3.3,3.25],[3.43,22.71,0.24],[20,4,0],"grass",[1174672],[],true,true,"Bet365 Espagne"],
  ["5795447","2026-09-12",8455,"Chelsea",8667,"Hull",2,2,0.91,1.38,1,2,1.74,1.56,[1.18,7,12],[3.74,23.05,0.11],[24,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795449","2026-09-12",9826,"Crystal Palace",9902,"Ipswich",2,3,0.62,1.68,1,2,0.51,3.81,[2.1,3.4,3.3],[4.42,22.11,0.18],[23,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795451","2026-09-12",8650,"Liverpool",9879,"Fulham",0,0,1.28,0.7,null,null,0.9,0.41,[1.47,4.5,6],[3.89,21.43,0.31],[21,7,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795454","2026-09-12",8586,"Tottenham",8668,"Everton",0,0,0.69,1.11,null,null,0.25,0.69,[1.95,3.5,3.6],[4.34,22.25,0.16],[22,4,0],"grass",[976506],[],true,true,"Bet365 Espagne"],
  ["5795453","2026-09-12",8472,"Sunderland",9825,"Arsenal",0,2,1.8,1.88,0,0,1.66,1.91,[6.5,3.6,1.57],[4.77,21.67,0.23],[17,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795448","2026-09-13",8669,"Coventry",10204,"Brighton",0,5,1.33,2.81,0,1,1.95,3.64,[3.75,3.7,1.9],[3.5,22.2,0.1],[22,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795452","2026-09-13",10260,"Man United",8456,"Man City",0,1,1,1.1,0,0,0.28,0.97,[3,3.6,2.2],[3.75,23.07,0.11],[22,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795450","2026-09-14",8463,"Leeds",10261,"Newcastle",4,1,1.99,0.88,3,0,2.91,1.14,[2.3,3.4,3],[3.63,22.26,0.33],[21,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795456","2026-09-18",9937,"Brentford",8455,"Chelsea",3,0,2.65,0.83,0,0,3.66,0.23,[2.5,3.6,2.55],[3.51,22.81,0.23],[17,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795464","2026-09-19",8586,"Tottenham",10252,"Aston Villa",2,3,1.56,1.26,0,1,2.32,2.14,[1.9,3.6,3.9],[4,19.52,0.28],[22,6,0],"grass",[976506],[],true,true,"Bet365 Espagne"],
  ["5795457","2026-09-19",10204,"Brighton",9825,"Arsenal",3,0,1.31,1.63,2,0,2.04,1.08,[5,3.8,1.65],[4.29,22.24,0.16],[18,8,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795458","2026-09-19",8668,"Everton",9902,"Ipswich",1,0,2.24,1.44,1,0,1.38,0.53,[1.73,3.75,4.5],[4.56,22.02,0.23],[18,8,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795462","2026-09-19",10261,"Newcastle",8667,"Hull",2,1,1.44,1.59,2,0,1.75,1.44,[1.57,4.2,5],[3.7,21,0.2],[17,8,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795463","2026-09-19",10203,"Nottm Forest",8669,"Coventry",0,1,1.1,0.67,0,0,0.08,0.23,[1.62,3.75,5.5],[3.74,20.53,0.24],[18,5,0],"grass",[],[643717],true,true,"Bet365 Espagne"],
  ["5795455","2026-09-20",8678,"Bournemouth",8650,"Liverpool",0,1,0.79,1.65,0,0,0.84,1.01,[3.1,3.6,2.15],[3.65,23.18,0.11],[21,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795460","2026-09-20",8463,"Leeds",9826,"Crystal Palace",0,0,1.31,1.06,null,null,0.87,0.99,[1.62,3.9,5],[3.7,22.24,0.15],[18,6,0],"grass",[],[696646],true,true,"Bet365 Espagne"],
  ["5795461","2026-09-20",8456,"Man City",8472,"Sunderland",5,3,2.82,3.57,3,2,2.23,2.81,[1.3,5,9.5],[4.28,23.41,0.28],[17,4,0],"grass",[815006],[600524],true,true,"Bet365 Espagne"],
  ["5795459","2026-09-20",9879,"Fulham",10260,"Man United",1,1,1.62,1.6,0,0,1.49,1.06,[3.5,3.6,2],[3.96,21.34,0.26],[19,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795465","2026-10-10",9825,"Arsenal",8463,"Leeds",2,1,2.33,0.62,0,0,2.11,1.83,[1.4,4.5,7.5],[3.14,20.43,0.07],[15,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795466","2026-10-10",10252,"Aston Villa",9937,"Brentford",2,2,2.28,1.06,1,1,2.47,0.59,[2.5,3.5,2.55],[3.51,22.27,0.27],[13,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795467","2026-10-10",8455,"Chelsea",8678,"Bournemouth",5,1,1.1,1.38,2,0,2.3,1.43,[1.8,3.9,4],[3.87,19.49,0.29],[16,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795471","2026-10-10",9902,"Ipswich",9879,"Fulham",2,1,1.15,1.81,0,0,1.79,0.75,[3,3.4,2.35],[3.57,20.26,0.12],[14,7,0],"grass",[1265626],[],true,true,"Bet365 Espagne"],
  ["5795474","2026-10-10",8472,"Sunderland",10204,"Brighton",0,2,0.72,1.41,null,null,0.51,1.39,[3,3.3,2.3],[3.81,21.36,0.31],[13,9,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795473","2026-10-10",10260,"Man United",8586,"Tottenham",1,1,0.8,1.62,0,0,0.61,1.38,[1.67,4.1,4.5],[4.56,21.88,0.23],[11,3,0],"grass",[],[976506],true,true,"Bet365 Espagne"],
  ["5795469","2026-10-11",9826,"Crystal Palace",10203,"Nottm Forest",3,1,2.41,3.34,2,1,3.31,2.06,[2.8,3.25,2.5],[3.89,21.33,0.24],[16,3,0],"grass",[696646],[],true,true,"Bet365 Espagne"],
  ["5795470","2026-10-11",8667,"Hull",8668,"Everton",2,2,1.33,1.68,0,0,1.17,1.69,[4.1,3.3,1.91],[3.61,22.21,0.32],[15,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795472","2026-10-11",8650,"Liverpool",8456,"Man City",0,3,0.94,1.28,0,0,0.68,1.69,[3.5,3.6,2],[4.23,21.92,0.19],[13,4,0],"grass",[],[815006],true,true,"Bet365 Espagne"],
  ["5795468","2026-10-12",8669,"Coventry",10261,"Newcastle",4,1,1.47,1.84,1,0,2.62,0.43,[3.6,3.6,1.95],[4.9,21.97,0.3],[17,2,0],"grass",[643717],[],true,true,"Bet365 Espagne"],
  ["5795478","2026-10-17",8668,"Everton",8455,"Chelsea",0,2,0.43,1.47,0,0,0.7,2.13,[2.88,3.6,2.25],[3.27,21.2,0.07],[13,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795476","2026-10-17",9937,"Brentford",8650,"Liverpool",1,2,0.88,1.64,1,0,0.95,1.23,[2.75,3.5,2.38],[4.81,21.68,0.32],[13,4,0],"grass",[],[956683],true,true,"Bet365 Espagne"],
  ["5795479","2026-10-17",9879,"Fulham",8667,"Hull",1,0,1.38,0.16,1,0,0.54,0,[1.62,4,5],[4.26,22.13,0.19],[13,4,0],"grass",[1339269],[],true,true,"Bet365 Espagne"],
  ["5795481","2026-10-17",8456,"Man City",9902,"Ipswich",3,2,3.35,1.86,2,1,2.41,1.8,[1.2,6.5,11],[3.79,23.05,0.1],[12,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795482","2026-10-17",10261,"Newcastle",10252,"Aston Villa",0,1,0.99,1.57,0,1,0.25,1.05,[2.1,3.5,3.25],[3.58,20.47,0.21],[8,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795475","2026-10-18",8678,"Bournemouth",8472,"Sunderland",2,0,4.23,0.07,1,0,2.89,0,[2,3.2,3.9],[3.6,22.48,0.26],[13,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795477","2026-10-18",10204,"Brighton",9826,"Crystal Palace",5,0,2,0.77,3,0,3.03,0.05,[1.4,4.5,7],[4.03,23.55,0.26],[11,6,0.76],"grass",[],[696646],true,true,"Bet365 Espagne"],
  ["5795480","2026-10-18",8463,"Leeds",10260,"Man United",1,1,1.41,0.92,0,1,0.99,1.05,[2.5,3.25,2.75],[4.33,22.27,0.16],[12,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795483","2026-10-18",10203,"Nottm Forest",9825,"Arsenal",0,1,0.9,1.14,0,0,0.12,0.19,[7,4.1,1.47],[3.48,23.17,0.11],[11,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795484","2026-10-19",8586,"Tottenham",8669,"Coventry",3,1,0.86,0.77,1,0,1.32,0.19,[1.5,4.33,5.5],[3.48,22.74,0.21],[12,0,0],"grass",[620618,976506],[],true,true,"Bet365 Espagne"],
  ["5795491","2026-10-23",9902,"Ipswich",10203,"Nottm Forest",1,1,0.46,2.29,1,1,1.04,1.05,[3.2,3.3,2.2],[3.73,21.32,0.3],[9,10,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795486","2026-10-24",10252,"Aston Villa",8456,"Man City",2,1,0.61,1.56,1,0,0.46,2.68,[4.75,4.5,1.57],[3.89,21.36,0.24],[9,7,0.76],"grass",[760320],[],true,true,"Bet365 Espagne"],
  ["5795485","2026-10-24",9825,"Arsenal",8668,"Everton",2,0,1.96,0.63,1,0,2.26,0.48,[1.33,5,9],[3.76,20.79,0.24],[12,5,4.32],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795488","2026-10-24",8669,"Coventry",9879,"Fulham",0,1,0.51,0.55,0,0,0.47,1.01,[3.3,3.5,2.1],[3.86,22.43,0.17],[11,6,2.03],"grass",[],[773991],true,true,"Bet365 Espagne"],
  ["5795487","2026-10-24",8455,"Chelsea",8586,"Tottenham",0,2,0.47,0.74,0,0,0.35,1.12,[1.85,3.75,3.9],[4.24,22.33,0.19],[14,5,3.3],"grass",[],[620618,976506],true,true,"Bet365 Espagne"],
  ["5795489","2026-10-25",9826,"Crystal Palace",10261,"Newcastle",0,2,1.59,0.95,0,0,0.86,1.27,[2.55,3.4,2.63],[3.5,21.31,0.06],[13,8,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795490","2026-10-25",8667,"Hull",9937,"Brentford",1,1,1.57,1.74,1,0,0.9,1.68,[5,4,1.62],[4.05,23.58,0.24],[12,10,0],"grass",[],[688273,1157236],true,true,"Bet365 Espagne"],
  ["5795492","2026-10-25",8650,"Liverpool",10204,"Brighton",2,0,1.2,1.32,2,0,1.25,0.3,[1.95,3.75,3.6],[3.87,19.78,0.29],[10,14,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795493","2026-10-25",10260,"Man United",8678,"Bournemouth",0,3,1.17,2.15,0,2,0.34,2.81,[2.4,3.4,2.8],[3.69,20.59,0.21],[10,9,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795494","2026-10-25",8472,"Sunderland",8463,"Leeds",0,0,0.83,0.76,null,null,0.85,0.84,[2.63,3.1,2.75],[4.61,22.05,0.23],[9,10,0],"grass",[754126],[],true,true,"Bet365 Espagne"],
  ["5795498","2026-10-31",8455,"Chelsea",10260,"Man United",2,0,3.01,1.24,0,0,2.53,0.3,[2.2,3.5,3],[3.98,21.72,0.24],[16,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795495","2026-10-31",8678,"Bournemouth",8463,"Leeds",2,0,1.29,0.71,1,0,3.04,0.45,[1.95,3.3,3.8],[3.55,22.1,0.31],[13,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795497","2026-10-31",9937,"Brentford",10203,"Nottm Forest",2,0,0.46,0.86,1,0,0.66,0.1,[2.1,3.5,3.3],[4.24,22.31,0.13],[13,2,0],"grass",[1157236],[],true,true,"Bet365 Espagne"],
  ["5795499","2026-10-31",8669,"Coventry",8472,"Sunderland",3,1,0.69,1.82,2,0,1.43,0.88,[3,3.3,2.38],[4.26,21.06,0.18],[11,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795500","2026-10-31",8667,"Hull",9902,"Ipswich",2,2,0.78,1.06,0,1,0.82,0.88,[2.88,3.25,2.38],[4.26,21.68,0.16],[11,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795502","2026-10-31",8456,"Man City",10204,"Brighton",0,1,1.64,1,0,1,1.07,1.53,[1.67,4,4.5],[3.52,22.43,0.26],[12,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795504","2026-10-31",8586,"Tottenham",9826,"Crystal Palace",2,0,3.47,0.14,1,0,3.11,0.08,[1.62,4,4.75],[3.43,23.19,0.11],[10,1,0],"grass",[620618,976506],[],true,true,"Bet365 Espagne"],
  ["5795496","2026-10-31",10252,"Aston Villa",9879,"Fulham",1,1,1.83,2.24,1,0,0.62,1.87,[1.95,3.6,3.7],[3.83,19.83,0.28],[6,1,0],"grass",[760320],[773991],true,true,"Bet365 Espagne"],
  ["5795501","2026-11-01",8650,"Liverpool",9825,"Arsenal",0,1,1.05,0.98,0,1,0,1.44,[3,3.3,2.3],[3.48,22.83,0.21],[10,2,0],"grass",[],[1635773],true,true,"Bet365 Espagne"],
  ["5795503","2026-11-02",10261,"Newcastle",8668,"Everton",0,1,1.29,2.34,0,0,0.2,2.38,[2.15,3.4,3.3],[4.93,21.7,0.3],[8,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795508","2026-11-06",8668,"Everton",8669,"Coventry",3,1,1.43,1.21,0,0,2.09,0.74,[1.62,3.9,5],[4.61,22.3,0.23],[9,1,1.27],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795511","2026-11-07",8463,"Leeds",8586,"Tottenham",1,0,1.96,0.72,0,0,1.21,1.42,[2.75,3.25,2.5],[4.87,21.3,0.3],[12,1,0],"grass",[],[976506],true,true,"Bet365 Espagne"],
  ["5795505","2026-11-07",9825,"Arsenal",8667,"Hull",1,0,1.26,0.36,0,0,1.17,0.73,[1.11,9,21],[3.79,23.05,0.1],[9,0,0],"grass",[1635773],[280507],true,true,"Bet365 Espagne"],
  ["5795509","2026-11-07",9879,"Fulham",10261,"Newcastle",1,1,0.7,1.14,0,0,1.24,1.45,[1.95,3.75,3.5],[3.87,21.21,0.24],[9,0,0],"grass",[],[1021929],true,true,"Bet365 Espagne"],
  ["5795513","2026-11-07",10203,"Nottm Forest",8456,"Man City",3,1,1.06,1.76,2,0,1.71,0.8,[5,4.1,1.6],[3.83,19.81,0.3],[7,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795506","2026-11-08",10204,"Brighton",9937,"Brentford",2,0,2.11,0.59,2,0,2.34,0,[1.8,3.9,4],[3.42,23.21,0.11],[11,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795507","2026-11-08",9826,"Crystal Palace",8650,"Liverpool",1,3,2.6,2.65,0,1,2.54,2.17,[5.5,4.5,1.5],[3.79,20.75,0.25],[9,2,0],"grass",[706297],[],true,true,"Bet365 Espagne"],
  ["5795510","2026-11-08",9902,"Ipswich",8678,"Bournemouth",0,2,1.26,2.23,0,1,1.14,1.64,[3.6,3.7,1.95],[3.26,21.17,0.2],[11,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795514","2026-11-08",8472,"Sunderland",8455,"Chelsea",1,0,2.38,0.66,1,0,1.22,0.24,[3,3.4,2.2],[3.73,20.83,0.2],[9,1,0],"grass",[751998],[],true,true,"Bet365 Espagne"],
  ["5795512","2026-11-08",10260,"Man United",10252,"Aston Villa",4,4,3.55,2.88,2,2,4.39,2.63,[1.95,3.9,3.3],[4.13,22.37,0.19],[8,0,0],"grass",[847983],[729731],true,true,"Bet365 Espagne"],
  ["5795522","2026-11-21",8456,"Man City",9879,"Fulham",1,1,1.87,0.74,0,1,0.46,1,[1.33,5,8],[3.65,21.16,0.3],[9,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795515","2026-11-21",8678,"Bournemouth",10203,"Nottm Forest",2,0,2.89,1.99,2,0,2.88,0.64,[2.1,3.4,3.75],[3.89,22.53,0.17],[11,4,0],"grass",[1158512,1027447,1449690],[1622290,827315,846383],true,true,"Bet365 Espagne"],
  ["5795516","2026-11-21",10252,"Aston Villa",8472,"Sunderland",0,0,1.03,0.25,null,null,0.39,0.28,[1.7,3.75,4.75],[3.52,22.74,0.21],[7,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5795518","2026-11-21",8455,"Chelsea",8463,"Leeds",1,4,0.64,2.77,1,1,0.51,2.1,[1.91,3.5,3.8],[3.42,23.09,0.13],[9,1,0],"grass",[1413846,950485,807729,1113692,1021382],[1344677],true,true,"Bet365 Espagne"],
  ["5795519","2026-11-21",8669,"Coventry",9826,"Crystal Palace",3,2,2.06,1.73,2,2,1.8,2.01,[2.45,3.3,2.75],[4.2,22.18,0.13],[7,3,0],"grass",[],[706297],true,true,"Bet365 Espagne"],
  ["5795524","2026-11-21",8586,"Tottenham",9902,"Ipswich",2,0,2.65,0.47,1,0,3.93,0.63,[1.45,4.75,6.25],[3.82,23.18,0.23],[8,2,0],"grass",[976506],[],true,true,"Bet365 Espagne"],
  ["5795523","2026-11-21",10261,"Newcastle",9825,"Arsenal",2,2,1.71,1.49,0,1,1.29,1.42,[6,4.33,1.5],[4.09,22.45,0.22],[-1,0,0],"grass",[],[1635773],true,true,"Bet365 Espagne"],
  ["5795520","2026-11-22",8667,"Hull",10204,"Brighton",2,0,1.83,2.23,0,0,2.37,1.46,[6.5,4.5,1.44],[4.09,22.16,0.27],[8,3,0],"grass",[1331703,538112,1178514,915102,1515977],[1068482,862608,1423616,1782648],true,true,"Bet365 Espagne"],
  ["5795521","2026-11-22",8650,"Liverpool",10260,"Man United",4,0,4.35,0.65,2,0,3.68,0.32,[1.8,4,3.9],[3.79,19.77,0.3],[6,2,0],"grass",[1113690,1609209,956683,1197030],[362694,1352713,1035614,1073977,696365],true,true,"Bet365 Espagne"],
];

const TEAM_ROWS: [number, string][] = [
  [9825,"Arsenal"],
  [8669,"Coventry"],
  [8667,"Hull"],
  [10260,"Man United"],
  [8668,"Everton"],
  [9826,"Crystal Palace"],
  [9902,"Ipswich"],
  [8472,"Sunderland"],
  [10203,"Nottm Forest"],
  [8463,"Leeds"],
  [9937,"Brentford"],
  [8586,"Tottenham"],
  [10204,"Brighton"],
  [10252,"Aston Villa"],
  [8456,"Man City"],
  [8678,"Bournemouth"],
  [10261,"Newcastle"],
  [8650,"Liverpool"],
  [9879,"Fulham"],
  [8455,"Chelsea"],
];

function decode(row: RawRow): BacktestMatch {
  const odds = row[14];
  const referee = row[15];
  const weather = row[16];
  return {
    id: row[0],
    date: row[1],
    league: 'eng.1',
    homeId: row[2],
    homeName: row[3],
    awayId: row[4],
    awayName: row[5],
    homeGoals: row[6],
    awayGoals: row[7],
    homeXg: row[8],
    awayXg: row[9],
    htHome: row[10],
    htAway: row[11],
    homeShots: null,
    awayShots: null,
    homeXgot: row[12],
    awayXgot: row[13],
    odds: odds ? { home: odds[0], draw: odds[1], away: odds[2] } : null,
    provider: row[22],
    unavailableHome: row[18],
    unavailableAway: row[19],
    startersHome: [],
    startersAway: [],
    lineupConfirmedHome: row[20],
    lineupConfirmedAway: row[21],
    referee: referee
      ? {
          yellowPerMatch: referee[0],
          foulsPerMatch: referee[1],
          penaltiesPerMatch: referee[2],
        }
      : null,
    weather: weather
      ? { temperature: weather[0], windSpeed: weather[1], precipitation: weather[2] }
      : null,
    pitch: row[17] ? { surface: row[17] } : null,
  };
}

export const BACKTEST_DATASET: BacktestDataset = {
  league: 'eng.1',
  period: '2026-08-21 → 2026-11-22',
  teams: TEAM_ROWS.map(
    ([id, name]): BacktestTeamSnapshot => ({ id, name, stats: {}, players: [] })
  ),
  matches: RAW.map(decode),
};

/** Part des buts en 1re période mesurée sur le jeu de données. */
export const MEASURED_FIRST_HALF_SHARE = 0.4223;

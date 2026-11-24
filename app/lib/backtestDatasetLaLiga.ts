/* ------------------------------------------------------------------ */
/* JEU DE DONNÉES DE RÉFÉRENCE — LA LIGA (ESP.1), SAISON 2026/2027       */
/* ------------------------------------------------------------------ */
/*
 * Premier League écarté, ce second jeu de données couvre 127 rencontres
 * terminées de La Liga entre le 2026-08-15 et le 2026-11-22 (20 équipes).
 *
 * Collecte : /api/backtest-data?leagueId=87&format=lean&provider=Bet365_Spain
 * Source : FotMob — score, score à la mi-temps, xG, xGOT, cotes Bet365,
 * absences, confirmation des compositions, arbitre, météo, surface.
 *
 * MÊME POLITIQUE ANTI-FUITE TEMPORELLE que le jeu Premier League
 * (voir app/lib/backtest.ts) :
 *   - classement, forme et xG reconstruits à partir des seules
 *     rencontres ANTÉRIEURES de LA LIGA (jamais de l'autre championnat) ;
 *   - totaux de saison (équipes et joueurs) exclus de l'ajustement car
 *     collectés après coup ;
 *   - absences et CONFIRMATION des compositions conservées (information
 *     disponible avant le coup d'envoi) ;
 *   - cotes relevées avant le coup d'envoi, fournisseur unique (Bet365) ;
 *   - ARBITRE et MÉTÉO collectés mais NON UTILISÉS par le rejeu : le
 *     profil d'arbitre est un cumul de carrière lu à la date de collecte
 *     (il inclut les matchs postérieurs à la rencontre), et la météo
 *     collectée est la météo RÉELLE du match, pas la prévision
 *     d'avant-match. Impact mesuré de leur retrait : log-loss modèle
 *     1,0576 → 1,0573, soit négligeable.
 *
 * COMPOSITIONS ET JOUEURS — ce qui est stocké, et pourquoi c'est peu :
 *   - le drapeau « compositions confirmées » est stocké pour les 127
 *     rencontres ;
 *   - les TITULAIRES ne sont PAS stockés (identifiants vides) et les
 *     EFFECTIFS nominatifs non plus : les statistiques de joueur
 *     (xG, xA, minutes, note) sont des instantanés collectés après la
 *     rencontre, donc inutilisables sans introduire une fuite
 *     temporelle. Le moteur rejoué en backtest joue donc sans la
 *     pondération du onze titulaire ;
 *   - les joueurs ABSENTS sont conservés : information annoncée avant le
 *     coup d'envoi.
 *
 * Couverture : cotes 127/127 · xG 127/127 · score à la mi-temps 115/127 ·
 * compositions confirmées 127/127 · absences 76/127 · arbitre 122/127 ·
 * météo 127/127 · surface 127/127.
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

const TEAM_ROWS: [number, string][] = [
  [8302, "Sevilla"],
  [8305, "Getafe"],
  [8315, "Athletic Club"],
  [8370, "Rayo Vallecano"],
  [8371, "Osasuna"],
  [8558, "Espanyol"],
  [8560, "Real Sociedad"],
  [8581, "Levante"],
  [8603, "Real Betis"],
  [8633, "Real Madrid"],
  [8634, "Barcelona"],
  [8696, "Racing Santander"],
  [9783, "Deportivo A Coruña"],
  [9864, "Málaga"],
  [9866, "Deportivo Alavés"],
  [9906, "Atlético Madrid"],
  [9910, "Celta Vigo"],
  [10205, "Villarreal"],
  [10267, "Valencia"],
  [10268, "Elche"],
];

const RAW: RawRow[] = [
  ["5868011","2026-08-15",9866,"Deportivo Alavés",8305,"Getafe",3,0,1.93,0.24,0,0,2.35,0.09,[2.35,2.75,3.8],null,[21,4,0],"grass",[845067],[],true,true,"Bet365 Espagne"],
  ["5868019","2026-08-15",8302,"Sevilla",8370,"Rayo Vallecano",2,1,2.19,1.89,0,1,1.8,1.77,[2.45,2.9,3.3],null,[26,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868015","2026-08-16",8558,"Espanyol",8581,"Levante",3,0,1.47,0.19,2,0,2.27,0,[2.1,3.2,3.75],null,[30,2,0],"grass",[169586,1381560],[1286471],true,true,"Bet365 Espagne"],
  ["5868017","2026-08-16",8696,"Racing Santander",10205,"Villarreal",2,2,1.87,0.67,2,2,1.39,1.42,[3.9,3.75,1.9],null,[24,2,0],"grass",[],[1695966],true,true,"Bet365 Espagne"],
  ["5868012","2026-08-19",9906,"Atlético Madrid",9864,"Málaga",2,0,0.92,0.15,0,0,2.64,0.02,[1.45,4.6,7],[4.38,23.88,0.33],[30,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868029","2026-08-20",8370,"Rayo Vallecano",9866,"Deportivo Alavés",1,1,0.42,2,0,0,1.01,1.33,[2.25,3.1,3.5],[4.44,25.85,0.26],[26,4,0],"grass",[],[845067],true,true,"Bet365 Espagne"],
  ["5868023","2026-08-21",8603,"Real Betis",8560,"Real Sociedad",1,0,1.24,1.36,0,0,2.5,0.52,[2.05,3.25,3.3],[4.84,25.19,0.32],[26,2,0],"grass",[1022354],[],true,true,"Bet365 Espagne"],
  ["5868021","2026-08-22",8315,"Athletic Club",8302,"Sevilla",1,3,1.37,1.26,0,1,1.3,1.65,[1.7,3.3,4.75],[4.59,23.5,0.28],[28,4,0],"grass",[],[1327489],true,true,"Bet365 Espagne"],
  ["5868025","2026-08-22",8558,"Espanyol",8633,"Real Madrid",1,2,1.05,2.71,1,1,0.47,1.98,[7,4.5,1.36],[4.83,26.68,0.4],[25,4,0],"grass",[1381560,169586],[],true,true,"Bet365 Espagne"],
  ["5868030","2026-08-22",10267,"Valencia",9910,"Celta Vigo",0,0,0.7,0.62,null,null,0.14,0.06,[2.3,2.9,3],[5.23,24.22,0.33],[28,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868022","2026-08-23",9906,"Atlético Madrid",10205,"Villarreal",2,2,0.78,3.6,0,0,0.89,2.91,[1.73,3.6,4.2],[5.49,24.55,0.46],[33,6,0],"grass",[],[1695966],true,true,"Bet365 Espagne"],
  ["5868024","2026-08-23",10268,"Elche",8634,"Barcelona",0,5,0.7,4.38,0,2,0.26,4.32,[8,5,1.29],[4.57,26.43,0.46],[27,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868026","2026-08-23",8305,"Getafe",8696,"Racing Santander",1,0,1.24,1.31,0,0,0.99,1.2,[2.2,2.9,3.3],[4.89,28.47,0.31],[31,6,0],"grass",[175311],[],true,true,"Bet365 Espagne"],
  ["5868027","2026-08-24",9864,"Málaga",9783,"Deportivo A Coruña",1,1,1.95,1.12,1,1,1.32,1.17,[2.3,2.88,3.1],[3.58,27.03,0.47],[27,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868028","2026-08-24",8371,"Osasuna",8581,"Levante",0,0,0.7,1.28,null,null,0.98,0.17,[1.87,3.2,4.2],[4.11,24.74,0.29],[27,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868020","2026-08-25",10267,"Valencia",8603,"Real Betis",0,1,1.12,0.71,0,0,1.13,0.55,[2.5,3.1,2.63],[4.43,24.94,0.35],[28,4,0],"grass",[],[1022354],true,true,"Bet365 Espagne"],
  ["5868018","2026-08-26",8633,"Real Madrid",8560,"Real Sociedad",4,1,3.18,0.65,1,1,4.27,0.87,[1.14,7,13],[5.7,25.2,0.32],[23,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868013","2026-08-27",9910,"Celta Vigo",8371,"Osasuna",1,2,0.14,2.6,1,0,0.3,1.34,[1.75,3.2,4.6],[3.71,22.14,0.33],[18,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868016","2026-08-27",8634,"Barcelona",8315,"Athletic Club",2,0,4.23,0.25,1,0,3.85,0,[1.17,6.5,11],[3.92,21.84,0.16],[28,2,0.25],"grass",[],[80295],true,true,"Bet365 Espagne"],
  ["5868031","2026-08-28",9866,"Deportivo Alavés",10205,"Villarreal",1,0,0.73,1.74,1,0,0.77,0.66,[3,3.25,2.2],[4.79,25.06,0.32],[17,2,0],"grass",[845067],[],true,true,"Bet365 Espagne"],
  ["5868037","2026-08-28",8696,"Racing Santander",10268,"Elche",3,2,1.72,1.03,3,0,2.18,1.9,[1.95,3.4,3.5],[3.6,25.34,0.42],[22,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868035","2026-08-29",8581,"Levante",8603,"Real Betis",5,2,2.76,1.92,2,2,4.42,1.5,[3.1,3.1,2.2],[3.81,22.88,0.35],[29,3,0],"grass",[],[1022354],true,true,"Bet365 Espagne"],
  ["5868039","2026-08-29",8560,"Real Sociedad",8558,"Espanyol",2,1,1.94,0.77,1,1,3.07,0.77,[1.8,3.4,4],[5.93,26.94,0.34],[24,2,0],"grass",[],[1381560,169586],true,true,"Bet365 Espagne"],
  ["5868040","2026-08-29",8302,"Sevilla",9906,"Atlético Madrid",1,3,0.9,0.93,0,3,0.68,1.24,[3.9,3.3,1.9],[3.63,26.94,0.5],[27,3,0],"grass",[],[609516],true,true,"Bet365 Espagne"],
  ["5868032","2026-08-30",9910,"Celta Vigo",8315,"Athletic Club",0,2,0.75,2.78,0,2,0.32,2.83,[2.7,2.9,2.63],[5.78,24.97,0.3],[18,1,0],"grass",[196169],[],true,true,"Bet365 Espagne"],
  ["5868033","2026-08-30",9783,"Deportivo A Coruña",10267,"Valencia",3,1,1.42,1.4,2,1,0.7,1.53,[2.63,2.8,2.8],[3.89,21.75,0.16],[19,4,0],"grass",[],[673356],true,true,"Bet365 Espagne"],
  ["5868038","2026-08-30",8633,"Real Madrid",9864,"Málaga",4,0,2.62,0.71,3,0,3.26,0.05,[1.06,11,20],[4.89,28.55,0.33],[32,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868034","2026-08-31",8634,"Barcelona",8370,"Rayo Vallecano",5,2,3.04,1.21,2,1,3.07,2.23,[1.06,10.5,20],[4,24.47,0.32],[26,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868036","2026-08-31",8371,"Osasuna",8305,"Getafe",1,0,1.68,0.68,1,0,1.01,0.22,[2.05,2.75,4],[4.49,24.94,0.36],[19,6,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868070","2026-09-03",8560,"Real Sociedad",9910,"Celta Vigo",0,0,1.05,0.43,null,null,1.04,0.11,[1.75,3.5,4.33],[4.16,24.63,0.27],[21,0,0],"grass",[27204],[],true,true,"Bet365 Espagne"],
  ["5868043","2026-09-04",8603,"Real Betis",8633,"Real Madrid",1,0,0.93,3.46,0,0,0.92,2.98,[6,4.75,1.4],[5.51,24.56,0.51],[34,2,0],"grass",[1022354],[],true,true,"Bet365 Espagne"],
  ["5868042","2026-09-05",8315,"Athletic Club",9906,"Atlético Madrid",3,0,1.41,1.02,0,0,1.23,1.24,[2.63,3.1,2.5],[4.5,25.88,0.24],[29,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868048","2026-09-05",8370,"Rayo Vallecano",8696,"Racing Santander",3,2,1.61,0.48,2,2,2.13,1.29,[1.91,3.4,3.7],[4.43,26.39,0.49],[30,5,0],"grass",[],[1586390],true,true,"Bet365 Espagne"],
  ["5868050","2026-09-05",10205,"Villarreal",9783,"Deportivo A Coruña",2,3,1.2,0.83,1,1,1.48,1.23,[1.4,4.5,6],[5.05,24.52,0.32],[26,1,0],"grass",[],[1256478],true,true,"Bet365 Espagne"],
  ["5868041","2026-09-06",9866,"Deportivo Alavés",8371,"Osasuna",5,2,1.2,1.64,2,0,3.37,1.88,[2.15,2.9,3.5],[4.76,26.65,0.35],[28,5,0],"grass",[845067],[],true,true,"Bet365 Espagne"],
  ["5868045","2026-09-06",8558,"Espanyol",8302,"Sevilla",1,1,1.23,0.53,0,0,1.38,0.9,[2.25,3,3.2],[3.59,26.95,0.36],[27,1,0],"grass",[1381560,839893],[],true,true,"Bet365 Espagne"],
  ["5868047","2026-09-06",9864,"Málaga",8581,"Levante",0,0,1.59,0.98,null,null,1.06,0.94,[2.3,3.1,2.9],[5.35,27.3,0.17],[28,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868049","2026-09-06",10267,"Valencia",8634,"Barcelona",0,5,0.66,4.08,0,2,0.56,5.08,[10,6,1.2],[4.82,25,0.32],[31,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868044","2026-09-07",10268,"Elche",8560,"Real Sociedad",2,3,2.37,0.57,0,2,1.96,1.52,[3,3.3,2.2],[3.87,21.67,0.15],[28,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868046","2026-09-07",8305,"Getafe",9910,"Celta Vigo",1,1,0.65,1.03,1,0,0.92,1.21,[2.75,2.5,3],[4.64,23.6,0.28],[33,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868059","2026-09-11",8302,"Sevilla",10267,"Valencia",1,0,0.93,0.1,0,0,0.75,0,[1.75,3.3,4.6],[5.71,24.97,0.29],[29,3,0],"grass",[1244272],[],true,true,"Bet365 Espagne"],
  ["5868051","2026-09-12",8315,"Athletic Club",10268,"Elche",1,1,1.61,0.84,0,0,0.6,1.86,[1.33,4.6,7],[5.88,26.94,0.33],[23,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868055","2026-09-12",8371,"Osasuna",8558,"Espanyol",0,2,1.05,1.43,0,2,0.53,1.66,[2.15,3,3.4],[5.35,27.3,0.17],[27,6,0],"grass",[],[1381560,839893],true,true,"Bet365 Espagne"],
  ["5868056","2026-09-12",8696,"Racing Santander",9866,"Deportivo Alavés",2,1,2.01,1.98,1,1,2.13,2.11,[2.63,3.25,2.5],[3.68,26.21,0.47],[22,6,0],"grass",[],[845067],true,true,"Bet365 Espagne"],
  ["5868057","2026-09-12",8633,"Real Madrid",8370,"Rayo Vallecano",4,1,2.62,1.21,3,0,2.95,1.35,[1.1,8.5,15],[4.18,24.67,0.26],[27,1,0],"grass",[],[1284430,797901],true,true,"Bet365 Espagne"],
  ["5868052","2026-09-13",9910,"Celta Vigo",9864,"Málaga",1,1,1.9,0.43,1,0,1.36,0.67,[1.65,3.5,5],[3.6,25.34,0.43],[32,2,0],"grass",[],[1209421,1573563],true,true,"Bet365 Espagne"],
  ["5868053","2026-09-13",8305,"Getafe",9783,"Deportivo A Coruña",1,1,0.78,0.87,0,0,0.94,0.67,[2.5,2.75,2],[3.76,22.68,0.34],[32,1,0],"grass",[1118199],[],true,true,"Bet365 Espagne"],
  ["5868054","2026-09-13",8581,"Levante",8634,"Barcelona",2,4,2.42,2.58,0,2,2.46,3.67,[12,7.5,1.13],[4.55,24.94,0.32],[28,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868058","2026-09-13",8560,"Real Sociedad",9906,"Atlético Madrid",0,3,0.27,2.05,0,0,0.49,1.95,[3.3,3.4,2],[4.89,28.1,0.33],[20,1,0],"grass",[1523234],[],true,true,"Bet365 Espagne"],
  ["5868060","2026-09-14",10205,"Villarreal",8603,"Real Betis",1,2,1.88,3.75,1,2,2.84,3.96,[1.87,3.75,3.4],[3.92,24.18,0.32],[24,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868061","2026-09-15",9866,"Deportivo Alavés",10267,"Valencia",0,1,1.04,0.79,0,0,0.35,0.82,[1.67,3.4,5],[3.65,27.09,0.35],[18,5,0],"grass",[845067],[],true,true,"Bet365 Espagne"],
  ["5868065","2026-09-15",10268,"Elche",8633,"Real Madrid",2,3,0.78,3.61,0,2,1.32,2.09,[11,6.5,1.15],[5.03,24.62,0.31],[23,0,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868069","2026-09-15",8370,"Rayo Vallecano",8558,"Espanyol",2,1,1.71,1.65,1,0,0.93,1.15,[2.15,3,3.3],[4.79,24.66,0.31],[32,3,0],"grass",[797901],[1381560,839893],true,true,"Bet365 Espagne"],
  ["5868062","2026-09-16",9906,"Atlético Madrid",8371,"Osasuna",4,0,3.97,0.48,1,0,3.91,0.31,[1.25,5,9.5],[3.74,23.91,0.32],[23,7,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868064","2026-09-16",9783,"Deportivo A Coruña",8302,"Sevilla",0,1,0.14,0.73,0,0,0.95,0.92,[2.75,3.1,2.75],[5.55,24.55,0.53],[19,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868066","2026-09-16",8634,"Barcelona",8696,"Racing Santander",7,2,6.74,1.98,4,1,4.41,1.5,[1.04,13,23],[4.41,25.54,0.23],[21,4,2.29],"grass",[],[777028],true,true,"Bet365 Espagne"],
  ["5868063","2026-09-17",8603,"Real Betis",8305,"Getafe",1,0,1.89,0.29,0,0,2.02,0.33,[1.44,3.9,6.5],[4.71,26.67,0.37],[26,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868068","2026-09-17",9864,"Málaga",10205,"Villarreal",1,3,0.57,3.2,1,2,0.88,2.65,[3.3,3.4,2],null,[23,3,0],"grass",[1573563,801120],[],true,true,"Bet365 Espagne"],
  ["5868075","2026-09-18",8558,"Espanyol",10268,"Elche",1,3,1.05,1.61,0,2,0.48,2.05,[1.73,3.5,4.4],[4.53,24.94,0.33],[22,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868071","2026-09-19",8315,"Athletic Club",9866,"Deportivo Alavés",0,0,1.62,0.05,null,null,0.98,0,[1.57,3.6,5.5],[4.1,24.59,0.28],[26,3,0],"grass",[],[845067],true,true,"Bet365 Espagne"],
  ["5868073","2026-09-19",9910,"Celta Vigo",8696,"Racing Santander",5,0,2.14,0.75,2,0,3.67,0.25,[1.75,3.6,4.2],[3.71,22.74,0.31],[25,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868077","2026-09-19",8371,"Osasuna",8370,"Rayo Vallecano",1,1,0.53,1.01,1,0,0.79,0.42,[2.63,2.9,2.63],[5.88,26.94,0.33],[27,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868078","2026-09-19",8302,"Sevilla",8634,"Barcelona",1,3,0.4,3.47,1,1,0.81,1.62,[8.5,6,1.22],[4.83,27.91,0.31],[29,2,0],"grass",[1398377],[],true,true,"Bet365 Espagne"],
  ["5868072","2026-09-20",9906,"Atlético Madrid",8633,"Real Madrid",2,1,2.35,0.3,0,0,2.87,0.43,[3.4,3.6,1.91],[3.92,21.53,0.15],[30,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868074","2026-09-20",9783,"Deportivo A Coruña",8603,"Real Betis",1,1,2.09,0.8,0,1,2.16,0.67,[3.7,3.5,1.91],[4.72,23.42,0.28],[26,2,0],"grass",[603537],[],true,true,"Bet365 Espagne"],
  ["5868076","2026-09-20",8305,"Getafe",9864,"Málaga",1,0,0.95,0.52,0,0,1.24,0.58,[1.83,3.1,4.5],[3.71,27.37,0.46],[30,2,0],"grass",[1321605],[1573563,801120],true,true,"Bet365 Espagne"],
  ["5868079","2026-09-20",10267,"Valencia",8560,"Real Sociedad",2,3,1.59,2.71,0,1,1.05,2.68,[2.75,3.1,2.4],[4.43,25.47,0.3],[24,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868080","2026-09-20",10205,"Villarreal",8581,"Levante",3,1,4.27,0.45,1,1,2.96,0.51,[1.5,4.2,5],[5.61,24.82,0.29],[25,1,0],"grass",[],[1254218],true,true,"Bet365 Espagne"],
  ["5868086","2026-10-09",9864,"Málaga",8558,"Espanyol",1,1,0.69,1.08,0,1,0.77,0.82,[2.88,3.2,2.6],[3.68,23.8,0.32],[21,1,0],"grass",[801120],[1381560,839893],true,true,"Bet365 Espagne"],
  ["5868081","2026-10-10",9866,"Deportivo Alavés",9906,"Atlético Madrid",1,2,1.3,2.05,1,1,1.12,1.1,[4.4,3.5,1.75],[4.34,26.41,0.51],[21,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868084","2026-10-10",8634,"Barcelona",8305,"Getafe",3,0,1.93,0.14,2,0,1.7,0.23,[1.08,9,17],[5.05,24.74,0.3],[22,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868089","2026-10-10",8633,"Real Madrid",10205,"Villarreal",1,0,1.43,0.59,0,0,1.42,1,[1.3,5,7.5],[4.73,24.67,0.27],[19,2,0],"grass",[1367619],[],true,true,"Bet365 Espagne"],
  ["5868082","2026-10-11",8603,"Real Betis",8371,"Osasuna",5,2,2.89,1.94,2,0,3.44,2.97,[1.4,4.2,6.5],[3.63,25.34,0.45],[25,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868083","2026-10-11",10268,"Elche",9910,"Celta Vigo",0,0,0.78,0.47,null,null,0.42,0,[3.2,3.25,2.3],[3.83,27.5,0.47],[26,4,0],"grass",[1277343],[],true,true,"Bet365 Espagne"],
  ["5868087","2026-10-11",8696,"Racing Santander",10267,"Valencia",2,2,1.29,1.8,1,1,2.31,1.35,[2.3,3.4,3],[5.35,27.3,0.17],[19,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868090","2026-10-11",8560,"Real Sociedad",9783,"Deportivo A Coruña",3,2,1.44,2.13,2,0,2.54,1.55,[1.75,3.75,4.5],[3.71,26.83,0.33],[22,1,0],"grass",[1097229],[1384883],true,true,"Bet365 Espagne"],
  ["5868085","2026-10-12",8581,"Levante",8302,"Sevilla",3,3,1.82,2.2,0,1,2.95,2.34,[3,3.25,2.4],[4.34,24,0.31],[25,1,0],"grass",[1254218],[1398377],true,true,"Bet365 Espagne"],
  ["5868093","2026-10-16",9783,"Deportivo A Coruña",8581,"Levante",1,1,1.08,0.79,0,0,1.09,1,[2,3.25,3.5],[6.03,26.94,0.32],[17,4,0],"grass",[1425989,1384883],[1254218],true,true,"Bet365 Espagne"],
  ["5868091","2026-10-17",8603,"Real Betis",8634,"Barcelona",2,5,1.24,3.1,1,2,1.9,4.9,[6,5,1.33],[3.87,22.77,0.37],[23,5,0.25],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868094","2026-10-17",8558,"Espanyol",9906,"Atlético Madrid",0,1,0.53,1.47,0,0,0.62,1.7,[5,3.75,1.62],[5.54,24.74,0.51],[25,4,0],"grass",[1381560],[],true,true,"Bet365 Espagne"],
  ["5868099","2026-10-17",10267,"Valencia",8315,"Athletic Club",0,0,1.41,0.59,null,null,0.55,0.1,[3.1,3,2.25],[4.44,24,0.31],[22,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868100","2026-10-17",10205,"Villarreal",10268,"Elche",0,0,2.39,0.3,null,null,0.9,0.25,[1.4,5,6.5],[4,24.71,0.32],[24,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868092","2026-10-18",9910,"Celta Vigo",9866,"Deportivo Alavés",2,1,0.97,1.06,0,0,1.6,1.97,[2.1,2.9,3.5],[4.36,25.72,0.31],[24,3,0],"grass",[],[1563022],true,true,"Bet365 Espagne"],
  ["5868096","2026-10-18",9864,"Málaga",8560,"Real Sociedad",2,5,1.24,2.44,0,2,2.19,2.95,[3.5,3.5,2],[5.35,27.3,0.17],[21,2,0],"grass",[940608],[1293912],true,true,"Bet365 Espagne"],
  ["5868097","2026-10-18",8371,"Osasuna",8696,"Racing Santander",2,0,3.65,0.28,1,0,4.52,0.01,[1.91,3.5,3.75],[4.51,27.7,0.29],[14,5,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868098","2026-10-18",8633,"Real Madrid",8302,"Sevilla",4,1,2.28,0.75,2,0,2.82,1.07,[1.18,6.5,10.5],[5.51,24.65,0.27],[11,5,0],"grass",[846033],[1130991],true,true,"Bet365 Espagne"],
  ["5868095","2026-10-19",8305,"Getafe",8370,"Rayo Vallecano",1,1,0.57,2.25,0,1,1.31,1.47,[2.9,2.8,2.5],[4.63,24.94,0.34],[13,1,0],"grass",[1203946,765693],[],true,true,"Bet365 Espagne"],
  ["5868067","2026-10-21",8581,"Levante",8315,"Athletic Club",3,1,1.82,2.04,2,0,2.79,0.98,[3.25,3.1,2.2],[4.31,26.36,0.53],[24,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868101","2026-10-23",9866,"Deportivo Alavés",9864,"Málaga",1,1,1.51,0.47,0,1,1.27,0.67,[1.55,3.7,5.5],[3.69,25.34,0.44],[9,1,0],"grass",[],[940608],true,true,"Bet365 Espagne"],
  ["5868103","2026-10-24",9906,"Atlético Madrid",9783,"Deportivo A Coruña",1,0,1.41,1.67,0,0,1.45,0.99,[1.2,6,10.5],[4.67,27.04,0.36],[14,4,0],"grass",[],[1384883],true,true,"Bet365 Espagne"],
  ["5868106","2026-10-24",8696,"Racing Santander",8558,"Espanyol",2,1,2.27,0.52,0,0,2.64,0.48,[2.15,3.5,2.88],[4.9,24.61,0.28],[17,6,0],"grass",[],[1381560],true,true,"Bet365 Espagne"],
  ["5868107","2026-10-24",8370,"Rayo Vallecano",10268,"Elche",0,3,1.52,2.52,0,2,0.67,2.56,[1.73,3.7,4.2],[3.68,26.84,0.36],[18,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868110","2026-10-24",10267,"Valencia",10205,"Villarreal",1,2,1.13,1.5,1,0,1.28,0.69,[3.4,3.3,2],[4.32,26.32,0.54],[20,3,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868102","2026-10-25",8315,"Athletic Club",8305,"Getafe",4,0,0.72,0.43,2,0,0.72,0.22,[1.5,3.75,6],[3.82,23.83,0.32],[20,1,0],"grass",[411617],[765693,421365],true,true,"Bet365 Espagne"],
  ["5868104","2026-10-25",9910,"Celta Vigo",8603,"Real Betis",0,0,0.76,1.15,null,null,0.68,0.16,[2.63,3.1,2.63],[4.79,24.57,0.26],[17,1,0],"grass",[],[1436133],true,true,"Bet365 Espagne"],
  ["5868105","2026-10-25",8634,"Barcelona",8633,"Real Madrid",1,2,1.19,1.94,0,1,1.22,2.14,[1.53,5.5,3.75],[4.53,27.76,0.31],[17,3,0],"grass",[],[846033],true,true,"Bet365 Espagne"],
  ["5868108","2026-10-25",8560,"Real Sociedad",8581,"Levante",2,1,2.22,0.48,2,1,1.91,1.02,[1.47,4.33,5.5],[3.88,27.84,0.47],[16,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868109","2026-10-26",8302,"Sevilla",8371,"Osasuna",2,0,1.17,0.61,1,0,1.24,0.03,[1.85,3.2,4.2],[3.95,21.63,0.19],[20,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868120","2026-10-30",10205,"Villarreal",8558,"Espanyol",0,1,0.88,0.22,0,0,0.84,0.66,[1.33,5,7],[4.67,26.69,0.36],[18,1,0],"grass",[844544],[1381560,839893],true,true,"Bet365 Espagne"],
  ["5868112","2026-10-31",8603,"Real Betis",9864,"Málaga",2,1,1.8,1.16,2,0,0.89,1.26,[1.25,5.5,8.5],[5.49,24.63,0.3],[22,2,0],"grass",[1436133],[940608],true,true,"Bet365 Espagne"],
  ["5868115","2026-10-31",8634,"Barcelona",9866,"Deportivo Alavés",6,1,3.26,0.76,4,0,3.61,1.03,[1.06,12,17],[4.44,24.15,0.31],[17,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868117","2026-10-31",8581,"Levante",9906,"Atlético Madrid",0,2,1.4,0.7,0,1,0.77,1.73,[6,4.5,1.4],[3.92,22.72,0.34],[19,5,0],"grass",[1052330],[],true,true,"Bet365 Espagne"],
  ["5868119","2026-10-31",8370,"Rayo Vallecano",9910,"Celta Vigo",3,0,1.09,1.39,0,0,2.16,0,[2.4,2.9,2.88],[5.8,29.6,0.2],[19,1,0],"grass",[872396],[],true,true,"Bet365 Espagne"],
  ["5868111","2026-11-01",8315,"Athletic Club",8560,"Real Sociedad",2,1,3.08,1.15,2,1,1.52,1.39,[1.87,3.5,3.7],[5.65,24.57,0.51],[13,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868114","2026-11-01",10268,"Elche",10267,"Valencia",0,1,1.26,0.79,0,0,0.67,1.35,[2.15,3.1,3.25],[5.35,27.3,0.17],[18,1,0],"grass",[],[1348497,963964],true,true,"Bet365 Espagne"],
  ["5868116","2026-11-01",8305,"Getafe",8302,"Sevilla",3,1,1.58,0.77,0,1,2.3,0.38,[3.5,2.8,2.25],[3.97,24.89,0.29],[22,1,0],"grass",[474673,1321605],[],true,true,"Bet365 Espagne"],
  ["5868118","2026-11-01",8696,"Racing Santander",8633,"Real Madrid",0,3,0.97,3.36,0,3,0.19,2.83,[10.5,8,1.14],[4.26,25.97,0.31],[14,2,0],"grass",[1670161],[846033],true,true,"Bet365 Espagne"],
  ["5868113","2026-11-02",9783,"Deportivo A Coruña",8371,"Osasuna",2,1,2.35,1.14,0,1,2.94,1.07,[1.95,3.1,3.8],[5.4,23.6,0.4],[13,3,0],"grass",[1384883],[],true,true,"Bet365 Espagne"],
  ["5868128","2026-11-06",8302,"Sevilla",9866,"Deportivo Alavés",0,0,1.6,0.54,null,null,1.46,0.38,[1.91,3.1,4.2],[5,24.4,0.2],[19,1,0],"grass",[1428849],[],true,true,"Bet365 Espagne"],
  ["5868124","2026-11-07",8558,"Espanyol",9783,"Deportivo A Coruña",0,0,0.7,0.23,null,null,0.89,0.48,[2.4,3.1,2.88],[4.3,26.34,0.57],[18,1,0],"grass",[1381560,1727689],[],true,true,"Bet365 Espagne"],
  ["5868125","2026-11-07",9864,"Málaga",8696,"Racing Santander",1,2,2.02,2.31,1,0,1.73,2.44,[2.15,3.4,2.9],[4.74,24.47,0.26],[20,3,0],"grass",[940608],[],true,true,"Bet365 Espagne"],
  ["5868126","2026-11-07",8371,"Osasuna",8315,"Athletic Club",1,1,0.65,2.28,0,0,0.54,1.69,[3.75,3.25,1.95],[3.77,26.81,0.46],[11,0,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868129","2026-11-07",10267,"Valencia",8633,"Real Madrid",0,3,0.18,2.34,0,2,0.54,3.69,[11,6,1.17],[3.74,23.89,0.29],[16,4,0],"grass",[],[846033],true,true,"Bet365 Espagne"],
  ["5868121","2026-11-08",9906,"Atlético Madrid",8634,"Barcelona",1,2,1.67,1.61,1,1,1.06,1.41,[3.4,4.2,1.8],[3.98,27.82,0.47],[14,2,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868122","2026-11-08",9910,"Celta Vigo",8581,"Levante",0,0,3.16,0.28,null,null,2.08,0,[1.75,3.4,4.4],[3.95,21.7,0.21],[22,4,0],"grass",[],[1052330],true,true,"Bet365 Espagne"],
  ["5868123","2026-11-08",10268,"Elche",8603,"Real Betis",0,2,0.84,1.78,0,0,0.09,3.31,[4,3.75,1.73],[4.74,23.47,0.29],[20,4,0],"grass",[468931],[1436133],true,true,"Bet365 Espagne"],
  ["5868127","2026-11-08",8560,"Real Sociedad",8370,"Rayo Vallecano",1,0,1.62,1.42,0,0,1.14,0.41,[1.75,3.75,4],[4.53,27.71,0.31],[21,5,0],"grass",[1426170],[],true,true,"Bet365 Espagne"],
  ["5868130","2026-11-08",10205,"Villarreal",8305,"Getafe",2,0,2.31,0.82,0,0,3.41,0.39,[1.47,4,5.5],[3.6,26,0.2],[18,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868132","2026-11-20",8315,"Athletic Club",8558,"Espanyol",0,1,1.45,0.53,0,0,1.71,0.57,[1.36,4.5,7],[5.41,24.43,0.27],[13,1,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868131","2026-11-21",9866,"Deportivo Alavés",9783,"Deportivo A Coruña",3,1,3.33,0.31,1,1,3.89,0.15,[2.1,3.4,3.6],[3.95,24.97,0.26],[11,3,1.52],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868138","2026-11-21",8370,"Rayo Vallecano",10267,"Valencia",0,1,0.74,0.66,0,1,0.41,1.29,[2,3.5,3.8],[4.23,25.76,0.33],[12,1,0],"grass",[621415,672840,956622],[1220187,391058,1284434,673937],true,true,"Bet365 Espagne"],
  ["5868139","2026-11-21",8633,"Real Madrid",9910,"Celta Vigo",2,1,3.76,1.51,0,1,1.82,1.37,[1.1,8.5,14],[4.36,24.17,0.31],[11,1,1.02],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868140","2026-11-21",8302,"Sevilla",8603,"Real Betis",1,1,2.32,0.62,0,0,0.68,0.53,[2.88,3.4,2.45],[4.73,26.73,0.36],[18,4,0],"grass",[],[],true,true,"Bet365 Espagne"],
  ["5868133","2026-11-22",8634,"Barcelona",10205,"Villarreal",3,2,3.22,0.21,0,2,1.88,0.19,[1.11,8.5,13],[5.66,24.56,0.53],[18,6,0],"grass",[1901980],[],true,true,"Bet365 Espagne"],
  ["5868134","2026-11-22",8305,"Getafe",9906,"Atlético Madrid",0,3,0.5,4.14,0,2,0.02,3.97,[6.5,4.2,1.5],[4.97,25.03,0.28],[8,1,0],"grass",[282674,1414777,178753,1580704,191873],[1842329,789066,1323897,690516],true,true,"Bet365 Espagne"],
  ["5868136","2026-11-22",8371,"Osasuna",9864,"Málaga",1,0,1.23,0.64,1,0,0.96,0,[1.75,3.7,4.5],[3.87,22.49,0.34],[10,1,0],"grass",[1752349,1323398,1603025],[1573563,839232,1717331,1669621],true,true,"Bet365 Espagne"],
  ["5868137","2026-11-22",8696,"Racing Santander",8560,"Real Sociedad",3,2,3.05,3.69,2,1,3.15,1.04,[3,3.9,2.1],[5.33,29.17,0.17],[15,8,0],"grass",[1199649,1363232,899195],[636570,730901,1002618],true,true,"Bet365 Espagne"],
];


function decode(row: RawRow): BacktestMatch {
  const odds = row[14];
  const referee = row[15];
  const weather = row[16];
  return {
    id: row[0],
    date: row[1],
    league: 'esp.1',
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

export const BACKTEST_DATASET_LALIGA: BacktestDataset = {
  league: 'esp.1',
  period: '2026-08-15 → 2026-11-22',
  teams: TEAM_ROWS.map(
    ([id, name]): BacktestTeamSnapshot => ({ id, name, stats: {}, players: [] })
  ),
  matches: RAW.map(decode),
};

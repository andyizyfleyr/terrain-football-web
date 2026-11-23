/* ------------------------------------------------------------------ */
/* VECTEURS DE RÉFÉRENCE DE LA DÉ-VIG                                 */
/* ------------------------------------------------------------------ */
/*
 * Valeurs attendues pour la dé-vig, produites par la bibliothèque de
 * référence `penaltyblog` (Shin 1992/1993) sur des cotes bookmaker réelles
 * relevées sur les flux de marché (1xBet, Bet365, Betfair, Betfred, Unibet).
 *
 * Ces vecteurs sont figés dans le dépôt pour que les tests soient
 * déterministes et ne dépendent d'aucun service externe.
 *
 *   python3 scripts/generate-devig-reference.py   # régénération ponctuelle
 */

export type DevigReferenceCase = {
  name: string;
  odds: number[];
  shin: number[] | null;
  power: number[] | null;
  z: number | null;
};

export const DEVIG_REFERENCE_CASES: DevigReferenceCase[] = [
  {
    "name": "1xBet Leeds-Coventry",
    "odds": [
      1.58,
      4.58,
      6.16
    ],
    "shin": [
      0.627385766,
      0.214210843,
      0.158403391
    ],
    "power": [
      0.628594071,
      0.213425137,
      0.157980792
    ],
    "z": 0.006815216
  },
  {
    "name": "Bet365 ManU-Brentford",
    "odds": [
      1.91,
      3.7,
      3.6
    ],
    "shin": [
      0.496800817,
      0.247915236,
      0.255283947
    ],
    "power": [
      0.500058254,
      0.246303615,
      0.253638131
    ],
    "z": 0.035949428
  },
  {
    "name": "Betfair Brentford-Everton",
    "odds": [
      2.3,
      3.4,
      3.1
    ],
    "shin": [
      0.416556755,
      0.277673834,
      0.305769411
    ],
    "power": [
      0.417537281,
      0.277137768,
      0.30532495
    ],
    "z": 0.025761967
  },
  {
    "name": "Betfred ManU-Brentford",
    "odds": [
      2,
      3.65,
      3.35
    ],
    "shin": [
      0.473331318,
      0.251294365,
      0.275374317
    ],
    "power": [
      0.476038219,
      0.249958724,
      0.274003056
    ],
    "z": 0.036351532
  },
  {
    "name": "Unibet FRA ManU-Brentford",
    "odds": [
      2.05,
      3.5,
      3.45
    ],
    "shin": [
      0.464619902,
      0.265653037,
      0.269727061
    ],
    "power": [
      0.466783197,
      0.264572658,
      0.268644145
    ],
    "z": 0.031761242
  },
  {
    "name": "Unibet FRA Liverpool-Brugge",
    "odds": [
      4.45,
      4.5,
      1.65
    ],
    "shin": [
      0.208681684,
      0.206220056,
      0.58509826
    ],
    "power": [
      0.206605106,
      0.204181025,
      0.589213869
    ],
    "z": 0.026698512
  },
  {
    "name": "Bet365 ESP Brugge-Liverpool",
    "odds": [
      4.33,
      4.75,
      1.62
    ],
    "shin": [
      0.213087211,
      0.192990002,
      0.593922787
    ],
    "power": [
      0.210500354,
      0.190767336,
      0.59873231
    ],
    "z": 0.029641538
  },
  {
    "name": "1xBet ESP ManU-Brentford",
    "odds": [
      2.02,
      4.09,
      3.62
    ],
    "shin": [
      0.489172144,
      0.239604899,
      0.271222957
    ],
    "power": [
      0.489786852,
      0.239319542,
      0.270893606
    ],
    "z": 0.00790264
  },
  {
    "name": "1xBet ESP Liverpool-Brugge",
    "odds": [
      4.72,
      4.68,
      1.7
    ],
    "shin": [
      0.207704061,
      0.209508519,
      0.58278742
    ],
    "power": [
      0.2072098,
      0.209006286,
      0.583783914
    ],
    "z": 0.00690096
  },
  {
    "name": "1xBet ESP Liverpool-ManU",
    "odds": [
      1.8,
      4,
      3.9
    ],
    "shin": [
      0.531862726,
      0.230915359,
      0.237221915
    ],
    "power": [
      0.535427706,
      0.229161236,
      0.235411058
    ],
    "z": 0.03114538
  },
  {
    "name": "Gros quasi-egalite",
    "odds": [
      2.05,
      3.4,
      3.6
    ],
    "shin": [
      0.465943332,
      0.275074224,
      0.258982443
    ],
    "power": [
      0.467990768,
      0.274043519,
      0.257965713
    ],
    "z": 0.029918105
  },
  {
    "name": "Grosse favorite",
    "odds": [
      1.1,
      8,
      15
    ],
    "shin": [
      0.862523344,
      0.095851229,
      0.041625426
    ],
    "power": [
      0.888726626,
      0.076250682,
      0.035022692
    ],
    "z": 0.057778599
  },
  {
    "name": "Deux issues",
    "odds": [
      1.78,
      2.21
    ],
    "shin": [
      0.554654533,
      0.445345467
    ],
    "power": [
      0.555011353,
      0.444988647
    ],
    "z": 0.014288874
  }
];

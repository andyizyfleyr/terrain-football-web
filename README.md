# Terrain — Football Intelligence

Moteur quantitatif de pronostics football. Le projet prédit les issues de
rencontres (1 / X / 2 et marchés dérivés), mesure sa performance contre le
marché de référence, et **publie ses limites**.

## Ce que le moteur vaut — résumé honnête

| Mesure | Valeur | Échantillon |
|---|---|---|
| Log-loss modèle calibré | **0,9770** | 14 608 rencontres (football-data.co.uk) |
| Log-loss marché dé-viggué | 0,9768 | 14 608 rencontres |
| Log-loss Pinnacle | 0,9701 | 7 295 rencontres |
| Log-loss modèle pur (non calibré) | 1,0173 | 14 608 rencontres |
| Log-loss tirage aléatoire | 1,0986 | — |
| Exactitude du modèle calibré | 53,1 % | 14 608 rencontres |
| Paris à « valeur » retenus | **0** | 14 608 rencontres |
| Seuil de valeur démontré | **non** | — |

**Conclusion : sur l’échantillon de référence, le modèle calibré n’est pas
meilleur que le marché.** L’écart (0,9770 contre 0,9768) est inférieur de
beaucoup à l’incertitude d’échantillonnage (± 0,008 d’après le bootstrap).
La détection de « valeur » est donc **désactivée** : aucun pari n’est
recommandé tant qu’aucun seuil n’est démontré empiriquement.

La courbe de fiabilité du modèle calibré est en revanche bonne
(annoncé 54,7 % → observé 54,3 % ; annoncé 64,7 % → observé 64,7 % sur
3 117 et 1 992 rencontres) : les probabilités annoncées sont **bien
calibrées**, même si elles ne sont pas meilleures que celles du marché.

## Architecture

```
app/lib/analystEngine.ts        moteur quantitatif (modules 01 à 08)
app/lib/calibration.ts          mélange modèle/marché, température, confiance
app/lib/calibrationParams.ts    paramètres PUBLICS ajustés (versionnés)
app/lib/calibrationLeagues.ts   calibration par championnat avec rétrécissement
app/lib/probabilities.ts        validation et normalisation des probabilités
app/lib/matchTraps.ts           avertissements « match piège »
app/lib/derivedMarkets.ts       registre des 16 marchés dérivés + statut
app/lib/disclosure.ts           verdict transparent calculé depuis les mesures
app/lib/apiErrors.ts            contrat d’erreur de l’API
app/lib/clientApi.ts            client HTTP du navigateur (timeouts bornés)
app/lib/backtest.ts             backtest walk-forward strict
app/lib/backtestMetrics.ts      log-loss, Brier, RPS, bootstrap, tests appariés
app/lib/backtestReplay.ts       rejeu partagé (backtest strict + ablation)
app/lib/backtestDatasetFootballData.ts   chargeur sans fuite du jeu de référence
app/api/engine/analyze/route.ts service d’analyse (POST)
app/api/analyze/route.ts        proxy public (GET)
app/api/markets/validation/     statut de validation des marchés dérivés
backend/main.py                 API d’ingestion (FastAPI, ESPN)
backend/espn.py                 client ESPN, caches bornés
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm run check` | suite de contrôles complète (devig, marché, modèle, backtest, étape 3) |
| `npm run check:step3` | contrôles des modules de l’étape 3 |
| `npm run check:tags` | contrôles des étiquettes de match (seuils, données manquantes, NaN) |
| `npm run check:backtest` | anti-fuite, marche avant, calibrage (publie les métriques) |
| `npm run check:backtest:strict` | backtest chronologique strict multi-championnat → `data/backtest-report.json` |
| `npm run check:ablation` | contribution de chaque module → `data/ablation-report.json` |
| `npm run check:markets` | validation des marchés dérivés → `data/markets-validation.json` |
| `npm run import:football-data` | import du jeu football-data.co.uk → `data/football-data/` |
| `npm run build` | build de production |

## Jeu de données de référence

`data/football-data/` — archive football-data.co.uk, 5 championnat
(Premier League, La Liga, Serie A, Bundesliga, Ligue 1), saisons 2008-09 à
2015-16, **14 608 rencontres** et 164 équipes, avec cotes Bet365 (14 604),
Pinnacle (7 295), moyenne de marché (14 607) et total de buts 2,5 (14 607).

Les colonnes `B365H/D/A` et `PSH/PSD/PSA` de ces saisons sont des **cotes
d’ouverture** (avant le coup d’envoi), pas des cotes de clôture :
l’archive ne publie pas de prix de clôture pour cette période.

## Contribution de chaque module (ablation mesurée)

Chaque module a été neutralisé tour à tour sur les 14 608 rencontres ; l'écart
est apparié (test de Student apparié). La mesure porte sur le **modèle pur** :
sur cet échantillon, le poids du modèle ajusté vaut 0, si bien que le modèle
calibré est presque entièrement déterminé par le marché et ne pourrait rien
révéler.

| Module | Contribution mesurée | p-value | Verdict |
|---|---|---|---|
| Référence championnat | +0,0142 | < 0,0001 | **contribution significative** |
| Calendrier, surface, météo | +0,0024 | < 0,0001 | **contribution significative** |
| ρ, covariance, périodes | +0,0003 | 0,36 | non significative |
| Finition, gardiens, tirs | −0,0004 | < 0,0001 | **retire de l'information** (effet négligeable : 0,04 %) |
| Absences et onze | 0,0000 | 1,00 | sans effet (données absentes du jeu de référence) |
| Confrontation tactique | 0,0000 | 1,00 | sans effet (données absentes du jeu de référence) |
| Calibration marché | 0,0000 | 1,00 | sans effet sur le 1X2 |
| Simulation Monte-Carlo | 0,0000 | 1,00 | sans effet sur le 1X2 (pronostics dérivés) |

Un delta positif signifie que le modèle est moins bon sans le module. Aucun
module n'est retiré automatiquement : ces conclusions sont des propositions.

## Marchés dérivés : ce qui est validé

| Marché | Statut | Confrontation |
|---|---|---|
| Issue 1 / X / 2 | **validé** | 14 607 rencontres · écart moyen 0,4 pt · log-loss 1,0174 contre 0,9768 |
| Plus de 2,5 buts | **validé** | 14 606 rencontres · écart moyen −1,1 pt · log-loss 0,6892 contre 0,6790 |
| Les 14 autres marchés | non validé | aucune cote de référence exploitable (ou aucune prédiction du modèle) |

Les 14 marchés non validés sont annoncés comme des **estimations du
modèle** dans l'interface : un but de la tête, le score à la mi-temps ou le
handicap asiatique n'ont pas de cote de marché à laquelle les confronter.

## Étiquettes de match

Chaque rencontre peut porter une ou plusieurs étiquettes, calculées par une
fonction pure (`app/lib/matchTags.ts`) à partir des champs réels du rapport
d’analyse. Tous les seuils sont regroupés dans `MATCH_TAG_CONFIG`.

| Étiquette | Règle | Données lues |
|---|---|---|
| 💎 Value | écart ≥ 2 % (cote ≤ 3), 5 % (3 à 6), 8 % (> 6) ; +2 % si le match est serré | `market.edges`, `market.odds`, `confidence` |
| ⚖️ Serré | meilleure probabilité < 42 % et écart entre les deux victoires < 10 pts | `market.calibrated` |
| 🏆 Favori net | favori ≥ 55 % et ≥ 25 pts d’avance sur la deuxième issue | `market.calibrated` |
| 🔥 Beaucoup de buts | buts attendus ≥ 2,9 ou +2,5 buts ≥ 60 % | `simulation.expectedGoals`, `simulation.over25` |
| 🧊 Peu de buts | buts attendus ≤ 2,2 ou +2,5 buts ≤ 40 % | `simulation.expectedGoals`, `simulation.over25` |
| ⚠️ Piège | composition non confirmée, fatigue haute, enjeu faible ou confiance basse | `absences.officialLineup`, `context`, `confidence` |

Règles tenues :

- une donnée absente n’est jamais remplacée par une supposition : l’étiquette
  est omise et un avertissement l’explique ;
- aucun nombre `NaN` n’est produit ;
- les étiquettes ne modifient **ni** les probabilités **ni** la logique du
  moteur : elles ne décrivent que ce que l’analyse mesure déjà ;
- la détection de « valeur » respecte le verdict du moteur : tant qu’aucun
  seuil de valeur n’est démontré sur l’historique de référence, aucune
  étiquette « Value » n’est annoncée.

Le scan du mois produit ces étiquettes sans appel réseau supplémentaire :
elles voyagent dans la réponse d’analyse (`matches[].tags`).

## Défauts trouvés et corrigés par cette validation

La validation à grande échelle a mis au jour deux défauts que l'échantillon
de production (236 rencontres) ne pouvait pas révéler :

1. **Référence de buts attendus.** Sans données xG, la référence était
   rétrécie vers une moyenne de xG nulle : les buts attendus s'effondraient
   (0,53 au lieu de 1,63), et le modèle annonçait 55 % de nuls contre 24 %
   observés. La référence utilise désormais la moyenne de buts réelle quand
   aucune donnée xG n'est disponible.
2. **Données tactiques absentes.** En l'absence de toute statistique de
   style, le profil par défaut était « peu offensif » (tempo 0,88), ce qui
   retirait 12 % des buts attendus alors que la moyenne réelle du
   championnat est de 2,76. Une donnée absente n'est plus traitée comme
   une preuve : le module reste neutre.

## Méthode

1. **Aucune fuite temporelle.** Chaque rencontre est rejouée avec la seule
   information disponible avant son coup d’envoi : forme récente, classement
   et statistiques sont reconstruits à partir des seules rencontres
   antérieures. L’arbitre et la météo, non rejouables, sont exclus.
2. **Marche avant stricte.** Les paramètres de calibration sont réajustés à
   chaque changement de saison sur les seules rencontres antérieures :
   aucune rencontre n’est évaluée avec une calibration qui a vu son avenir.
3. **Validation croisée temporelle.** Les blocs sont contigus dans le
   temps (pas de mélange entre passé et futur).
4. **Probabilités validées.** Tout triplet publié est vérifié (somme = 1,
   valeurs dans [0, 1]) avant d’être utilisé ou comparé.
5. **Ablation mesurée.** Chaque module peut être neutralisé ; la
   contribution est mesurée par différence appariée avec test de
   significativité. Aucune suppression n’est effectuée automatiquement.

## Confidentialité et cache

- `app/lib/fotmob.ts` : cache mémoire borné (500 entrées, expiration).
- `backend/espn.py` : caches bornés (calendrier, journées, saisons).
- Les données manquantes ne sont jamais remplacées par une supposition :
  l’absence est signalée explicitement à l’utilisateur.

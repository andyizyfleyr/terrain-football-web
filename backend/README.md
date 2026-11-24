# Backend Python — API d'analyse complète

Ce dossier contient le service Python déployé sur le projet Vercel
`terrain-football-api` (runtime FastAPI).

## Répartition des responsabilités

| Couche | Langage | Rôle |
|---|---|---|
| Ingestion | Python (`espn.py`) | Calendrier du jour, forme récente (60 j / 5 matchs), classement, splits terrain, style de jeu (moyenne sur 3 matchs) |
| Modèle | TypeScript (`app/lib/analystEngine.ts`) | Dixon-Coles, xG, calibration marché, Monte-Carlo 10 000 itérations, **16 marchés dérivés** |
| Composition | Python (`main.py`) | Collecte → appel du service d'analyse → réponse complète |

Le modèle n'est volontairement **pas** réimplémenté en Python : une seule
implémentation, donc aucun écart entre l'API et ce que voit l'utilisateur.

## Contrat

```
GET /api/analyze?league=eng.1&date=20261122[&match=401879234]
  -> { league, date, season, analysis: "complete", matches: [...], sources: [...] }
     chaque match contient `analyst` (8 modules, simulation) et
     `analyst.pronostics` (16 marchés dérivés)

GET /api/health    -> état du service et joignabilité du moteur
GET /api/meta      -> contrat de l'API
GET /api/leagues   -> catalogue des compétitions (calendrier du front)
GET /api/fixtures  -> matchs d'une journée (calendrier du front)
GET /api/analyze   -> analyse complète d'une journée ou d'un match
```

### Calendrier du front

Le front consomme deux routes pour le calendrier mensuel :

- `GET /api/leagues` : les 18 compétitions (slug ESPN, nom, pays, niveau),
  championnats nationaux et coupes d'Europe (`uefa.champions`,
  `uefa.europa`) ;
- `GET /api/fixtures?league=eng.1&date=20261122` : les matchs de la
  journée au format du front (`id`, `date`, `name`, `home`, `away`,
  `venue`, `city`).

Le calendrier demande une journée par jour du mois : les journées sont
mises en cache 5 minutes (`ESPN_DAY_CACHE_TTL`) pour ne pas envoyer une
trentaine de scoreboards à ESPN d'affilée.

Les coupes d'Europe ne publient pas de calendrier de journées mais de
**phases** (journée de ligue, barrages, 8es…). Leurs jours de match sont
donc déduits des plages de phases (`phase_calendar`, cache 12 h,
`ESPN_PHASE_CALENDAR_TTL`) ; sans cela leur calendrier serait vide et
`/api/smoke` les déclarerait cassées.

## Résilience

Si le service d'analyse est injoignable, `/api/analyze` renvoie les matchs
bruts avec `analysis: null`. Le front détecte alors l'absence d'analyse
complète et calcule l'analyse de son côté : le site reste fonctionnel.

### Accès ESPN : saison explicite et limitation de débit

ESPN impose deux contraintes que l'ingestion doit respecter :

1. **La saison doit être explicite.** Sans `?season=YYYY`, l'API renvoie le
   calendrier de la *prochaine* saison (HTTP 200, aucun match terminé) :
   la forme recentielle et l'historique domicile/extérieur seraient vides.
   `season_year()` calcule l'année de saison européenne (août → juillet) et
   le calendrier est demandé pour chaque année traversée par la fenêtre de
   forme de 60 jours.

2. **ESPN limite le débit.** Un balayage de journée demandait 2 calendriers
   + 6 résumés de style par match, soit jusqu'à ~90 requêtes : ESPN
   répondait alors 429 et la forme revenait vide. L'ingestion applique
   désormais :

   | Levier | Effet |
   |---|---|
   | Retry avec backoff (2 tentatives) sur 429/5xx/timeout | une requête échouée est rejouée au lieu de renvoyer une donnée vide |
   | Cache TTL des calendriers par (ligue, équipe, saison) | une équipe n'est téléchargée qu'une fois |
   | Concurrence limitée à 4 requêtes | plus de rafale, donc moins de limitation |
   | Timeout long (30 s) pour les calendriers de saison | les réponses lourdes (~100 Ko) ont le temps d'arriver |
   | Résumé de style réservé à la fiche du match | un balayage de journée passe de ~90 à ~22 requêtes ESPN |

   Le journal des appels (`FETCH_LOG`) est capturé **après** l'appel :
   capturé avant, il masquait les erreurs ESPN réelles.

   Diagnostic : `GET /api/debug/espn?league=eng.1&team=306`

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ENGINE_URL` | `https://terrain-football-web.vercel.app` | URL du service d'analyse (`/api/engine/analyze`) |
| `ENGINE_TOKEN` | *(vide)* | Jeton Bearer exigé par le service d'analyse si défini |
| `ESPN_TIMEOUT` | `12` | Délai de connexion ESPN (secondes) |
| `ESPN_SLOW_TIMEOUT` | `30` | Délai des calendriers de saison (secondes) |
| `ESPN_MAX_CONCURRENT` | `4` | Requêtes ESPN simultanées maximum |
| `ESPN_CACHE_TTL` | `600` | Durée de vie du cache des calendriers (secondes) |
| `ENGINE_TIMEOUT` | `120` | Délai de l'appel au moteur (secondes) |

## Tests

```bash
python3 backend/test_ingestion.py   # 46 contrôles d'ingestion (hors réseau)
python3 backend/test_api.py        # 22 contrôles de contrat et de repli
npm run smoke                      # 33 contrôles de la PRODUCTION (réseau)
```

Les contrôles sont hors réseau : ils valident la logique de collecte
(fenêtre de forme, splits, libellés, repli en l'absence de source) et le
contrat HTTP (analyse complète, repli moteur injoignable, journée vide).

### Auto-contrôle de la production

Deux niveaux complementaires de contrôle, tous deux sans coût de déploiement :

**1. `/api/smoke` — auto-contrôle quotidien (cron Vercel)**

`GET /api/smoke` rejoue une ingestion complète (calendrier, forme,
classement, style) et vérifie les invariants : catalogue des
compétitions, journée servie, forme non vide, historique alimenté,
différence de buts réelle, classement renseigné, style disponible.

- Réponse **200** si tout va bien, **500** avec la liste des
  régressions (`failed`) sinon — un échec de cron se voit donc dans le
  tableau de bord Vercel.
- Programmé par `backend/vercel.json` (cron `37 5 * * *`, une exécution
  par jour sur le plan Hobby) ; appelable à la main à tout moment.

**2. `scripts/smoke-production.mjs` — test de fumée complet (local)**

Alias `npm run smoke`. Appelle la production (API **et** site) et
vérifie 33 invariants : service vivant, moteur joignable, 16 marchés,
10 000 simulations, catalogue des compétitions, journée de calendrier
servie, forme non vide, différence de buts réelle, historique
d'équipe alimenté, bloc analyst présent, diagnostic ESPN sans erreur,
accueil rendu et fiche de match rendue (pas d'écran d'erreur Next.js).

À exécuter depuis une machine avec un accès réseau (le sandbox de
développement n'atteint pas Vercel). Bases : `API_BASE` et `WEB_BASE`
(par défaut les URL de production).

## Déploiement (Vercel)

Le service est un projet Vercel **séparé** du front (le dépôt contient les
deux : l'application Next.js est dans `app/`, le service Python dans
`backend/`).

| Réglage | Valeur |
|---|---|
| Projet Vercel | `terrain-football-api` |
| Framework | `fastapi` |
| Root directory | *(racine du dépôt)* |
| Point d'entrée | `backend/main.py` — déclaré par `[tool.vercel].entrypoint` dans le `pyproject.toml` racine |
| Dépendances | `pyproject.toml` racine (`[project].dependencies`, mêmes versions que `backend/requirements.txt`) |

Le `pyproject.toml` racine est indispensable : le runtime FastAPI cherche
le point d'entrée à la racine du projet, alors que le dossier `app/` du
frontNext.js ne doit surtout pas être confondu avec un point d'entrée
Python.

Variables d'environnement côté API : `ENGINE_URL` (défaut :
`https://terrain-football-web.vercel.app`), `ENGINE_TOKEN` (vide),
`ESPN_TIMEOUT` (12), `ESPN_SLOW_TIMEOUT` (30), `ESPN_MAX_CONCURRENT` (4),
`ESPN_CACHE_TTL` (600), `ENGINE_TIMEOUT` (120).

Côté front, `BACKEND_API_URL=https://terrain-football-api.vercel.app` est
déjà positionné dans le projet `terrain-football-web`.

### Ordre de mise en ligne

1. Déployer le **front** (`terrain-football-web`) : il expose la route
   moteur `POST /api/engine/analyze` dont le backend a besoin.
2. Déployer ensuite l'**API** (`terrain-football-api`) : elle appelle le
   moteur du front.
3. Vérifier :
   ```bash
   curl -s "https://terrain-football-api.vercel.app/api/health"
   curl -s "https://terrain-football-api.vercel.app/api/analyze?league=eng.1&date=20261122&match=401879234" | jq '.analysis, (.matches[0].analyst.pronostics | keys | length)'
   ```
   Attendu : `analysis: "complete"` et `16`.

> **Quota Hobby.** Un compte Vercel Hobby est limité à 100 déploiements par
> jour. Au-delà, Vercel répond `402 api-deployments-free-per-day` et
> refuse toute création de déploiement (les builds déclenchés par un push
> GitHub sont eux aussi comptés). Dans ce cas, attendre la remise à zéro
> quotidienne ou passer sur un plan payant : le code, lui, est prêt à être
> déployé tel quel.

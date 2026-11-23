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

GET /api/health  -> état du service et joignabilité du moteur
GET /api/meta    -> contrat de l'API
```

## Résilience

Si le service d'analyse est injoignable, `/api/analyze` renvoie les matchs
bruts avec `analysis: null`. Le front détecte alors l'absence d'analyse
complète et calcule l'analyse de son côté : le site reste fonctionnel.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ENGINE_URL` | `https://terrain-football-web.vercel.app` | URL du service d'analyse (`/api/engine/analyze`) |
| `ENGINE_TOKEN` | *(vide)* | Jeton Bearer exigé par le service d'analyse si défini |
| `ESPN_TIMEOUT` | `12` | Délai de connexion ESPN (secondes) |
| `ENGINE_TIMEOUT` | `120` | Délai de l'appel au moteur (secondes) |

## Tests

```bash
python3 backend/test_ingestion.py
```

Les contrôles sont hors réseau : ils valident la logique de collecte
(fenêtre de forme, splits, libellés, repli en l'absence de source).

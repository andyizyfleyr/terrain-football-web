"""
BACKEND PYTHON — API D'ANALYSE COMPLÈTE
========================================
Ce service est la porte d'entrée publique de l'API d'analyse. Il :

  1. collecte la couche ESPN (calendrier, forme, classement, style) ;
  2. poste les matchs bruts au SERVICE D'ANALYSE (moteur quantitatif v3,
     implémenté en TypeScript — source unique du modèle) ;
  3. renvoie les matchs ENRICHIS : modules d'analyse, simulation
     Monte-Carlo (10 000 itérations) et marchés dérivés (pronostics).

Répartition des responsabilités (volontaire, pour éviter deux
implémentations du modèle qui divergeraient) :

  - Python : ingestion des données publiques (ESPN) + composition ;
  - TypeScript : le modèle (Dixon-Coles, xG, calibration, simulation).

Si le service d'analyse est injoignable, l'API renvoie les matchs bruts
avec `analysis: null` : le front sait alors calculer l'analyse
lui-même (repli historique), le site ne tombe jamais.

Variables d'environnement :
  ENGINE_URL    URL du service d'analyse (défaut : l'application web) ;
  ENGINE_TOKEN  jeton Bearer facultatif pour l'authentification ;
  ESPN_TIMEOUT  délai de connexion ESPN en secondes (défaut : 12).
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

# Import du module frère quel que soit le répertoire de travail utilisé
# par le runtime (uvicorn, `python backend/main.py`, tests).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from espn import build_base_matches, compact_date, parse_iso  # noqa: E402

ENGINE_URL = (os.environ.get("ENGINE_URL") or "https://terrain-football-web.vercel.app").rstrip("/")
ENGINE_TIMEOUT = float(os.environ.get("ENGINE_TIMEOUT", "120"))
ENGINE_TOKEN = os.environ.get("ENGINE_TOKEN") or ""

app = FastAPI(
    title="Terrain — API d'analyse",
    version="3.0",
    description=(
        "API d'analyse football : ingestion ESPN et composition avec le moteur "
        "quantitatif v3 (simulation Monte-Carlo et marchés dérivés)."
    ),
)


def _season_of(date_compact: str) -> Optional[int]:
    parsed = parse_iso(f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:8]}T00:00:00Z")
    return parsed.year if parsed else None


def _normalize_date(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return datetime.now().strftime("%Y%m%d")
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 8:
        return digits
    return datetime.now().strftime("%Y%m%d")


async def call_analysis_service(
    client: httpx.AsyncClient, league: str, date_compact: str, matches: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Demande l'analyse complète au moteur. None si le service est injoignable."""
    headers = {"Accept": "application/json"}
    if ENGINE_TOKEN:
        headers["Authorization"] = f"Bearer {ENGINE_TOKEN}"
    try:
        response = await client.post(
            f"{ENGINE_URL}/api/engine/analyze",
            json={"league": league, "date": date_compact, "matches": matches},
            headers=headers,
            timeout=ENGINE_TIMEOUT,
        )
        if response.status_code != 200:
            return None
        return response.json()
    except Exception:
        return None


@app.get("/api/health")
async def health() -> JSONResponse:
    """État du service et joignabilité du moteur d'analyse."""
    engine_ok = False
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            response = await client.get(f"{ENGINE_URL}/api/engine/analyze")
            engine_ok = response.status_code in (400, 401, 405)
        except Exception:
            engine_ok = False
    return JSONResponse(
        {
            "status": "ok",
            "service": "terrain-football-api",
            "version": "3.0",
            "engine": {"url": ENGINE_URL, "reachable": engine_ok},
            "timestamp": datetime.now().isoformat(timespec="seconds"),
        }
    )


@app.get("/api/meta")
async def meta() -> JSONResponse:
    """Contrat de l'API : role de chaque couche."""
    return JSONResponse(
        {
            "service": "terrain-football-api",
            "version": "3.0",
            "ingestion": "ESPN (calendrier, forme, classement, style de jeu)",
            "analysis": {
                "engine": "moteur quantitatif v3 (TypeScript)",
                "endpoint": f"{ENGINE_URL}/api/engine/analyze",
                "markets": 16,
                "simulations": 10000,
            },
        }
    )


@app.get("/api/analyze")
async def analyze(
    league: str = Query("eng.1"),
    date: str = Query(""),
    match: str = Query(""),
) -> JSONResponse:
    """Analyse complète d'une journée (ou d'un match unique)."""
    date_compact = _normalize_date(date)
    match_ids = [m for m in (match or "").split(",") if m]

    async with httpx.AsyncClient(timeout=ENGINE_TIMEOUT) as client:
        base_matches = await build_base_matches(league, date_compact, match_ids or None)

        if not base_matches:
            return JSONResponse(
                {
                    "error": "Aucune rencontre disponible pour cette journée.",
                    "league": league,
                    "date": date_compact,
                    "matches": [],
                },
                status_code=404,
            )

        analysis = await call_analysis_service(client, league, date_compact, base_matches)

    if analysis and isinstance(analysis.get("matches"), list) and analysis["matches"]:
        return JSONResponse(
            {
                "league": league,
                "date": date_compact,
                "season": _season_of(date_compact),
                "analysis": "complete",
                "matches": analysis["matches"],
                "sources": analysis.get("sources") or ["Données publiques"],
            }
        )

    # Repli : le moteur est injoignable, on renvoie la couche brute et
    # le front calculera l'analyse de son côté.
    return JSONResponse(
        {
            "league": league,
            "date": date_compact,
            "season": _season_of(date_compact),
            "analysis": None,
            "matches": base_matches,
            "sources": ["Données publiques"],
        }
    )

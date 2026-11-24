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

import asyncio
import os
import sys
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

# Import du module frère quel que soit le répertoire de travail utilisé
# par le runtime (uvicorn, `python backend/main.py`, tests).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from espn import (  # noqa: E402
    LEAGUE_CATALOG,
    _client,
    build_base_matches,
    compact_date,
    fetch_day_fixtures,
    parse_iso,
)

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
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Demande l'analyse complète au moteur.

    Renvoie (analyse, erreur). L'erreur suit le même contrat que
    l'API Next.js : `code` stable, `retryable`, `detail` technique.
    `None` signifie « le moteur a répondu, mais n'a rien pu analyser ».
    """
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
    except httpx.TimeoutException as exc:
        return None, {
            "code": "upstream_timeout",
            "retryable": True,
            "error": "Le moteur d'analyse a mis trop de temps à répondre.",
            "detail": str(exc),
        }
    except Exception as exc:  # pragma: no cover - dépend du réseau
        return None, {
            "code": "upstream_unavailable",
            "retryable": True,
            "error": "Le moteur d'analyse est momentanément injoignable.",
            "detail": str(exc),
        }

    if response.status_code == 429:
        return None, {
            "code": "rate_limited",
            "retryable": True,
            "error": "Le moteur d'analyse refuse temporairement les requêtes.",
            "detail": f"HTTP 429",
        }
    if response.status_code == 401:
        return None, {
            "code": "unauthorized",
            "retryable": False,
            "error": "Le jeton d'accès au moteur d'analyse est invalide.",
            "detail": f"HTTP 401",
        }
    if response.status_code != 200:
        return None, {
            "code": "upstream_unavailable",
            "retryable": response.status_code >= 500,
            "error": f"Le moteur d'analyse a répondu {response.status_code}.",
            "detail": f"HTTP {response.status_code}",
        }
    try:
        return response.json(), None
    except Exception as exc:  # pragma: no cover - réponse illisible
        return None, {
            "code": "upstream_unavailable",
            "retryable": True,
            "error": "La réponse du moteur d'analyse est illisible.",
            "detail": str(exc),
        }


@app.get("/api/leagues")
async def leagues() -> JSONResponse:
    """Catalogue des competitions proposees (selecteur du front)."""
    return JSONResponse({"leagues": LEAGUE_CATALOG})


@app.get("/api/fixtures")
async def fixtures(
    league: str = Query("eng.1"),
    date: str = Query(""),
) -> JSONResponse:
    """Matchs d'une journee au format du calendrier (front).

    `calendar` liste les journees de la saison publiees par ESPN. Il
    permet au client de retrouver une journee reellement jouee, y
    compris quand la ligue est en pause (coupe du monde, treve) : le
    calendrier et les matchs sont servis par la meme requete ESPN.
    """
    date_compact = _normalize_date(date)
    async with _client() as client:
        result = await fetch_day_fixtures(client, league, date_compact)
    return JSONResponse(
        {
            "league": league,
            "date": date_compact,
            "events": result.get("events", []),
            "calendar": result.get("calendar", []),
        }
    )


@app.get("/api/smoke")
async def smoke() -> JSONResponse:
    """Auto-controle de la production : la chaine de donnees tient-elle ?

    Les regressions les plus couteuses de ce projet ne sont pas des
    erreurs de compilation mais des ruptures SILENCIEUSES : ESPN qui
    change de format, une limitation de debit qui vide la forme, une
    route du front en 404. Ce controle rejoue une ingestion complete
    (calendrier, forme, classement, style) et verifie les invariants.

    Programme par une cron Vercel (quotas Vercel, pas GitHub) et
    appelable a la main : `/api/smoke`.
    """
    checks: List[Dict[str, Any]] = []

    def note(label: str, ok: bool, detail: str = "") -> None:
        checks.append({"label": label, "ok": bool(ok), "detail": detail})

    note("catalogue des compétitions", len(LEAGUE_CATALOG) >= 10, f"{len(LEAGUE_CATALOG)} compétitions")

    # Une journée recente avec des matchs (on remonte le temps).
    reference: Optional[Dict[str, Any]] = None
    reference_date = ""
    today = datetime.utcnow()
    for back in range(1, 11):
        day = today - timedelta(days=back)
        date_compact = day.strftime("%Y%m%d")
        async with _client() as client:
            result = await fetch_day_fixtures(client, "eng.1", date_compact)
        events = result.get("events", [])
        if events:
            reference = events[0]
            reference_date = date_compact
            break
    note("journée de calendrier servie", bool(reference), reference_date or "aucun match sur 10 jours")

    if reference:
        async with _client() as client:
            base = await build_base_matches("eng.1", reference_date, [reference["id"]])
        match = base[0] if base else {}
        factors = match.get("factors") or {}
        forme = factors.get("forme") or {}
        enjeu = factors.get("enjeu") or {}
        classement = enjeu.get("classementHome") or {}
        gd = classement.get("gd")
        note("match analysé", bool(match), str(reference.get("name") or ""))
        note("forme domicile non vide", bool(str(forme.get("home") or "").strip()), str(forme.get("home")))
        note("forme extérieure non vide", bool(str(forme.get("away") or "").strip()), str(forme.get("away")))
        note(
            "historique de forme alimenté",
            isinstance(forme.get("detailHome"), list) and len(forme["detailHome"]) > 0,
            f"{len(forme.get('detailHome') or [])} matchs",
        )
        note("différence de buts réelle", isinstance(gd, (int, float)) and gd != 0, str(gd))
        note("classement renseigné", bool(classement.get("name")), str(classement.get("name")))
        note("style de jeu disponible", bool((factors.get("style") or {}).get("home")), "")
        note("saison cohérente", match.get("league") == "eng.1", str(match.get("league")))

    # Couverture du catalogue : chaque competition annoncee doit etre une
    # ligue ESPN reelle ET servir des matchs.
    #
    # Regression corrigee : la Bundesliga etait cataloguee sous le slug
    # `deu.1`, inconnu d'ESPN (qui ne publie que `ger.1`). ESPN repondait
    # HTTP 400 et le calendrier restait vide, sans aucune erreur visible.
    #
    # On s'appuie sur le calendrier de saison publie par ESPN plutot que
    # sur une fenetre de dates : une ligue en pause (coupe du monde, treve)
    # ne sert aucun match pendant plusieurs semaines, sans etre cassee.
    uncovered: List[str] = []
    no_calendar: List[str] = []
    today_compact = datetime.utcnow().strftime("%Y%m%d")

    async def _check_league(client: httpx.AsyncClient, slug: str) -> Tuple[bool, str]:
        result = await fetch_day_fixtures(client, slug, today_compact)
        calendar = result.get("calendar", [])
        if not calendar:
            return False, "aucun calendrier ESPN"
        played = [d for d in calendar if d <= today_compact]
        for day in reversed(played[-3:]):
            day_result = await fetch_day_fixtures(client, slug, day)
            if day_result.get("events"):
                return True, f"{len(calendar)} journées, match le {day}"
        return False, "aucun match sur les dernieres journees"

    async with _client() as client:
        results = await asyncio.gather(
            *(_check_league(client, l["slug"]) for l in LEAGUE_CATALOG)
        )
    for (ok, detail), league in zip(results, LEAGUE_CATALOG):
        if not ok:
            (no_calendar if detail == "aucun calendrier ESPN" else uncovered).append(
                league["slug"]
            )

    note(
        "chaque compétition du catalogue est une ligue ESPN connue",
        not no_calendar,
        ", ".join(no_calendar) or f"{len(LEAGUE_CATALOG)} ligues",
    )
    note(
        "chaque compétition du catalogue sert des matchs",
        not uncovered,
        ", ".join(uncovered) or f"{len(LEAGUE_CATALOG)} ligues",
    )

    failed = [c for c in checks if not c["ok"]]
    payload = {
        "ok": not failed,
        "checks": checks,
        "failed": [c["label"] for c in failed],
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    return JSONResponse(payload, status_code=200 if not failed else 500)


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


@app.get("/api/debug/espn")
async def debug_espn(league: str = "eng.1", team: str = "306") -> JSONResponse:
    """Diagnostic temporaire de l'accès ESPN (statut, taille, structure)."""
    from espn import ESPN_BASE, _client, resolve_league_slug

    # Le diagnostic interroge ESPN en direct : il doit donc viser le
    # slug ESPN effectif, sinon il rapporte une erreur 400 pour un
    # simple alias de nom (ex. `deu.1` -> `ger.1`) et masque la
    # reelle cause d'un calendrier vide.
    league = resolve_league_slug(league)

    report = {}
    # Le client doit rester ouvert jusqu'a la sonde du calendrier d'equipe :
    # ferme, il renvoie "client has been closed" et la forme parait vide.
    async with _client() as client:
        for label, url in (
            (
                "schedule",
                f"{ESPN_BASE}/site/v2/sports/soccer/{league}/teams/{team}/schedule?season=2026",
            ),
            ("scoreboard", f"{ESPN_BASE}/site/v2/sports/soccer/{league}/scoreboard?dates=20261122"),
            ("standings", f"{ESPN_BASE}/v2/sports/soccer/{league}/standings"),
        ):
            entry = {"url": url}
            try:
                response = await client.get(url)
                entry["status"] = response.status_code
                entry["bytes"] = len(response.content)
                if response.status_code == 200:
                    payload = response.json()
                    entry["keys"] = sorted(list(payload.keys())[:12])
                    events = payload.get("events") or []
                    entry["events"] = len(events)
                    from espn import _parse_event

                    completed = [e for e in events if _parse_event(e)]
                    entry["completed"] = len(completed)
                    if completed:
                        comps = (completed[0].get("competitions") or [{}])[0]
                        first = (comps.get("competitors") or [{}])[0]
                        entry["sample_score"] = first.get("score")
                        entry["sample_date"] = completed[0].get("date")
            except Exception as exc:  # pragma: no cover - diagnostic
                entry["error"] = f"{type(exc).__name__}: {exc}"
            report[label] = entry

    # Journal des derniers appels ESPN + test du calendrier d'equipe
    try:
        from espn import FETCH_LOG, fetch_team_schedule, parse_iso

        async with _client() as probe_client:
            history = await fetch_team_schedule(
                probe_client, league, team, parse_iso("2026-11-22T14:00Z")
            )
        report["team_history"] = {
            "count": len(history),
            "completed": len(
                [
                    m
                    for m in history
                    if m.get("homeGoals") is not None and m.get("awayGoals") is not None
                ]
            ),
            "last": history[-3:],
        }
        # Chemin de fetch reellement suivi par l'ingestion
        report["fetch_path"] = {
            "source": "calendrier d'equipe ESPN avec saison explicite",
            "url": (
                f"https://site.api.espn.com/apis/site/v2/sports/soccer/"
                f"{league}/teams/{team}/schedule?season=2026"
            ),
            "fallback": "scoreboard de ligue (dates=annee, limit=1000)",
            "ingestion_season": 2026,
        }
    except Exception as exc:  # pragma: no cover - diagnostic
        report["probe_error"] = f"{type(exc).__name__}: {exc}"

    # Journal capture apres l'appel : on voit les erreurs ESPN reelles
    try:
        from espn import FETCH_LOG

        report["fetch_log"] = FETCH_LOG[-12:]
    except Exception as exc:  # pragma: no cover - diagnostic
        report["probe_error"] = f"{type(exc).__name__}: {exc}"

    return JSONResponse(report)


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
            # Ce n'est pas une panne : la journée n'existe pas (repos
            # international, compétition suspendue) ou aucune donnée
            # n'a pu être collectée. Le contrat le distingue d'une erreur.
            return JSONResponse(
                {
                    "error": "Aucune rencontre disponible pour cette journée.",
                    "code": "no_data",
                    "retryable": False,
                    "degraded": True,
                    "league": league,
                    "date": date_compact,
                    "matches": [],
                },
                status_code=404,
            )

        engine_result = await call_analysis_service(
            client, league, date_compact, base_matches
        )
        # Contrat : (analyse, erreur). On tolère aussi l'ancienne forme
        # (analyse seule) pour qu'un remplacement de la fonction ne
        # fasse pas tomber la route.
        if isinstance(engine_result, tuple) and len(engine_result) == 2:
            analysis, engine_error = engine_result
        else:
            analysis, engine_error = engine_result, None

    # L'analyse n'est « complète » que si le moteur a réellement produit
    # le bloc `analyst` (avec ses marchés dérivés). Sinon on renvoie les
    # matchs bruts : le front saura alors calculer l'analyse de son côté,
    # plutôt que de renvoyer une réponse amputée.
    engine_matches = analysis.get("matches") if isinstance(analysis, dict) else None
    complete = bool(
        isinstance(engine_matches, list)
        and engine_matches
        and all(
            isinstance(m, dict) and m.get("analyst") and m["analyst"].get("pronostics")
            for m in engine_matches
        )
    )

    if complete:
        return JSONResponse(
            {
                "league": league,
                "date": date_compact,
                "season": _season_of(date_compact),
                "analysis": "complete",
                "degraded": False,
                "matches": engine_matches,
                "sources": analysis.get("sources") or ["Données publiques"],
            }
        )

    # Repli : le moteur est injoignable ou incomplet, on renvoie la
    # couche brute et le front calculera l'analyse de son côté. La
    # réponse est marquée « dégradée » et porte le code d'erreur, pour
    # que l'interface explique la situation au lieu d'afficher un
    # silence ou une panne indistincte.
    error = engine_error or {
        "code": "no_data",
        "retryable": False,
        "error": "Le moteur d'analyse n'a produit aucune analyse exploitable.",
        "detail": "Réponse 200 sans bloc d'analyse complet.",
    }
    return JSONResponse(
        {
            "league": league,
            "date": date_compact,
            "season": _season_of(date_compact),
            "analysis": None,
            "degraded": True,
            "error": error["error"],
            "code": error["code"],
            "retryable": error["retryable"],
            "matches": base_matches,
            "sources": ["Données publiques"],
        }
    )

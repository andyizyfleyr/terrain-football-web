"""Contrôles hors réseau de l'API (composition et repli)."""

import asyncio
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi.testclient import TestClient  # noqa: E402

import main as api  # noqa: E402

failures: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        failures.append(label)
        print(f"  FAIL {label} {detail}")


BASE_MATCH: Dict[str, Any] = {
    "id": "401879234",
    "date": "2026-11-22T14:00Z",
    "league": "eng.1",
    "home": {"id": "306", "name": "Hull City", "short": "HUL", "score": 2},
    "away": {"id": "331", "name": "Brighton", "short": "BHA", "score": 0},
    "factors": {"forme": {"fraicheurHome": {"count": 5}, "fraicheurAway": {"count": 5}}},
}

ENGINE_MATCH: Dict[str, Any] = {
    **BASE_MATCH,
    "analyst": {
        "pronostics": {
            "totalOdd": 0.501,
            "totalEven": 0.499,
            "halfTimeFullTime": {"H/H": 0.1},
        },
        "simulation": {"runs": 10000},
    },
}

original_build = api.build_base_matches
original_call = api.call_analysis_service


def stub_build(league: str, date_compact: str, match_ids=None):
    async def _inner():
        return [dict(BASE_MATCH)]

    return _inner()


def stub_engine(ok: bool, error: dict | None = None):
    """Renvoie (analyse, erreur) — contrat de call_analysis_service."""

    async def _inner(client, league, date_compact, matches):
        if not ok:
            return None, error or {
                "code": "upstream_unavailable",
                "retryable": True,
                "error": "Le moteur d'analyse est momentanément injoignable.",
                "detail": "test",
            }
        return (
            {
                "league": league,
                "date": date_compact,
                "matches": [dict(ENGINE_MATCH)],
                "sources": ["Données publiques", "Statistiques détaillées"],
            },
            None,
        )

    return _inner


print("1. Analyse complète (moteur joignable)")
api.build_base_matches = stub_build
api.call_analysis_service = stub_engine(True)
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20261122")
    payload = response.json()
check("statut 200", response.status_code == 200, str(response.status_code))
check("analyse marquée complète", payload.get("analysis") == "complete", str(payload.get("analysis")))
check("les marchés dérivés sont présents", bool(payload["matches"][0]["analyst"]["pronostics"]))
check("saison déduite de la date", payload.get("season") == 2026, str(payload.get("season")))
check("sources transmises", payload.get("sources") == ["Données publiques", "Statistiques détaillées"], str(payload.get("sources")))

print("2. Repli (moteur injoignable : les matchs bruts sont renvoyés)")
api.call_analysis_service = stub_engine(False)
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20261122")
    payload = response.json()
check("statut 200", response.status_code == 200, str(response.status_code))
check("analyse absente", payload.get("analysis") is None, str(payload.get("analysis")))
check("matchs bruts présents", len(payload.get("matches", [])) == 1, str(payload.get("matches")))
check("aucun bloc analyst improvisé", "analyst" not in payload["matches"][0])
check("réponse marquée dégradée", payload.get("degraded") is True, str(payload.get("degraded")))
check(
    "code d'erreur explicite",
    payload.get("code") == "upstream_unavailable",
    str(payload.get("code")),
)
check("erreur réessayable signalée", payload.get("retryable") is True, str(payload.get("retryable")))
check("message lisible présent", bool(payload.get("error")), str(payload.get("error")))

print("2bis. Repli avec un code d'erreur distinct (délai dépassé)")
api.call_analysis_service = stub_engine(
    False,
    {
        "code": "upstream_timeout",
        "retryable": True,
        "error": "Le moteur d'analyse a mis trop de temps à répondre.",
        "detail": "timeout",
    },
)
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20261122")
    payload = response.json()
check("code délai dépassé conservé", payload.get("code") == "upstream_timeout", str(payload.get("code")))
check("toujours dégradé", payload.get("degraded") is True, str(payload.get("degraded")))

print("2ter. Aucune rencontre : ce n'est pas une panne")


async def _empty_base(league, date_compact, match_ids=None):
    return []


api.build_base_matches = _empty_base
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20261122")
    payload = response.json()
check("statut 404", response.status_code == 404, str(response.status_code))
check("code no_data explicite", payload.get("code") == "no_data", str(payload.get("code")))
check("dégradé signalé", payload.get("degraded") is True, str(payload.get("degraded")))
check("non réessayable", payload.get("retryable") is False, str(payload.get("retryable")))

# On rétablit le stub de matchs pour la suite.
api.build_base_matches = stub_build

print("3. Moteur joignable mais analyse non produite (repli)")
async def stub_engine_partial(client, league, date_compact, matches):
    # Le moteur répond, mais sans produire le bloc `analyst`.
    return {
        "league": league,
        "date": date_compact,
        "matches": [dict(BASE_MATCH)],
        "sources": ["Données publiques"],
    }


api.call_analysis_service = stub_engine_partial
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20261122")
    payload = response.json()
check("statut 200", response.status_code == 200, str(response.status_code))
check("analyse non déclarée complète", payload.get("analysis") is None, str(payload.get("analysis")))
check("matchs bruts renvoyés", len(payload.get("matches", [])) == 1, str(payload.get("matches")))

print("4. Journée sans rencontre")
async def empty_build(league: str, date_compact: str, match_ids=None):
    return []


api.build_base_matches = empty_build
with TestClient(api.app) as client:
    response = client.get("/api/analyze?league=eng.1&date=20260101")
check("statut 404", response.status_code == 404, str(response.status_code))
check("message explicite", "Aucune rencontre" in response.json().get("error", ""), response.text[:120])

print("5. Santé et contrat")
api.build_base_matches = original_build
api.call_analysis_service = original_call
with TestClient(api.app) as client:
    health = client.get("/api/health").json()
    meta = client.get("/api/meta").json()
check("santé : statut ok", health.get("status") == "ok", str(health))
check("santé : moteur référencé", "engine" in health, str(health))
check("contrat : 16 marchés annoncés", meta["analysis"]["markets"] == 16, str(meta.get("analysis")))
check("contrat : 10 000 simulations", meta["analysis"]["simulations"] == 10000, str(meta.get("analysis")))

print("6. Calendrier du front (compétitions et journées)")
import espn as espn_module  # noqa: E402

DAY_EVENTS = [
    {
        "id": "401879234",
        "date": "2026-11-22T14:00Z",
        "league": "eng.1",
        "home": {"id": "306", "name": "Hull City", "short": "HUL", "logo": "l.png", "score": 2},
        "away": {"id": "331", "name": "Brighton", "short": "BHA", "logo": "l.png", "score": 0},
        "venue": "The MKM Stadium",
        "city": "Hull",
        "status": {"completed": True},
    }
]

original_fetch = espn_module.fetch_json


async def fake_scoreboard(client, url, **kwargs):
    return {"events": [{"id": "401879234", "date": "2026-11-22T14:00Z", "competitions": []}]}


async def fake_day_matches(client, league, date_compact):
    return list(DAY_EVENTS)


# La couche d'ingestion lit maintenant le scoreboard ESPN brut : c'est ce
# payload qui porte a la fois les matchs et le calendrier de la saison.
async def fake_day_scoreboard(client, league, date_compact):
    return {
        "leagues": [
            {
                "calendar": [
                    "2026-08-07T07:00Z",
                    "2026-11-21T07:00Z",
                    "2026-11-22T07:00Z",
                    "2026-11-27T08:00Z",
                ]
            }
        ],
        "events": [
            {
                "id": "401879234",
                "date": "2026-11-22T14:00Z",
                "status": {"type": {"state": "post", "completed": True, "detail": "FT"}},
                "competitions": [
                    {
                        "venue": {"fullName": "The MKM Stadium", "address": {"city": "Hull"}},
                        "competitors": [
                            {
                                "homeAway": "home",
                                "team": {"id": "306", "displayName": "Hull City", "shortDisplayName": "HUL"},
                                "score": "2",
                            },
                            {
                                "homeAway": "away",
                                "team": {"id": "331", "displayName": "Brighton", "shortDisplayName": "BHA"},
                                "score": "0",
                            },
                        ],
                    }
                ],
            }
        ],
    }


espn_module.fetch_day_scoreboard = fake_day_scoreboard
espn_module.DAY_CACHE.clear()
with TestClient(api.app) as client:
    leagues_payload = client.get("/api/leagues").json()
    fixtures_payload = client.get("/api/fixtures?league=eng.1&date=2026-11-22").json()
espn_module.fetch_day_scoreboard = espn_module.fetch_day_scoreboard
espn_module.DAY_CACHE.clear()

catalog = leagues_payload.get("leagues", [])
check(
    "catalogue des compétitions exposé",
    len(catalog) >= 10 and all({"slug", "name", "country"} <= set(l) for l in catalog),
    str(catalog[:2]),
)
check("Premier League au catalogue", any(l["slug"] == "eng.1" for l in catalog), str(catalog[:2]))
check(
    "coupes d'Europe au catalogue servi",
    {"uefa.champions", "uefa.europa"} <= {l["slug"] for l in catalog},
    str([l["slug"] for l in catalog if l["slug"].startswith("uefa.")]),
)
events = fixtures_payload.get("events", [])
check("journée servie", len(events) == 1, str(fixtures_payload)[:200])
check(
    "fixture au format du front",
    bool(events)
    and {"id", "date", "name", "home", "away"} <= set(events[0])
    and events[0]["home"].get("short") == "HUL"
    and events[0]["away"].get("name") == "Brighton",
    str(events[:1]),
)
# Le calendrier de saison permet de retrouver une journee reellement
# jouee quand la ligue est en pause : sans lui, une treve de trois
# semaines ferait croire a une ligue cassee.
calendar = fixtures_payload.get("calendar", [])
check(
    "calendrier de saison expose",
    calendar == ["20260807", "20261121", "20261122", "20261127"],
    str(calendar),
)
check(
    "calendrier trie et sans doublon",
    calendar == sorted(set(calendar)),
    str(calendar),
)

print("7. Auto-contrôle de production (/api/smoke)")


async def fake_fixtures(client, league, date_compact):
    # `completed` fait partie du contrat : /api/smoke exige un match
    # reellement JOUE, pas seulement programme (une journée en cours ne
    # prouve pas que la chaîne de données fonctionne).
    return {
        "events": [
            {
                "id": "401879234",
                "name": "Hull City - Brighton",
                "home": {"name": "Hull City"},
                "away": {"name": "Brighton"},
                "completed": True,
            }
        ],
        "calendar": ["20261122"],
    }


async def fake_base(league, date_compact, match_ids=None):
    return [
        {
            "id": "401879234",
            "league": league,
            "factors": {
                "forme": {"home": "1V-2N-2D", "away": "3V-0N-2D", "detailHome": [{"id": "1"}]},
                "enjeu": {"classementHome": {"gd": 2, "name": "Hull City"}},
                "style": {"home": {"possession": 33.8}},
            },
        }
    ]


api.fetch_day_fixtures = fake_fixtures
api.build_base_matches = fake_base
with TestClient(api.app) as client:
    smoke = client.get("/api/smoke")
smoke_body = smoke.json()
check("auto-contrôle vert", smoke.status_code == 200, str(smoke_body)[:200])
check("auto-contrôle complet", len(smoke_body.get("checks", [])) >= 8, str(len(smoke_body.get("checks", []))))


async def broken_base(league, date_compact, match_ids=None):
    return [
        {
            "id": "401879234",
            "league": league,
            "factors": {
                "forme": {"home": "", "away": "", "detailHome": []},
                "enjeu": {"classementHome": {"gd": 0, "name": "Hull City"}},
                "style": {"home": None},
            },
        }
    ]


api.build_base_matches = broken_base
with TestClient(api.app) as client:
    smoke_broken = client.get("/api/smoke")
check("auto-contrôle rouge sur régression", smoke_broken.status_code == 500, str(smoke_broken.status_code))
check("régression nommée", "forme domicile non vide" in smoke_broken.json().get("failed", []), str(smoke_broken.json().get("failed")))
# Une competition dont le slug est inconnu d'ESPN (comme le fut `deu.1`)
# ne renvoie ni calendrier ni match : le controle doit la signaler.
async def fixtures_with_broken_league(client, league, date_compact):
    if league == "ger.1":
        return {"events": [], "calendar": []}
    return {
        "events": [
            {
                "id": "401879234",
                "name": "Hull City - Brighton",
                "home": {"name": "Hull City"},
                "away": {"name": "Brighton"},
                "completed": True,
            }
        ],
        "calendar": ["20261122"],
    }


api.fetch_day_fixtures = fixtures_with_broken_league
with TestClient(api.app) as client:
    smoke_broken_league = client.get("/api/smoke")
body = smoke_broken_league.json()
failed = body.get("failed", [])
check(
    "auto-controle rouge sur ligue inconnue d'ESPN",
    smoke_broken_league.status_code == 500,
    str(smoke_broken_league.status_code),
)
check(
    "la ligue cassee est nommee",
    any("ligue ESPN connue" in label for label in failed),
    str(failed),
)
check(
    "la ligue cassee est identifiee",
    "ger.1" in str(body.get("checks")),
    str(body.get("checks"))[-400:],
)

api.fetch_day_fixtures = espn_module.fetch_day_fixtures
api.build_base_matches = original_build

print("8. Slugs de championnat (résolution ESPN)")

# Régression corrigée : le catalogue exposait `deu.1`, slug inconnu d'ESPN
# (qui ne publie que `ger.1`). ESPN répondait HTTP 400 et le calendrier
# de la Bundesliga restait vide, sans aucune erreur visible.
catalog_slugs = [l["slug"] for l in espn_module.LEAGUE_CATALOG]
check(
    "Bundesliga au catalogue sous son slug ESPN",
    "ger.1" in catalog_slugs,
    str(catalog_slugs),
)
check(
    "aucun slug ISO non ESPN au catalogue",
    "deu.1" not in catalog_slugs,
    str(catalog_slugs),
)
check(
    "alias historique `deu.1` conservé",
    espn_module.resolve_league_slug("deu.1") == "ger.1",
    espn_module.resolve_league_slug("deu.1"),
)
check(
    "slug ESPN inchangé par la résolution",
    espn_module.resolve_league_slug("ger.1") == "ger.1",
    espn_module.resolve_league_slug("ger.1"),
)
check(
    "slug inconnu conservé tel quel",
    espn_module.resolve_league_slug("xyz.9") == "xyz.9",
    espn_module.resolve_league_slug("xyz.9"),
)
check(
    "les 18 compétitions restent cataloguées",
    len(catalog_slugs) == 18,
    str(len(catalog_slugs)),
)

# Régression : la Ligue des Champions (et la Ligue Europa) étaient
# absentes du catalogue, donc du sélecteur de compétitions du front —
# alors que tout le reste de la chaîne (mapping FotMob, identité de
# ligue, détection des matchs européens) les connaissait déjà.
check(
    "Ligue des Champions au catalogue",
    "uefa.champions" in catalog_slugs,
    str(catalog_slugs),
)
check(
    "Ligue Europa au catalogue",
    "uefa.europa" in catalog_slugs,
    str(catalog_slugs),
)
check(
    "les coupes d'Europe sont nommées en français",
    {l["slug"]: l for l in espn_module.LEAGUE_CATALOG}.get("uefa.champions", {}).get("name")
    == "Ligue des Champions",
    str([l for l in espn_module.LEAGUE_CATALOG if l["slug"].startswith("uefa.")]),
)

# Chaque slug catalogué doit produire une URL ESPN distincte : une
# collision signerait qu'une Division est interrogee sous le nom d'une
# autre (le symptôme observé sur Serie A / Ligue 1).
resolved = {s: espn_module.resolve_league_slug(s) for s in catalog_slugs}
check(
    "aucune collision de résolution entre compétitions",
    len(set(resolved.values())) == len(resolved),
    str(resolved),
)
check(
    "les slugs résolus pointent tous vers ESPN",
    all(v in resolved.values() for v in resolved.values()),
    str(resolved),
)

print("")
if failures:
    print(f"✗ {len(failures)} contrôle(s) en échec : {failures}")
    sys.exit(1)
print("✓ Contrôles de l'API passés")

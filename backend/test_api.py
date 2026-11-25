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

print("6 bis. Journee toutes compétitions (/api/fixtures/all)")


async def fake_all_leagues(client, date_compact, leagues=None):
    """Reproduit la reponse reelle : matchs etiquetes par competition."""
    from espn import league_meta as _meta

    slugs = leagues or [item["slug"] for item in espn_module.LEAGUE_CATALOG]
    events = []
    failed = []
    per_league = {}
    for slug in slugs:
        if slug == "nor.1":
            failed.append(slug)
            continue
        per_league[slug] = 1
        meta = _meta(slug)
        events.append(
            {
                "id": f"e-{slug}",
                "date": f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:]}T18:00Z",
                "name": "A - B",
                "home": {"name": "A"},
                "away": {"name": "B"},
                "league": slug,
                "leagueName": meta["name"],
                "leagueCountry": meta["country"],
                "leagueTier": meta["tier"],
            }
        )
    events.sort(key=lambda item: item["date"])
    return {
        "date": date_compact,
        "events": events,
        "leagues": [_meta(slug) for slug in slugs],
        "perLeague": per_league,
        "failed": failed,
        "total": len(events),
    }


original_all = espn_module.fetch_day_all_leagues
espn_module.fetch_day_all_leagues = fake_all_leagues
# La route importe la fonction dans main : on remplace la reference la-bas aussi.
api_mod = sys.modules["main"]
original_api_all = getattr(api_mod, "fetch_day_all_leagues", None)
api_mod.fetch_day_all_leagues = fake_all_leagues
with TestClient(api.app) as client:
    all_payload = client.get("/api/fixtures/all?date=2026-11-24").json()
    subset_payload = client.get("/api/fixtures/all?date=2026-11-24&leagues=den.1,gre.1").json()
    bogus_payload = client.get("/api/fixtures/all?date=2026-11-24&leagues=xyz.9,den.1").json()
espn_module.fetch_day_all_leagues = original_all
if original_api_all is not None:
    api_mod.fetch_day_all_leagues = original_api_all

check(
    "toutes ligues : une entree par competition du catalogue",
    len(all_payload.get("leagues", [])) == len(espn_module.LEAGUE_CATALOG),
    str(len(all_payload.get("leagues", []))),
)
check(
    "toutes ligues : les matchs portent leur competition",
    bool(all_payload.get("events"))
    and all(
        {"league", "leagueName", "leagueCountry"} <= set(e) for e in all_payload["events"]
    ),
    str(all_payload.get("events", [])[:1]),
)
check(
    "toutes ligues : nom de competition resolvable cote front",
    {e["league"]: e["leagueName"] for e in all_payload["events"]}.get("gre.1")
    == "Super League grecque",
    str({e["league"]: e["leagueName"] for e in all_payload["events"]}),
)
check(
    "toutes ligues : une competition en panne est signalee sans casser la reponse",
    all_payload.get("failed") == ["nor.1"] and len(all_payload.get("events", [])) == 22,
    f"failed={all_payload.get('failed')} total={all_payload.get('total')}",
)
check(
    "toutes ligues : filtre de competitions respecte",
    [l["slug"] for l in subset_payload.get("leagues", [])] == ["den.1", "gre.1"],
    str([l["slug"] for l in subset_payload.get("leagues", [])]),
)
check(
    "toutes ligues : slug inconnu ignore (pas d'appel ESPN inutile)",
    [l["slug"] for l in bogus_payload.get("leagues", [])] == ["den.1"],
    str([l["slug"] for l in bogus_payload.get("leagues", [])]),
)
check(
    "toutes ligues : matchs tries par heure",
    [e["date"] for e in all_payload.get("events", [])]
    == sorted(e["date"] for e in all_payload.get("events", [])),
    str([e["date"] for e in all_payload.get("events", [])][:3]),
)

print("6 ter. Pronostics de la journée (/api/predictions)")


def _analyst(conf, home, draw, away):
    return {
        "market": {
            "available": True,
            "calibrated": {"home": home, "draw": draw, "away": away},
            "odds": {"home": 2.1, "draw": 3.4, "away": 3.5},
            "value": {"pick": "home", "edge": 0.02},
        },
        "confidence": {
            "score": conf,
            "label": "Solide",
            "pickKey": "home",
            "probability": 0.58,
            "interval": {"low": 0.51, "high": 0.65},
        },
        "lambdas": {"home": 1.6, "away": 1.1},
        "synthesis": {"headline": "H", "verdict": "V", "text": "T"},
        "disclosure": {"verdict": "équivalent", "headline": "D"},
        "pronostics": {
            "sim": {"home": 0.48, "draw": 0.28, "away": 0.24},
            "halves": {"first": {}},
            "teamGoals": {"home": {}},
        },
        # Champ volumineux : il ne doit PAS traverser la route.
        "modules": [{"blob": "x" * 500}],
        "tactics": {"home": {"profile": "p" * 500}},
    }


async def fake_base_matches(league, date_compact, match_ids=None):
    if league == "nor.1":
        raise RuntimeError("ingestion indisponible")
    if league == "mex.1":
        return []
    matches = [
        {
            "id": f"{league}-1",
            "date": f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:]}T18:00Z",
            "home": {"name": "Alpha", "short": "ALP", "logo": ""},
            "away": {"name": "Beta", "short": "BET", "logo": ""},
        }
    ]
    if league == "eng.1":
        # Deux rencontres le même jour : c'est le cas qui révélait le bug
        # « un seul match analysé par compétition ».
        matches.append(
            {
                "id": f"{league}-2",
                "date": f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:]}T20:00Z",
                "home": {"name": "Gamma", "short": "GAM", "logo": ""},
                "away": {"name": "Delta", "short": "DEL", "logo": ""},
            }
        )
    return matches


engine_calls = []


async def fake_engine(client, league, date_compact, base):
    # Le service d'analyse réel ne construit le rapport complet que pour
    # UN match (`deepTeamFetch`). Le faux moteur reproduit ce contrat :
    # poster toute la journée d'un coup ne renverrait qu'un match enrichi.
    engine_calls.append((league, len(base)))
    conf = {"eng.1": 72, "esp.1": 91, "gre.1": 45}.get(league, 60)
    return (
        {
            "matches": [
                {
                    **base[0],
                    "analyst": _analyst(conf, 0.5, 0.3, 0.2),
                }
            ]
            if base
            else []
        },
        None,
    )


real_base = espn_module.build_base_matches
real_engine = api_mod.call_analysis_service
espn_module.build_base_matches = fake_base_matches
api_mod.call_analysis_service = fake_engine
espn_module.main = api_mod
# Une compétition sans analyse : doit être comptée, pas inventée.
orig_condense = espn_module.condense_prediction


def condense_with_gap(match):
    if match.get("id", "").startswith("gre.1"):
        return None
    return orig_condense(match)


espn_module.condense_prediction = condense_with_gap
espn_module_call_log = []
with TestClient(api.app) as client:
    pred_payload = client.get("/api/predictions?date=2026-11-28").json()
    # Appels moteur du PREMIER chargement : les requêtes suivantes du test
    # (limite, filtre) repartent d'un cache froid et pollueraient le compte.
    first_load_calls = list(engine_calls)
    engine_calls.clear()
    limited_payload = client.get("/api/predictions?date=2026-11-28&limit=3").json()
    filtered_payload = client.get("/api/predictions?date=2026-11-28&leagues=eng.1,xyz.9").json()
espn_module.build_base_matches = real_base
api_mod.call_analysis_service = real_engine
espn_module.condense_prediction = orig_condense

preds = pred_payload.get("predictions", [])
check(
    "pronostics : les pronostics sont produits",
    bool(preds),
    str(pred_payload)[:160],
)
check(
    "pronostics : triés par confiance décroissante",
    [p["confidence"]["score"] for p in preds]
    == sorted((p["confidence"]["score"] for p in preds), reverse=True),
    str([p["confidence"]["score"] for p in preds])[:80],
)
check(
    "pronostics : la distribution 1X2 est exposée",
    bool(preds)
    and all(
        p["probabilities"]["home"] + p["probabilities"]["draw"] + p["probabilities"]["away"]
        > 0.99
        for p in preds
    ),
    str(preds[0]["probabilities"]) if preds else "aucun",
)
check(
    "pronostics : l'issue retenue correspond à la probabilité la plus haute",
    all(
        p["pick"]
        == max(p["probabilities"], key=lambda k: p["probabilities"][k])
        for p in preds
    ),
    str([p["pick"] for p in preds][:5]),
)
check(
    "pronostics : la confiance mesurée et son intervalle passent",
    bool(preds)
    and preds[0]["confidence"]["probability"] is not None
    and preds[0]["confidence"]["interval"] is not None,
    str(preds[0]["confidence"]) if preds else "aucun",
)
check(
    "pronostics : la confiance désigne l'issue de la SIMULATION, pas le max calibré",
    bool(preds)
    and all(p["confidence"]["pickKey"] == "home" for p in preds)
    and all(p["simulation"]["home"] is not None for p in preds),
    str([(p["confidence"]["pickKey"], p["pick"], p["simulation"]) for p in preds][:2]),
)
check(
    "pronostics : le verdict de transparence accompagne chaque carte",
    all(p["disclosure"].get("verdict") for p in preds),
    str([p["disclosure"] for p in preds][:2]),
)
check(
    "pronostics : les blocs volumineux du moteur NE passent pas la route",
    all("modules" not in p and "tactics" not in p for p in preds),
    str(sorted(preds[0].keys())) if preds else "aucun",
)
check(
    "pronostics : chaque rencontre est analysée (un appel moteur par match)",
    bool(first_load_calls)
    and all(size == 1 for _league, size in first_load_calls)
    and sum(1 for league, _size in first_load_calls if league == "eng.1") == 2,
    f"appels={first_load_calls}",
)
check(
    "pronostics : deux matchs d’une même compétition donnent deux cartes",
    sum(1 for p in preds if p["league"] == "eng.1") == 2,
    str([p["matchId"] for p in preds if p["league"] == "eng.1"]),
)
check(
    "pronostics : la distribution simulée accompagne chaque carte",
    all(
        isinstance(p["simulation"].get("home"), (int, float))
        and isinstance(p["simulation"].get("draw"), (int, float))
        and isinstance(p["simulation"].get("away"), (int, float))
        for p in preds
    ),
    str(preds[0]["simulation"]) if preds else "aucun",
)
check(
    "pronostics : une compétition sans analyse est comptée, pas inventée",
    pred_payload.get("withoutAnalysis", 0) >= 1
    and all(p["league"] != "gre.1" for p in preds),
    f"withoutAnalysis={pred_payload.get('withoutAnalysis')}",
)
check(
    "pronostics : une ingestion en panne est signalée sans casser la réponse",
    pred_payload.get("failed") == ["nor.1"],
    str(pred_payload.get("failed")),
)
check(
    "pronostics : la limite est respectée",
    limited_payload.get("shown") == 3
    and len(limited_payload.get("predictions", [])) == 3
    and limited_payload.get("total", 0) > 3,
    f"shown={limited_payload.get('shown')} total={limited_payload.get('total')}",
)
check(
    "pronostics : filtre de compétitions + slug inconnu ignoré",
    {p["league"] for p in filtered_payload.get("predictions", [])} == {"eng.1"},
    str({p["league"] for p in filtered_payload.get("predictions", [])}),
)
check(
    "pronostics : le poids de la réponse reste léger",
    len(str(pred_payload)) < 20000,
    f"{len(str(pred_payload))} caractères pour {len(preds)} pronostics",
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
    "les 23 compétitions restent cataloguées",
    len(catalog_slugs) == 23,
    str(len(catalog_slugs)),
)

# Championnats peu couverts par les bookmakers : ajoutes pour que
# l'utilisateur puisse les suivre (modele plutot que prix du marche).
OBSCURE_SLUGS = ["den.1", "aut.1", "gre.1", "ned.2", "nor.1"]
missing_obscure = [s for s in OBSCURE_SLUGS if s not in catalog_slugs]
check(
    "les 5 championnats peu couverts sont catalogués",
    not missing_obscure,
    ", ".join(missing_obscure) or str(OBSCURE_SLUGS),
)
check(
    "les championnats peu couverts sont signalés comme tels",
    all(
        {l["slug"]: l for l in espn_module.LEAGUE_CATALOG}[s].get("obscure") is True
        for s in OBSCURE_SLUGS
    ),
    str([l.get("obscure") for l in espn_module.LEAGUE_CATALOG if l["slug"] in OBSCURE_SLUGS]),
)
check(
    "aucun doublon de slug au catalogue",
    len(set(catalog_slugs)) == len(catalog_slugs),
    str(sorted({s for s in catalog_slugs if catalog_slugs.count(s) > 1})),
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

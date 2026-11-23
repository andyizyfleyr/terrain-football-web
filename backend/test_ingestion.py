"""Contrôles hors réseau de la couche d'ingestion ESPN."""

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from espn import (  # noqa: E402
    _form_detail,
    _fraicheur,
    _overall_summary,
    _side_summary,
    _stake_label,
    fetch_standings,
    select_form,
)

KICKOFF = datetime(2026, 11, 22, 14, 0, tzinfo=timezone.utc)

HISTORY = [
    {
        "id": "0",
        "date": "2026-09-26T14:00Z",
        "homeId": "10",
        "homeName": "Hull City",
        "awayId": "30",
        "awayName": "Ipswich",
        "homeGoals": 2,
        "awayGoals": 1,
    },
    {
        "id": "1",
        "date": "2026-08-21T14:00Z",
        "homeId": "10",
        "homeName": "Hull City",
        "awayId": "20",
        "awayName": "Arsenal",
        "homeGoals": 2,
        "awayGoals": 1,
    },
    {
        "id": "2",
        "date": "2026-09-30T14:00Z",
        "homeId": "10",
        "homeName": "Hull City",
        "awayId": "30",
        "awayName": "Ipswich",
        "homeGoals": 0,
        "awayGoals": 0,
    },
    {
        "id": "3",
        "date": "2026-10-25T14:00Z",
        "homeId": "40",
        "homeName": "Brentford",
        "awayId": "10",
        "awayName": "Hull City",
        "homeGoals": 3,
        "awayGoals": 2,
    },
    {
        "id": "4",
        "date": "2026-11-07T15:00Z",
        "homeId": "50",
        "homeName": "Arsenal",
        "awayId": "10",
        "awayName": "Hull City",
        "homeGoals": 1,
        "awayGoals": 0,
    },
    # Match postérieur au coup d'envoi : doit être exclu.
    {
        "id": "5",
        "date": "2026-11-29T14:00Z",
        "homeId": "10",
        "homeName": "Hull City",
        "awayId": "60",
        "awayName": "Newcastle",
        "homeGoals": 4,
        "awayGoals": 0,
    },
    # Match hors fenêtre de 60 jours : doit être exclu.
    {
        "id": "6",
        "date": "2026-07-01T14:00Z",
        "homeId": "10",
        "homeName": "Hull City",
        "awayId": "70",
        "awayName": "Burnley",
        "homeGoals": 5,
        "awayGoals": 0,
    },
]

failures = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        failures.append(label)
        print(f"  FAIL {label} {detail}")


print("1. Fenêtre de forme (60 jours, avant le coup d'envoi, 5 matchs max)")
selected = select_form(HISTORY, "10", KICKOFF)
ids = [m["id"] for m in selected]
check("le match à venir est exclu", "5" not in ids, str(ids))
check("le match hors fenêtre est exclu", "6" not in ids, str(ids))
check("le match de plus de 60 jours est exclu", "1" not in ids, str(ids))
check("quatre matchs retenus", len(selected) == 4, str(ids))
check("les matchs sont triés par date", ids == sorted(ids), str(ids))

print("2. Détail de forme (terrain, adversaire, score, résultat)")
detail = _form_detail(selected, "10")
check("4 entrées de détail", len(detail) == 4, str(len(detail)))
check("terrain du premier match (dom.)", detail[0]["venue"] == "home", detail[0]["venue"])
check("adversaire du match à l'extérieur", detail[2]["opponent"] == "Brentford", detail[2]["opponent"])
check("défaite en déplacement (2-3)", detail[2]["res"] == "D", detail[2]["res"])
check("défaite à l'extérieur (0-1)", detail[3]["res"] == "D", detail[3]["res"])
check("buts pour/contre du match à l'extérieur", detail[2]["gf"] == 2 and detail[2]["ga"] == 3, str(detail[2]))
check("buts pour/contre du match à domicile", detail[0]["gf"] == 2 and detail[0]["ga"] == 1, str(detail[0]))

print("3. Résumés de forme et splits")
overall = _overall_summary(selected, "10")
check("1 victoire, 1 nul, 2 défaites", (overall["wins"], overall["draws"], overall["losses"]) == (1, 1, 2), str(overall))
check("moyenne de buts marqués sur la fenêtre", overall["goalsForAvg"] == 1.0, str(overall))
home = _side_summary(selected, "10", "home", "à domicile")
away = _side_summary(selected, "10", "away", "à l'extérieur")
check("split domicile : 2 matchs joués", home["played"] == 2, str(home))
check("split extérieur : 2 matchs joués", away["played"] == 2, str(away))
check("le libellé domicile mentionne le terrain", "à domicile" in home["resume"], home["resume"])
check("le libellé extérieur mentionne le terrain", "à l'extérieur" in away["resume"], away["resume"])
check("moyenne de buts par match (dom.)", home["goalsForAvg"] == 1.0, str(home))
check("moyenne de buts encaissés (ext.)", away["goalsAgainstAvg"] == 2.0, str(away))

print("4. Fraîcheur de l'échantillon")
fresh = _fraicheur(selected, KICKOFF)
check("4 matchs dans l'échantillon", fresh["count"] == 4, str(fresh))
check("date du dernier match", fresh["latest"] == "2026-11-07", str(fresh))
# 2026-11-22 14:00 - 2026-11-07 15:00 = 14 j 23 h, soit 14 jours pleins :
# même convention que le backend en production.
check("jours depuis le dernier match", fresh["daysSinceLatest"] == 14, str(fresh))
check("fenêtre de 60 jours documentée", fresh["windowDays"] == 60, str(fresh))

print("5. Enjeu selon la position au classement")
check("1er : course au titre", "titre" in _stake_label(1, 20), _stake_label(1, 20))
check("10e : enjeu moyen", "moyen" in _stake_label(10, 20), _stake_label(10, 20))
check("19e : survie en jeu", "Survie" in _stake_label(19, 20), _stake_label(19, 20))
check("classement inconnu : repli neutre", "moyen" in _stake_label(0, 20), _stake_label(0, 20))

print("6. Classement ESPN (charge utile simulée)")
standings_payload = {
    "children": [
        {
            "standings": {
                "entries": [
                    {
                        "team": {"id": "10", "displayName": "Hull City"},
                        "stats": [
                            {"name": "rank", "value": 11},
                            {"name": "points", "value": 14},
                            {"name": "gamesPlayed", "value": 11},
                            {"name": "goalDifference", "value": 2},
                        ],
                    }
                ]
            }
        }
    ]
}
import espn as espn_module  # noqa: E402

original_fetch = espn_module.fetch_json


async def fake_fetch(client, url):
    return standings_payload


espn_module.fetch_json = fake_fetch
import asyncio  # noqa: E402

table = asyncio.run(fetch_standings(None, "eng.1"))
espn_module.fetch_json = original_fetch
check("une équipe lue dans le classement", "10" in table, str(table))
check("rang lu", table.get("10", {}).get("rank") == 11, str(table.get("10")))
check("points lus", table.get("10", {}).get("points") == 14, str(table.get("10")))
check("matchs joués lus", table.get("10", {}).get("played") == 11, str(table.get("10")))
check(
    "différence de buts lue (pointDifferential)",
    table.get("10", {}).get("goalDifference") == 2,
    str(table.get("10")),
)

print("4. Structures ESPN réelles (calendrier d'équipe, scoreboard de saison)")

# Fixture conforme aux réponses ESPN observées : dans le calendrier
# d'équipe le score est un objet, dans le scoreboard c'est un scalaire.
TEAM_SCHEDULE_EVENT = {
    "id": "401878760",
    "date": "2026-11-07T15:00Z",
    "status": {"type": {"state": "post", "completed": True}},
    "competitions": [
        {
            "date": "2026-11-07T15:00Z",
            "competitors": [
                {
                    "id": "359",
                    "homeAway": "away",
                    "score": {"value": 0.0, "displayValue": "0"},
                    "team": {"id": "359", "displayName": "Arsenal", "abbreviation": "ARS"},
                },
                {
                    "id": "306",
                    "homeAway": "home",
                    "score": {"value": 1.0, "displayValue": "1"},
                    "team": {"id": "306", "displayName": "Hull City", "abbreviation": "HUL"},
                },
            ],
        }
    ],
}

SEASON_SCOREBOARD_EVENT = {
    "id": "401878770",
    "date": "2026-10-17T14:00Z",
    "competitions": [
        {
            "date": "2026-10-17T14:00Z",
            "status": {"type": {"state": "post", "completed": True}},
            "competitors": [
                {
                    "id": "306",
                    "homeAway": "home",
                    "score": "1",
                    "team": {"id": "306", "displayName": "Hull City", "abbreviation": "HUL"},
                },
                {
                    "id": "368",
                    "homeAway": "away",
                    "score": "2",
                    "team": {"id": "368", "displayName": "Everton", "abbreviation": "EVE"},
                },
            ],
        }
    ],
}

parsed_team = espn_module._parse_event(TEAM_SCHEDULE_EVENT)
check("score lu dans le calendrier d'équipe", parsed_team and parsed_team["homeGoals"] == 1, str(parsed_team))
check("score lu dans le scoreboard de saison", espn_module._parse_event(SEASON_SCOREBOARD_EVENT)["awayGoals"] == 2)

not_completed = json.loads(json.dumps(TEAM_SCHEDULE_EVENT))
not_completed["status"]["type"]["completed"] = False
check("match non terminé ignoré", espn_module._parse_event(not_completed) is None)


async def fake_schedule_ok(client, url):
    if "/schedule" in url:
        return {"events": [TEAM_SCHEDULE_EVENT]}
    return {"events": [SEASON_SCOREBOARD_EVENT]}


async def fake_schedule_ko(client, url):
    if "/schedule" in url:
        return None
    return {"events": [SEASON_SCOREBOARD_EVENT]}


async def run_schedule(fake):
    espn_module.fetch_json = fake
    espn_module.SEASON_CACHE.clear()
    try:
        return await espn_module.fetch_team_schedule(None, "eng.1", "306", KICKOFF)
    finally:
        espn_module.fetch_json = original_fetch
        espn_module.SEASON_CACHE.clear()


history_direct = asyncio.run(run_schedule(fake_schedule_ok))
check("calendrier d'équipe exploité", len(history_direct) == 1, str(history_direct))
check("buts du calendrier d'équipe corrects", history_direct and history_direct[0]["homeGoals"] == 1, str(history_direct))

history_fallback = asyncio.run(run_schedule(fake_schedule_ko))
check("repli sur le scoreboard de saison", len(history_fallback) == 1, str(history_fallback))
check("équipe filtrée dans le repli", history_fallback and history_fallback[0]["homeId"] == "306", str(history_fallback))

form_fallback = select_form(history_fallback, "306", KICKOFF)
check("forme calculée depuis le repli", len(form_fallback) == 1, str(form_fallback))
detail_fallback = _form_detail(form_fallback, "306")
check("détail de forme cohérent", detail_fallback and detail_fallback[0]["gf"] == 1 and detail_fallback[0]["res"] == "D", str(detail_fallback))

print("")
if failures:
    print(f"✗ {len(failures)} contrôle(s) en échec : {failures}")
    sys.exit(1)
print("✓ Contrôles de la couche d'ingestion passés")

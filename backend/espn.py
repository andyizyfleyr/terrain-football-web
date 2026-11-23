"""
COUCHE D'INGESTION — ESPN
-------------------------
Le backend Python possède la couche de collecte (ESPN) : calendrier du
jour, forme récente, classement, splits terrain et style de jeu. Il ne
possède PAS le modèle : celui-ci est calculé par le service d'analyse
TypeScript (voir `main.py`), qui reste la source unique du moteur.

Toutes les valeurs produites ici ont la forme attendue par le front
(`factors.forme`, `factors.enjeu`, `factors.style`,
`factors.domicileExterieur`) : ce sont ces blocs que l'enrichissement
photmob conserve et affiche.

Règles de collectes :
  - fenêtre de forme : 60 jours glissants avant le coup d'envoi ;
  - forme détaillée : 5 derniers matchs terminés ;
  - splits domicile / extérieur : mêmes 5 matchs ;
  - style de jeu : moyenne des 3 derniers matchs terminés ;
  - toute source indisponible est neutralisée (jamais d'exception).
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import time

import httpx

ESPN_BASE = "https://site.api.espn.com/apis"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

FORM_WINDOW_DAYS = 60
FORM_MATCHES = 5
STYLE_MATCHES = 3
TIMEOUT = float(os.environ.get("ESPN_TIMEOUT", "12"))


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )


FETCH_LOG: List[Dict[str, Any]] = []


def _log_fetch(url: str, status: Optional[int], error: Optional[str] = None) -> None:
    """Trace les derniers appels ESPN (diagnostic de bout en bout)."""
    FETCH_LOG.append({"url": url, "status": status, "error": error})
    del FETCH_LOG[:-40]


async def fetch_json(client: httpx.AsyncClient, url: str) -> Optional[Any]:
    """GET JSON tolérant : toute erreur réseau renvoie None (et est tracée)."""
    try:
        response = await client.get(url)
        if response.status_code != 200:
            _log_fetch(url, response.status_code)
            return None
        return response.json()
    except Exception as exc:
        _log_fetch(url, None, f"{type(exc).__name__}: {exc}")
        return None


# --------------------------------------------------------------------------
# Utilitaires de date
# --------------------------------------------------------------------------

def parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def compact_date(value: Optional[datetime]) -> str:
    if not value:
        return ""
    return value.strftime("%Y%m%d")


# --------------------------------------------------------------------------
# Calendrier du jour
# --------------------------------------------------------------------------

def _competitors(competition: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for competitor in competition.get("competitors", []) or []:
        side = competitor.get("homeAway")
        if side in ("home", "away"):
            out[side] = competitor
    return out


def _score_value(competitor: Dict[str, Any]) -> int:
    """Score d'un concurrent ESPN.

    L'API renvoie un scalaire dans le scoreboard (`"score": "2"`) mais un
    objet dans le calendrier d'équipe (`"score": {"value": 2.0,
    "displayValue": "2"}`) : les deux formes sont gérées.
    """
    score = competitor.get("score")
    if isinstance(score, dict):
        for key in ("value", "displayValue"):
            if score.get(key) is not None:
                return _int(score.get(key))
        return 0
    return _int(score)


def _team_side(competitor: Dict[str, Any]) -> Dict[str, Any]:
    team = competitor.get("team") or {}
    return {
        "id": str(team.get("id", "")),
        "name": team.get("displayName") or team.get("name") or "",
        "short": team.get("abbreviation") or team.get("shortDisplayName") or "",
        "logo": team.get("logo") or "",
        "score": _score_value(competitor),
        "winner": competitor.get("winner"),
    }


def _int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


async def fetch_day_matches(
    client: httpx.AsyncClient, league: str, date_compact: str
) -> List[Dict[str, Any]]:
    """Matchs d'une journée (scoreboard ESPN)."""
    url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/scoreboard?dates={date_compact}"
    payload = await fetch_json(client, url)
    if not payload:
        return []

    matches: List[Dict[str, Any]] = []
    for event in payload.get("events", []) or []:
        competitions = event.get("competitions") or []
        if not competitions:
            continue
        competition = competitions[0]
        sides = _competitors(competition)
        if "home" not in sides or "away" not in sides:
            continue
        status = (event.get("status") or {}).get("type") or {}
        venue = competition.get("venue") or {}
        address = venue.get("address") or {}
        matches.append(
            {
                "id": str(event.get("id", "")),
                "date": event.get("date"),
                "league": league,
                "home": _team_side(sides["home"]),
                "away": _team_side(sides["away"]),
                "venue": venue.get("fullName") or venue.get("name") or "",
                "city": address.get("city") or "",
                "status": {
                    "state": status.get("state") or "",
                    "completed": bool(status.get("completed")),
                    "detail": status.get("detail") or "",
                },
            }
        )
    return matches


# --------------------------------------------------------------------------
# Forme récente (schedule d'équipe)
# --------------------------------------------------------------------------

def _event_completed(event: Dict[str, Any], competition: Dict[str, Any]) -> bool:
    """Le statut « terminé » vit au niveau de l'event ou de la competition."""
    for holder in (event, competition):
        status = (holder.get("status") or {}).get("type") or {}
        if status.get("completed"):
            return True
    return False


def _parse_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalise un evenement ESPN (calendrier d'equipe ou scoreboard)."""
    competitions = event.get("competitions") or []
    if not competitions:
        return None
    competition = competitions[0]
    sides = _competitors(competition)
    if "home" not in sides or "away" not in sides:
        return None
    if not _event_completed(event, competition):
        return None
    home = _team_side(sides["home"])
    away = _team_side(sides["away"])
    return {
        "id": str(event.get("id", "")),
        "date": event.get("date"),
        "homeId": home["id"],
        "homeName": home["name"],
        "awayId": away["id"],
        "awayName": away["name"],
        "homeGoals": home["score"],
        "awayGoals": away["score"],
    }


SEASON_CACHE: Dict[str, Dict[str, Any]] = {}
SEASON_CACHE_TTL = 600.0


async def fetch_league_season(
    client: httpx.AsyncClient, league: str, year: int
) -> List[Dict[str, Any]]:
    """Tous les matchs joues d'une annee civile : un seul appel ESPN.

    Sert de repli quand le calendrier d'equipe n'est pas disponible
    (reponse trop lourde ou refusee) : la charge reseau reste la meme
    pour toute la journee.
    """
    key = f"{league}:{year}"
    cached = SEASON_CACHE.get(key)
    now = time.time()
    if cached and now - cached["at"] < SEASON_CACHE_TTL:
        return cached["events"]

    url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/scoreboard?dates={year}&limit=400"
    payload = await fetch_json(client, url)
    events: List[Dict[str, Any]] = []
    seen: set = set()
    for event in (payload or {}).get("events") or []:
        parsed = _parse_event(event)
        if parsed and parsed["id"] not in seen:
            seen.add(parsed["id"])
            events.append(parsed)
    events.sort(key=lambda m: m.get("date") or "")
    SEASON_CACHE[key] = {"at": now, "events": events}
    return events


async def fetch_team_schedule(
    client: httpx.AsyncClient,
    league: str,
    team_id: str,
    kickoff: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Historique d'une equipe : chaque match avec son score et son terrain.

    Source primaire : le calendrier d'equipe ESPN. Si cet appel echoue
    (reponse lourde ou refusee), repli sur le scoreboard de la saison,
    filtré sur l'equipe concernee.
    """
    if not team_id:
        return []

    url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/teams/{team_id}/schedule"
    payload = await fetch_json(client, url)
    history: List[Dict[str, Any]] = []
    for event in (payload or {}).get("events") or []:
        parsed = _parse_event(event)
        if parsed:
            history.append(parsed)

    if not history:
        years = [kickoff.year] if kickoff else [datetime.now(timezone.utc).year]
        if kickoff and (kickoff - timedelta(days=FORM_WINDOW_DAYS)).year != kickoff.year:
            years.append((kickoff - timedelta(days=FORM_WINDOW_DAYS)).year)
        season: List[Dict[str, Any]] = []
        for year in years:
            season.extend(await fetch_league_season(client, league, year))
        history = [
            match
            for match in season
            if match["homeId"] == str(team_id) or match["awayId"] == str(team_id)
        ]

    history.sort(key=lambda m: m.get("date") or "")
    return history


def _is_home(match: Dict[str, Any], team_id: str) -> bool:
    return str(match.get("homeId")) == str(team_id)


def select_form(
    history: List[Dict[str, Any]], team_id: str, kickoff: Optional[datetime]
) -> List[Dict[str, Any]]:
    """Matchs retenus pour la forme : terminés, dans la fenêtre, avant le coup d'envoi."""
    window_start = (kickoff - timedelta(days=FORM_WINDOW_DAYS)) if kickoff else None
    selected: List[Dict[str, Any]] = []
    for match in history:
        played_at = parse_iso(match.get("date"))
        if not played_at:
            continue
        if kickoff and played_at > kickoff:
            continue
        if window_start and played_at < window_start:
            continue
        selected.append(match)
    return selected[-FORM_MATCHES:]


def _form_detail(
    matches: List[Dict[str, Any]], team_id: str
) -> List[Dict[str, Any]]:
    detail: List[Dict[str, Any]] = []
    for match in matches:
        home = _is_home(match, team_id)
        gf = match["homeGoals"] if home else match["awayGoals"]
        ga = match["awayGoals"] if home else match["homeGoals"]
        opponent = match["awayName"] if home else match["homeName"]
        opponent_id = match["awayId"] if home else match["homeId"]
        result = "V" if gf > ga else ("N" if gf == ga else "D")
        detail.append(
            {
                "id": match.get("id"),
                "date": (match.get("date") or "")[:10],
                "opponentId": opponent_id,
                "opponent": opponent,
                "venue": "home" if home else "away",
                "gf": gf,
                "ga": ga,
                "res": result,
            }
        )
    return detail


def _side_summary(
    matches: List[Dict[str, Any]], team_id: str, venue: str, label: str
) -> Dict[str, Any]:
    played = [
        m
        for m in matches
        if (_is_home(m, team_id) if venue == "home" else not _is_home(m, team_id))
    ]
    if not played:
        return {
            "resume": f"Aucun match disponible ({label})",
            "played": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
            "goalsFor": 0,
            "goalsAgainst": 0,
            "goalsForAvg": 0,
            "goalsAgainstAvg": 0,
            "count": 0,
        }
    wins = draws = losses = goals_for = goals_against = 0
    for match in played:
        home = _is_home(match, team_id)
        gf = match["homeGoals"] if home else match["awayGoals"]
        ga = match["awayGoals"] if home else match["homeGoals"]
        goals_for += gf
        goals_against += ga
        if gf > ga:
            wins += 1
        elif gf == ga:
            draws += 1
        else:
            losses += 1
    count = len(played)
    return {
        "resume": (
            f"{wins}V-{draws}N-{losses}D · {goals_for / count:.2f} bp/m · "
            f"{goals_against / count:.2f} bc/m · {count}/{FORM_MATCHES} matchs ({label})"
        ),
        "played": count,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "goalsFor": goals_for,
        "goalsAgainst": goals_against,
        "goalsForAvg": round(goals_for / count, 2),
        "goalsAgainstAvg": round(goals_against / count, 2),
        "count": count,
    }


def _overall_summary(matches: List[Dict[str, Any]], team_id: str) -> Dict[str, Any]:
    played = len(matches)
    if not played:
        return {
            "resume": "Aucun match disponible",
            "played": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
            "goalsFor": 0,
            "goalsAgainst": 0,
            "goalsForAvg": 0,
            "goalsAgainstAvg": 0,
            "count": 0,
        }
    wins = draws = losses = goals_for = goals_against = 0
    for match in matches:
        home = _is_home(match, team_id)
        gf = match["homeGoals"] if home else match["awayGoals"]
        ga = match["awayGoals"] if home else match["homeGoals"]
        goals_for += gf
        goals_against += ga
        if gf > ga:
            wins += 1
        elif gf == ga:
            draws += 1
        else:
            losses += 1
    return {
        "resume": (
            f"{wins}V-{draws}N-{losses}D · {goals_for / played:.2f} bp/m · "
            f"{goals_against / played:.2f} bc/m · {played}/{FORM_MATCHES} matchs"
        ),
        "played": played,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "goalsFor": goals_for,
        "goalsAgainst": goals_against,
        "goalsForAvg": round(goals_for / played, 2),
        "goalsAgainstAvg": round(goals_against / played, 2),
        "count": played,
    }


def _fraicheur(
    matches: List[Dict[str, Any]], kickoff: Optional[datetime]
) -> Dict[str, Any]:
    dates = [parse_iso(m.get("date")) for m in matches]
    dates = [d for d in dates if d]
    if not dates:
        return {
            "count": 0,
            "latest": None,
            "oldest": None,
            "daysSinceLatest": None,
            "windowDays": FORM_WINDOW_DAYS,
        }
    latest = max(dates)
    oldest = min(dates)
    days_since = (
        (kickoff - latest).days if kickoff else None
    )
    return {
        "count": len(matches),
        "latest": latest.strftime("%Y-%m-%d"),
        "oldest": oldest.strftime("%Y-%m-%d"),
        "daysSinceLatest": days_since,
        "windowDays": FORM_WINDOW_DAYS,
    }


# --------------------------------------------------------------------------
# Classement
# --------------------------------------------------------------------------

async def fetch_standings(
    client: httpx.AsyncClient, league: str
) -> Dict[str, Dict[str, Any]]:
    url = f"{ESPN_BASE}/v2/sports/soccer/{league}/standings"
    payload = await fetch_json(client, url)
    table: Dict[str, Dict[str, Any]] = {}
    if not payload:
        return table

    children = payload.get("children") or []
    groups = children if children else [payload]
    for group in groups:
        standings = group.get("standings") or {}
        for entry in standings.get("entries", []) or []:
            team = entry.get("team") or {}
            team_id = str(team.get("id", ""))
            if not team_id:
                continue
            values: Dict[str, Any] = {}
            for stat in entry.get("stats", []) or []:
                name = stat.get("name")
                if not name:
                    continue
                value = stat.get("value")
                display = stat.get("displayValue")
                if isinstance(value, (int, float)):
                    values[name] = value
                elif isinstance(display, str):
                    try:
                        values[name] = float(display.replace(",", "."))
                    except ValueError:
                        continue
            table[team_id] = {
                "name": team.get("displayName") or team.get("shortDisplayName") or "",
                "rank": int(values.get("rank") or 0),
                "points": int(values.get("points") or 0),
                "played": int(values.get("gamesPlayed") or 0),
                # ESPN nomme la difference de buts « pointDifferential »
                # (« goalDifference » est conserve pour compatibilite).
                "goalDifference": int(
                    values.get("pointDifferential", values.get("goalDifference")) or 0
                ),
            }
    return table


def _stake_label(rank: int, teams: int) -> str:
    if not rank or not teams:
        return "Enjeu moyen (points importants)"
    position = rank / teams
    if position <= 0.2:
        return "Course au titre / places européennes"
    if position <= 0.45:
        return "Course europeenne"
    if position <= 0.75:
        return "Enjeu moyen (points importants)"
    return "Survie en jeu — pression maximale"


# --------------------------------------------------------------------------
# Style de jeu (moyennes sur les derniers matchs)
# --------------------------------------------------------------------------

STYLE_FIELDS = {
    "possessionPct": "possession",
    "totalShots": "shots",
    "shotsOnTarget": "shotsOnTarget",
    "wonCorners": "corners",
    "yellowCards": "yellow",
    "foulsCommitted": "fouls",
}


async def fetch_style_averages(
    client: httpx.AsyncClient,
    league: str,
    matches: List[Dict[str, Any]],
    team_id: str,
) -> Optional[Dict[str, Any]]:
    """Moyenne du style de jeu sur les N derniers matchs terminés."""
    if not matches:
        return None
    sample = matches[-STYLE_MATCHES:]
    totals: Dict[str, float] = {key: 0.0 for key in STYLE_FIELDS.values()}
    counted = 0

    for match in sample:
        url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/summary?event={match.get('id')}"
        summary = await fetch_json(client, url)
        if not summary:
            continue
        side = "home" if _is_home(match, team_id) else "away"
        for team in (summary.get("boxscore") or {}).get("teams", []) or []:
            if team.get("homeAway") != side:
                continue
            stats = {}
            for stat in team.get("statistics", []) or []:
                name = stat.get("name")
                display = stat.get("displayValue")
                if not name or display is None:
                    continue
                try:
                    stats[name] = float(str(display).replace(",", "."))
                except ValueError:
                    continue
            for espn_name, target in STYLE_FIELDS.items():
                if espn_name in stats:
                    totals[target] += stats[espn_name]
            counted += 1
            break

    if not counted:
        return None
    return {
        key: round(value / counted, 1) for key, value in totals.items()
    } | {"n": counted}


# --------------------------------------------------------------------------
# Assemblage d'un match
# --------------------------------------------------------------------------

async def build_base_match(
    client: httpx.AsyncClient,
    league: str,
    match: Dict[str, Any],
    standings: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Match brut enrichi des facteurs ESPN, au format attendu par le front."""
    kickoff = parse_iso(match.get("date"))
    home_id = match["home"]["id"]
    away_id = match["away"]["id"]

    home_history = await fetch_team_schedule(client, league, home_id, kickoff)
    away_history = await fetch_team_schedule(client, league, away_id, kickoff)

    home_form = select_form(home_history, home_id, kickoff)
    away_form = select_form(away_history, away_id, kickoff)

    home_overall = _overall_summary(home_form, home_id)
    away_overall = _overall_summary(away_form, away_id)

    home_style = await fetch_style_averages(client, league, home_form, home_id)
    away_style = await fetch_style_averages(client, league, away_form, away_id)

    teams_count = len(standings) or 20
    home_standing = standings.get(home_id)
    away_standing = standings.get(away_id)

    def _standing_block(standing: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not standing:
            return None
        return {
            "rank": standing.get("rank", 0),
            "points": standing.get("points", 0),
            "gp": standing.get("played", 0),
            "gd": standing.get("goalDifference", 0),
            "name": standing.get("name", ""),
        }

    factors = {
        "forme": {
            "home": home_overall["resume"],
            "away": away_overall["resume"],
            "detailHome": _form_detail(home_form, home_id),
            "detailAway": _form_detail(away_form, away_id),
            "fraicheurHome": _fraicheur(home_form, kickoff),
            "fraicheurAway": _fraicheur(away_form, kickoff),
            "note": (
                "Forme et modèle limités aux derniers matchs terminés dans les "
                f"{FORM_WINDOW_DAYS} jours avant le coup d'envoi. Les rencontres plus "
                "anciennes sont exclues."
            ),
        },
        "domicileExterieur": {
            "home": _side_summary(home_form, home_id, "home", "à domicile")["resume"],
            "away": _side_summary(away_form, away_id, "away", "à l'extérieur")["resume"],
        },
        "enjeu": {
            "home": _stake_label(home_standing.get("rank", 0) if home_standing else 0, teams_count),
            "away": _stake_label(away_standing.get("rank", 0) if away_standing else 0, teams_count),
            "classementHome": _standing_block(home_standing),
            "classementAway": _standing_block(away_standing),
        },
        "style": {"home": home_style, "away": away_style},
        "blessures": {
            "home": "Aucune absence signalée par l'API publique",
            "away": "Aucune absence signalée par l'API publique",
            "note": (
                "L'API publique ESPN renseigne rarement les blessures : vérifiez la "
                "composition officielle avant le match."
            ),
        },
        "stats": {
            "home": {
                "attaque": home_overall["goalsForAvg"],
                "defense": home_overall["goalsAgainstAvg"],
            },
            "away": {
                "attaque": away_overall["goalsForAvg"],
                "defense": away_overall["goalsAgainstAvg"],
            },
            "note": (
                "Attaque/défense calculées à partir des derniers matchs terminés, "
                f"avec split domicile/extérieur, sur une fenêtre de {FORM_WINDOW_DAYS} jours."
            ),
        },
    }

    base = {
        "id": match["id"],
        "date": match.get("date"),
        "league": league,
        "home": match["home"],
        "away": match["away"],
        "venue": match.get("venue", ""),
        "city": match.get("city", ""),
        "expectedGoals": {
            "home": round(
                (home_overall["goalsForAvg"] + away_overall["goalsAgainstAvg"]) / 2, 2
            ),
            "away": round(
                (away_overall["goalsForAvg"] + home_overall["goalsAgainstAvg"]) / 2, 2
            ),
        },
        "market": None,
        "vigilance": {
            "score": 10,
            "level": "Faible",
            "reasons": [
                "Cotes indisponibles ou suspendues : impossible de comparer au marché."
            ],
        },
        "factors": factors,
        "limitations": [
            "Probabilités estimées par un modèle statistique hybride : jamais garanties.",
            "Le score de vigilance signale une divergence ou un aléa d'effectif, "
            "jamais une preuve de manipulation.",
        ],
    }
    return base


async def build_base_matches(
    league: str, date_compact: str, match_ids: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Matchs bruts d'une journée, enrichis des facteurs ESPN."""
    async with _client() as client:
        day = await fetch_day_matches(client, league, date_compact)
        if match_ids:
            wanted = {str(m) for m in match_ids}
            day = [m for m in day if m["id"] in wanted]
        if not day:
            return []
        standings = await fetch_standings(client, league)
        tasks = [
            build_base_match(client, league, match, standings) for match in day
        ]
        return list(await asyncio.gather(*tasks))

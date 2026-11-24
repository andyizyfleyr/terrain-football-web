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
# Les calendriers d'equipe (saison complete) sont des reponses lourdes :
# on leur laisse plus de temps et on limite le debit pour ne pas se faire
# limiter par ESPN (429) quand plusieurs matchs sont analyses en meme temps.
SLOW_TIMEOUT = float(os.environ.get("ESPN_SLOW_TIMEOUT", "30"))
MAX_CONCURRENT = int(os.environ.get("ESPN_MAX_CONCURRENT", "4"))
CACHE_TTL = float(os.environ.get("ESPN_CACHE_TTL", "600"))
DAY_CACHE_TTL = float(os.environ.get("ESPN_DAY_CACHE_TTL", "300"))
# Calendrier des competitions a phases (coupes d'Europe) : il ne change
# qu'a l'approche d'une journee, une demi-journee de cache suffit.
PHASE_CALENDAR_TTL = float(os.environ.get("ESPN_PHASE_CALENDAR_TTL", "43200"))
# Une phase de coupe dure des semaines : elle est interrogee mois par
# mois, et le nombre de mois est borne pour qu'une plage aberrante ne
# declenche pas de balayage de plusieurs annees.
_MAX_PHASE_MONTHS = 18
# Les caches sont bornes en DUREE et en NOMBRE d'entrees : sans purge, ils
# grossiraient indefiniment sur une instance qui vit longtemps (chaque
# equipe, chaque journee, chaque saison est une cle).
CACHE_MAX_ENTRIES = int(os.environ.get("ESPN_CACHE_MAX_ENTRIES", "500"))


def prune_cache(cache: Dict[str, Dict[str, Any]], ttl: float) -> None:
    """Supprime les entrees expirees et borne la taille du cache.

    L'ordre d'insertion de la dict est respecte : les plus anciennes
    entrées sont evacuées en premier.
    """
    now = time.time()
    for key in [k for k, v in cache.items() if now - v["at"] >= ttl]:
        cache.pop(key, None)
    while len(cache) > CACHE_MAX_ENTRIES:
        oldest = next(iter(cache), None)
        if oldest is None:
            break
        cache.pop(oldest, None)

# Un semaphore par boucle d'evenements (une instance Vercel peut en
# reutiliser plusieurs dans sa vie).
_SEMAPHORES: Dict[Any, asyncio.Semaphore] = {}
SCHEDULE_CACHE: Dict[str, Dict[str, Any]] = {}
DAY_CACHE: Dict[str, Dict[str, Any]] = {}
# Jours de match des competitions a phases (coupes d'Europe), deduits
# de leurs plages ESPN : voir `phase_calendar`.
PHASE_CALENDAR_CACHE: Dict[str, Dict[str, Any]] = {}

# Catalogue des competitions exposees au front (calendrier). Le slug est
# l'identifiant ESPN utilise par le scoreboard et les calendriers d'equipe.
#
# Le slug DOIT etre celui publie par ESPN : interroger un slug inconnu
# renvoie HTTP 400 et vide silencieusement le calendrier (aucun match,
# aucune erreur visible). Les slugs ci-dessous ont donc ete releves sur
# `site.api.espn.com` et valides un par un.
LEAGUE_CATALOG: List[Dict[str, Any]] = [
    {"slug": "eng.1", "name": "Premier League", "country": "Angleterre", "tier": 1},
    {"slug": "eng.2", "name": "Championship", "country": "Angleterre", "tier": 2},
    {"slug": "esp.1", "name": "LaLiga", "country": "Espagne", "tier": 1},
    {"slug": "esp.2", "name": "LaLiga2", "country": "Espagne", "tier": 2},
    {"slug": "ita.1", "name": "Serie A", "country": "Italie", "tier": 1},
    {"slug": "ita.2", "name": "Serie B", "country": "Italie", "tier": 2},
    {"slug": "fra.1", "name": "Ligue 1", "country": "France", "tier": 1},
    {"slug": "fra.2", "name": "Ligue 2", "country": "France", "tier": 2},
    {"slug": "ned.1", "name": "Eredivisie", "country": "Pays-Bas", "tier": 1},
    {"slug": "por.1", "name": "Liga Portugal", "country": "Portugal", "tier": 1},
    {"slug": "bel.1", "name": "Pro League", "country": "Belgique", "tier": 1},
    {"slug": "ger.1", "name": "Bundesliga", "country": "Allemagne", "tier": 1},
    {"slug": "sco.1", "name": "Scottish Premiership", "country": "Ecosse", "tier": 1},
    {"slug": "tur.1", "name": "Super Lig", "country": "Turquie", "tier": 1},
    {"slug": "mex.1", "name": "Liga MX", "country": "Mexique", "tier": 1},
    {"slug": "usa.1", "name": "MLS", "country": "Etats-Unis", "tier": 1},
    # Coupes d'Europe : ce sont des competitions, pas des championnats
    # nationaux. Leur calendrier ESPN est publie par PHASES (journee de
    # ligue, barrages, 8es...) et non par journees : voir
    # `season_calendar`, qui en deduit les jours de match.
    {
        "slug": "uefa.champions",
        "name": "Ligue des Champions",
        "country": "Europe",
        "tier": 1,
    },
    {
        "slug": "uefa.europa",
        "name": "Ligue Europa",
        "country": "Europe",
        "tier": 2,
    },
]

# Slugs historiques acceptes en entree, reecrits vers le slug ESPN
# courant. `deu.1` (code ISO de l'Allemagne) a longtemps ete catalogue
# alors qu'ESPN n'expose que `ger.1` : la Bundesliga renvoyait donc une
# erreur 400 et son calendrier restait vide. On garde l'alias pour que
# les liens et URL deja.partages continuent de fonctionner.
ESPN_LEAGUE_ALIASES: Dict[str, str] = {
    "deu.1": "ger.1",
}


def resolve_league_slug(league: str) -> str:
    """Slug ESPN effectif associe a un slug demande.

    Renvoie le slug tel quel s'il est inconnu : ESPN repondra par une
    erreur explicite plutot que par un resultat vide trompeur.
    """
    raw = (league or "").strip()
    return ESPN_LEAGUE_ALIASES.get(raw, raw)


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _SEMAPHORES.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        _SEMAPHORES[loop] = semaphore
    return semaphore


def _client(timeout: Optional[float] = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=timeout or TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )


FETCH_LOG: List[Dict[str, Any]] = []


def _log_fetch(url: str, status: Optional[int], error: Optional[str] = None) -> None:
    """Trace les derniers appels ESPN (diagnostic de bout en bout)."""
    FETCH_LOG.append({"url": url, "status": status, "error": error})
    del FETCH_LOG[:-40]


async def fetch_json(
    client: httpx.AsyncClient,
    url: str,
    retries: int = 2,
    timeout: Optional[float] = None,
) -> Optional[Any]:
    """GET JSON tolerant : retry avec backoff sur 429/5xx/timeout.

    ESPN limite le debit sur les calendriers d'equipe : une requete qui
    echoue est rejouee apres une courte pause au lieu de renvoyer une
    donnee vide.
    """
    delay = 0.6
    for attempt in range(retries + 1):
        try:
            async with _semaphore():
                response = await client.get(url, timeout=timeout)
            if response.status_code == 200:
                return response.json()
            if response.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                _log_fetch(url, response.status_code, f"nouvelle tentative {attempt + 1}")
                await asyncio.sleep(delay)
                delay *= 2
                continue
            _log_fetch(url, response.status_code)
            return None
        except Exception as exc:
            if attempt < retries:
                _log_fetch(url, None, f"{type(exc).__name__}: {exc} — nouvelle tentative {attempt + 1}")
                await asyncio.sleep(delay)
                delay *= 2
                continue
            _log_fetch(url, None, f"{type(exc).__name__}: {exc}")
            return None
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


async def fetch_day_scoreboard(
    client: httpx.AsyncClient, league: str, date_compact: str
) -> Dict[str, Any]:
    """Charge utile brute du scoreboard ESPN pour une date.

    Renvoie un dict vide si ESPN refuse le slug (HTTP 400 sur une ligue
    inconnue) : l'appelant distingue ainsi « pas de match ce jour-la »
    de « cette ligue n'existe pas ».
    """
    league = resolve_league_slug(league)
    url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/scoreboard?dates={date_compact}"
    payload = await fetch_json(client, url)
    return payload if isinstance(payload, dict) else {}


def _phase_ranges(payload: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Plages de dates des phases de la competition (`calendar` ESPN).

    Les coupes d'Europe (Ligue des Champions, Ligue Europa) ne publient
    pas de liste de journees mais de PHASES : `entries` porte alors des
    objets `{label, startDate, endDate}` (journee de ligue, barrages,
    8es...). La plage est ramenee en dates compactes `AAAAMMJJ`.
    """
    leagues = payload.get("leagues") or []
    if not leagues:
        return []
    ranges: List[Tuple[str, str]] = []
    for group in leagues[0].get("calendar") or []:
        entries = group.get("entries") if isinstance(group, dict) else None
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            start = _compact_day(entry.get("startDate"))
            end = _compact_day(entry.get("endDate")) or start
            if start:
                ranges.append((start, end or start))
    return ranges


def _compact_day(value: Any) -> str:
    """Date ISO (`2026-08-27T07:00Z`) ramenee en `20260827`."""
    day = str(value or "")[:10].replace("-", "")
    return day if len(day) == 8 and day.isdigit() else ""


def season_calendar(payload: Dict[str, Any]) -> List[str]:
    """Journees de la saison telles que publiees par ESPN.

    Le scoreboard de n'importe quelle date de la saison publie la liste
    des journees (`leagues[0].calendar`). Elle est decisive : une ligue
    peut etre en pause (coupe du monde, trêve) et ne servir aucun match
    pendant plusieurs semaines, sans etre invalide. La calendrier
    permet de distinguer les deux cas — et de retrouver une journee qui
    a vraiment eu lieu.

    Les competitions a phases (coupes d'Europe) publient des plages et
    non des journees : la liste des jours « de match » est alors deduite
    des phases (voir `_phase_ranges` et `phase_calendar`) plutot que de
    renvoyer une liste vide, qui ferait passer la competition pour
    cassee.
    """
    leagues = payload.get("leagues") or []
    if not leagues:
        return []
    calendar = leagues[0].get("calendar") or []
    days: List[str] = []
    for entry in calendar:
        day = str(entry)[:10].replace("-", "")
        if len(day) == 8 and day.isdigit():
            days.append(day)
    return sorted(set(days))


def _months_in_range(start: str, end: str) -> List[str]:
    """Mois civils (`AAAAMM`) couverts par une plage, bornes comprises."""
    if end < start:
        start, end = end, start
    months: List[str] = []
    year, month = int(start[:4]), int(start[4:6])
    last = (int(end[:4]), int(end[4:6]))
    while (year, month) <= last and len(months) < _MAX_PHASE_MONTHS:
        months.append(f"{year}{month:02d}")
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return months


def _month_match_days(payload: Dict[str, Any]) -> List[str]:
    """Jours qui portent un match dans la charge utile d'un mois.

    `dates=202611` renvoie les seuls matchs du mois : les dates des
    evenements sont donc directement les jours ou l'on joue.
    """
    days: List[str] = []
    for event in payload.get("events") or []:
        day = _compact_day(event.get("date"))
        if day:
            days.append(day)
    return days


async def _phase_match_days(
    client: "httpx.AsyncClient", league: str, ranges: List[Tuple[str, str]]
) -> List[str]:
    """Jours de match reels a l'interieur des phases d'une competition.

    ESPN ne publie pas de journees pour les coupes d'Europe, seulement
    des phases (journee de ligue, barrages, 8es...). Chaque phase dure
    des semaines : on interroge le scoreboard MOIS par MOIS sur les
    mois couverts par les phases, puis on ne garde que les dates qui
    portent reellement un match.

    Le resultat se comporte comme un calendrier de championnat (trie,
    sans doublon, journees deja jouees comprises), ce qui permet a
    `/api/smoke` de valider la competition avec les memes regles.
    """
    months: List[str] = []
    for start, end in ranges:
        for month in _months_in_range(start, end):
            if month not in months:
                months.append(month)
    days: List[str] = []
    for month in months:
        payload = await fetch_day_scoreboard(client, league, month)
        days.extend(_month_match_days(payload))
    return sorted(set(days))


def _calendar_span(
    ranges: List[Tuple[str, str]], today_compact: str
) -> List[Tuple[str, str]]:
    """Fenetre reellement utile du calendrier d'une competition.

    Le calendrier sert a retrouver une journee DEJA JOUEE quand la
    competition est entre deux rendez-vous : la fenetre va donc du
    premier jour de la saison jusqu'au dernier, bornee a AUJOURD'HUI.
    Les phases a venir n'ont pas besoin d'etre balayees : elles
    n'apportent aucune journee deja jouee, et chaque mois interroge est
    un appel ESPN.
    """
    span: List[Tuple[str, str]] = []
    for start, end in ranges:
        if start > today_compact:
            continue
        limited_end = min(end, today_compact)
        span.append((start, limited_end))
    return span


async def phase_calendar(
    client: "httpx.AsyncClient", league: str, payload: Dict[str, Any]
) -> List[str]:
    """Calendrier des competitions a phases : les jours ou l'on joue.

    ESPN ne publie pas de journees pour les coupes d'Europe, seulement
    des phases. On interroge le scoreboard mois par mois, uniquement
    sur la fenetre deja ecoulee de la saison (`_calendar_span`), et on
    ne conserve que les jours qui portent un match : la liste obtenue
    se comporte comme un calendrier de championnat (triee, sans
    doublon, journees deja jouees comprises).

    Le resultat est mis en cache 12 h : il ne change qu'a l'approche
    d'une journee, et le balayage coute plusieurs appels ESPN.
    """
    ranges = _phase_ranges(payload)
    if not ranges:
        return []
    league = resolve_league_slug(league)
    today_compact = datetime.now(timezone.utc).strftime("%Y%m%d")
    span = _calendar_span(ranges, today_compact)
    if not span:
        return []
    cache_key = f"{league}:phases:{today_compact}"
    cached = PHASE_CALENDAR_CACHE.get(cache_key)
    if cached and (time.time() - cached["at"]) < PHASE_CALENDAR_TTL:
        return list(cached["days"])
    days = await _phase_match_days(client, league, span)
    # Une saison sans match encore joue (ete) : on ne memorise pas ce
    # verdict, il changera des le premier coup d'envoi.
    if days:
        prune_cache(PHASE_CALENDAR_CACHE, PHASE_CALENDAR_TTL)
        PHASE_CALENDAR_CACHE[cache_key] = {"at": time.time(), "days": days}
    return days



def _events_from_scoreboard(
    payload: Dict[str, Any], league: str
) -> List[Dict[str, Any]]:
    """Matchs normalises depuis la charge utile brute du scoreboard ESPN."""
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


async def fetch_day_matches(
    client: httpx.AsyncClient, league: str, date_compact: str
) -> List[Dict[str, Any]]:
    """Matchs d'une journée (scoreboard ESPN)."""
    payload = await fetch_day_scoreboard(client, league, date_compact)
    if not payload:
        return []
    return _events_from_scoreboard(payload, resolve_league_slug(league))


# --------------------------------------------------------------------------
async def fetch_day_fixtures(
    client: httpx.AsyncClient,
    league: str,
    date_compact: str,
    _resolve_phases: bool = True,
) -> Dict[str, Any]:
    """Matchs d'une journee au format du front, avec cache court.

    Renvoie les matchs de la journee (`events`) et le calendrier de la
    saison (`calendar`, journees publiees par ESPN). Le calendrier
    accompagne le scoreboard dans la meme reponse ESPN : le servir ne
    coute donc aucune requete supplementaire pour un championnat.

    Les coupes d'Europe publient des PHASES et non des journees : quand
    le calendrier ESPN est vide, leurs jours de match sont deduits des
    plages de phases (`phase_calendar`, mise en cache 12 h). La
    deduction est faite AVANT de poser l'entree de cache du jour, pour
    qu'aucune reponse sans calendrier ne soit servie ensuite.

    Le cache est court (5 min) car les scores changent pendant la journee.
    """
    league = resolve_league_slug(league)
    key = f"{league}:{date_compact}"
    cached = DAY_CACHE.get(key)
    if cached and (time.time() - cached["at"]) < DAY_CACHE_TTL:
        return cached["payload"]

    payload = await fetch_day_scoreboard(client, league, date_compact)
    calendar = season_calendar(payload)
    if not calendar and _resolve_phases:
        # Championnat : `calendar` est deja la liste des journees.
        # Competition a phases : on reconstitue les jours de match.
        calendar = await phase_calendar(client, league, payload)
    events: List[Dict[str, Any]] = []
    for match in _events_from_scoreboard(payload, league):
        home = match.get("home") or {}
        away = match.get("away") or {}
        events.append(
            {
                "id": match.get("id"),
                "date": match.get("date"),
                "name": f"{home.get('name', '')} - {away.get('name', '')}",
                "league": league,
                "home": home,
                "away": away,
                "venue": match.get("venue") or "",
                "city": match.get("city") or "",
                "completed": bool((match.get("status") or {}).get("completed")),
            }
        )
    result = {"events": events, "calendar": calendar}
    prune_cache(DAY_CACHE, DAY_CACHE_TTL)
    DAY_CACHE[key] = {"at": time.time(), "payload": result}
    return result


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
    league = resolve_league_slug(league)
    key = f"{league}:{year}"
    cached = SEASON_CACHE.get(key)
    now = time.time()
    if cached and now - cached["at"] < SEASON_CACHE_TTL:
        return cached["events"]

    url = f"{ESPN_BASE}/site/v2/sports/soccer/{league}/scoreboard?dates={year}&limit=1000"
    payload = await fetch_json(client, url)
    events: List[Dict[str, Any]] = []
    seen: set = set()
    for event in (payload or {}).get("events") or []:
        parsed = _parse_event(event)
        if parsed and parsed["id"] not in seen:
            seen.add(parsed["id"])
            events.append(parsed)
    events.sort(key=lambda m: m.get("date") or "")
    prune_cache(SEASON_CACHE, SEASON_CACHE_TTL)
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
    league = resolve_league_slug(league)
    if not team_id:
        return []

    # Sans `season`, ESPN renvoie le calendrier de la PROCHAINE saison
    # (aucun match termine) : la forme recentielle serait vide. La
    # saison est donc toujours explicite.
    current_year = season_year(kickoff)
    years = [current_year]
    window_start = (kickoff - timedelta(days=FORM_WINDOW_DAYS)) if kickoff else None
    if window_start and season_year(window_start) != current_year:
        years.append(season_year(window_start))

    history: List[Dict[str, Any]] = []
    seen: set = set()
    for year in years:
        url = (
            f"{ESPN_BASE}/site/v2/sports/soccer/{league}/teams/{team_id}"
            f"/schedule?season={year}"
        )
        cache_key = f"{league}:{team_id}:{year}"
        cached = SCHEDULE_CACHE.get(cache_key)
        payload = None
        if cached and (time.time() - cached["at"]) < CACHE_TTL:
            payload = cached["payload"]
        else:
            payload = await fetch_json(client, url, timeout=SLOW_TIMEOUT)
            if payload is not None:
                prune_cache(SCHEDULE_CACHE, CACHE_TTL)
                SCHEDULE_CACHE[cache_key] = {"at": time.time(), "payload": payload}
        for event in (payload or {}).get("events") or []:
            parsed = _parse_event(event)
            if parsed and parsed["id"] not in seen:
                seen.add(parsed["id"])
                history.append(parsed)

    if not history:
        # Dernier recours : scoreboard de la ligue sur les annees concernees.
        season: List[Dict[str, Any]] = []
        for year in {current_year, current_year - 1}:
            season.extend(await fetch_league_season(client, league, year))
        history = []
        for match in season:
            if match["id"] in seen:
                continue
            if match["homeId"] == str(team_id) or match["awayId"] == str(team_id):
                seen.add(match["id"])
                history.append(match)

    history.sort(key=lambda m: m.get("date") or "")
    return history


def season_year(kickoff: Optional[datetime]) -> int:
    """Annee de saison ESPN (saison europeenne : aout -> juillet).

    `season=2026` designe la saison 2026-27 : c'est l'annee de saison
    qu'ESPN attend, pas l'annee civile.
    """
    if not kickoff:
        return datetime.now(timezone.utc).year
    return kickoff.year if kickoff.month >= 7 else kickoff.year - 1


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
    league = resolve_league_slug(league)
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
    league = resolve_league_slug(league)
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
    include_style: bool = True,
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

    if include_style:
        home_style = await fetch_style_averages(client, league, home_form, home_id)
        away_style = await fetch_style_averages(client, league, away_form, away_id)
    else:
        # Balayage de la journee : le resume de style coute 6 requetes ESPN
        # par match (3 par equipe) — reserve a la fiche du match.
        home_style = None
        away_style = None

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
        # Fiche d'un match : contexte complet (style de jeu inclus).
        # Balayage de la journee : contexte leger, pour ne pas saturer ESPN.
        include_style = bool(match_ids)
        tasks = [
            build_base_match(client, league, match, standings, include_style)
            for match in day
        ]
        return list(await asyncio.gather(*tasks))

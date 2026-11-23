'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MatchAnalysisPanel, TeamBadge } from './components/MatchAnalysisPanel';
import {
  buildMatchUrl,
  cachedLeagues,
  clearResumeScrollOnly,
  DayEvents,
  Fixture,
  isFixtureFinished,
  keyFor,
  League,
  MonthFixture,
  monthFixturesCache,
  monthLabel,
  pad,
  readResumeSnapshot,
  saveResumeSnapshot,
  setCachedLeagues,
  shortDate,
  StatusTab,
  timeOf,
  todayKey,
} from './lib/terrain';

type SheetState = {
  item: MonthFixture;
  pushedUrl: boolean;
} | null;

export default function Home() {
  const router = useRouter();

  const [leagues, setLeagues] = useState<League[]>(cachedLeagues || []);
  const [league, setLeague] = useState('eng.1');
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));
  const [statusTab, setStatusTab] = useState<StatusTab>('upcoming');
  const [search, setSearch] = useState('');
  const [lastMatchId, setLastMatchId] = useState('');

  const [dayEvents, setDayEvents] = useState<DayEvents>({});
  const [monthLoading, setMonthLoading] = useState(true);
  const [screening, setScreening] = useState(false);
  const [screenedScores, setScreenedScores] = useState<Record<string, any>>({});
  const [calendarError, setCalendarError] = useState('');

  const [hydrated, setHydrated] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<SheetState>(null);

  const pendingRestoreRef = useRef<{ scrollY: number; matchId: string } | null>(null);

  // 1. Restauration initiale depuis l'URL ou le snapshot de session (système de reprise)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlLeague = params.get('league');
    const urlMonth = params.get('month');
    const urlStatus = params.get('status') as StatusTab | null;
    const urlSearch = params.get('q');

    const snapshot = readResumeSnapshot();

    const nextLeague = urlLeague || snapshot?.league || 'eng.1';
    const nextMonth = urlMonth || snapshot?.month || todayKey().slice(0, 7);
    const nextStatus: StatusTab =
      urlStatus && ['upcoming', 'finished'].includes(urlStatus)
        ? urlStatus
        : snapshot?.statusTab && ['upcoming', 'finished'].includes(snapshot.statusTab)
        ? snapshot.statusTab
        : 'upcoming';
    const nextSearch = urlSearch !== null ? urlSearch : snapshot?.search || '';

    setLeague(nextLeague);
    setMonth(nextMonth);
    setStatusTab(nextStatus);
    setSearch(nextSearch);

    if (snapshot) {
      setLastMatchId(snapshot.lastMatchId || '');
      if (snapshot.scrollY >= 0 || snapshot.lastMatchId) {
        pendingRestoreRef.current = {
          scrollY: snapshot.scrollY,
          matchId: snapshot.lastMatchId,
        };
      }
    }

    const cached = monthFixturesCache.get(`${nextLeague}:${nextMonth}`);
    if (cached) {
      setDayEvents(cached);
      setMonthLoading(false);
    }

    setHydrated(true);
  }, []);

  // 2. Chargement des compétitions
  useEffect(() => {
    if (cachedLeagues && cachedLeagues.length > 0) {
      setLeagues(cachedLeagues);
      return;
    }
    fetch('/api/leagues')
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(d => {
        const list = d.leagues || [];
        setCachedLeagues(list);
        setLeagues(list);
      })
      .catch(() => setCalendarError('Impossible de charger les compétitions. Réessayez dans un instant.'));
  }, []);

  // 3. Synchronisation de l'URL et sauvegarde de l'état de reprise (filtres, mois, ligue)
  useEffect(() => {
    if (!hydrated || mobileSheet) return;
    const params = new URLSearchParams();
    params.set('league', league);
    params.set('month', month);
    if (statusTab !== 'upcoming') params.set('status', statusTab);
    if (search.trim()) params.set('q', search.trim());
    const nextUrl = `/?${params.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
    const prev = readResumeSnapshot();
    saveResumeSnapshot({
      league,
      month,
      statusTab,
      search,
      scrollY: prev?.scrollY ?? -1,
      lastMatchId,
      lastMatchDayKey: prev?.lastMatchDayKey || '',
      timestamp: Date.now(),
    });
  }, [hydrated, league, month, statusTab, search, lastMatchId, mobileSheet]);

  // 4. Chargement des matchs du mois (avec cache mémoire pour retour instantané)
  useEffect(() => {
    if (!hydrated || !league || !month) return;
    const cacheKey = `${league}:${month}`;
    const cached = monthFixturesCache.get(cacheKey);
    if (cached) {
      setDayEvents(cached);
      setMonthLoading(false);
      setCalendarError('');
      return;
    }

    let active = true;
    const [year, monthNumber] = month.split('-').map(Number);
    const totalDays = new Date(year, monthNumber, 0).getDate();
    const keys = Array.from({ length: totalDays }, (_, i) => keyFor(year, monthNumber, i + 1));

    setMonthLoading(true);
    setCalendarError('');
    setDayEvents({});
    setScreenedScores({});

    const load = async () => {
      const combined: DayEvents = {};
      let failures = 0;
      for (let i = 0; i < keys.length; i += 6) {
        const batch = keys.slice(i, i + 6);
        const results = await Promise.all(
          batch.map(async key => {
            try {
              const response = await fetch(`/api/fixtures?league=${encodeURIComponent(league)}&date=${key.replaceAll('-', '')}`);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const payload = await response.json();
              return [key, (payload.events || []) as Fixture[]] as const;
            } catch {
              failures += 1;
              return [key, [] as Fixture[]] as const;
            }
          })
        );
        if (!active) return;
        for (const [key, events] of results) combined[key] = events;
        setDayEvents({ ...combined });
      }
      if (!active) return;
      if (failures === keys.length) {
        setCalendarError('Le calendrier est temporairement indisponible. Vérifiez votre connexion puis actualisez.');
      } else {
        if (failures === 0) {
          monthFixturesCache.set(cacheKey, { ...combined });
        } else {
          setCalendarError(`Calendrier partiel : ${failures} journées n’ont pas pu être chargées.`);
        }
      }
      setMonthLoading(false);
    };
    load();
    return () => {
      active = false;
    };
  }, [hydrated, league, month]);

  const monthFixtures = useMemo<MonthFixture[]>(() => {
    return Object.entries(dayEvents)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([dayKey, events]) => events.map(item => ({ ...item, dayKey })))
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.dayKey.localeCompare(b.dayKey));
  }, [dayEvents]);

  const counts = useMemo(() => {
    let finishedCount = 0;
    let upcomingCount = 0;
    for (const item of monthFixtures) {
      if (isFixtureFinished(item)) finishedCount += 1;
      else upcomingCount += 1;
    }
    return {
      upcoming: upcomingCount,
      finished: finishedCount,
    };
  }, [monthFixtures]);

  const visibleFixtures = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthFixtures.filter(item => {
      const done = isFixtureFinished(item);
      if (statusTab === 'finished' && !done) return false;
      if (statusTab === 'upcoming' && done) return false;
      if (!q) return true;
      return `${item.home?.name || ''} ${item.away?.name || ''} ${item.venue || ''} ${shortDate(item.dayKey)}`
        .toLowerCase()
        .includes(q);
    });
  }, [monthFixtures, statusTab, search]);

  // 5. Restauration de la position de scroll et mise en évidence de la carte cliquée
  useEffect(() => {
    if (!hydrated || monthLoading || !pendingRestoreRef.current) return;
    if (monthFixtures.length === 0) return;

    const target = pendingRestoreRef.current;
    pendingRestoreRef.current = null;

    requestAnimationFrame(() => {
      const cardEl = target.matchId ? document.getElementById(`match-card-${target.matchId}`) : null;
      if (target.scrollY >= 0) {
        window.scrollTo({ top: target.scrollY, behavior: 'instant' as ScrollBehavior });
      } else if (cardEl) {
        cardEl.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      }
      clearResumeScrollOnly();
    });
  }, [hydrated, monthLoading, monthFixtures.length]);

  // 6. Gestion du bouton Retour navigateur quand le bottomsheet mobile est ouvert
  useEffect(() => {
    const onPopState = () => {
      setMobileSheet(prev => (prev ? null : prev));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Bloquer le scroll d'arrière-plan quand le bottomsheet mobile est ouvert + support geste swipe-down
  const touchStartYRef = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  const closeMobileSheet = useCallback(() => {
    setDragOffset(0);
    setMobileSheet(prev => {
      if (!prev) return null;
      if (prev.pushedUrl && typeof window !== 'undefined') {
        window.history.back();
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!mobileSheet) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMobileSheet();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileSheet, closeMobileSheet]);

  const handleOpenMatch = (event: React.MouseEvent<HTMLAnchorElement>, item: MonthFixture) => {
    // Laisser le comportement natif pour Ctrl/Cmd+clic ou clic molette
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();

    const currentScrollY = window.scrollY;
    setLastMatchId(item.id);
    saveResumeSnapshot({
      league,
      month,
      statusTab,
      search,
      scrollY: currentScrollY,
      lastMatchId: item.id,
      lastMatchDayKey: item.dayKey,
      timestamp: Date.now(),
    });

    const matchUrl = buildMatchUrl(league, item.dayKey, item.id);
    const isMobile = window.matchMedia('(max-width: 760px)').matches;

    if (isMobile) {
      window.history.pushState({ bottomSheetMatch: item.id }, '', matchUrl);
      setMobileSheet({ item, pushedUrl: true });
    } else {
      router.push(matchUrl);
    }
  };

  const datesWithMatches = Object.entries(dayEvents).filter(([, events]) => events.length > 0);
  const monthMatchCount = monthFixtures.length;
  const currentLeagueName = leagues.find(item => item.slug === league)?.name || league;

  const changeLeague = (nextLeague: string) => {
    setLeague(nextLeague);
    setLastMatchId('');
    setSearch('');
  };

  const changeMonth = (delta: number) => {
    const d = new Date(`${month}-01T12:00:00`);
    d.setMonth(d.getMonth() + delta);
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    setLastMatchId('');
  };

  const scanMonth = async () => {
    const dayKeys = Array.from(new Set(visibleFixtures.map(item => item.dayKey)));
    if (!dayKeys.length) return;
    setScreening(true);
    try {
      const next: Record<string, any> = {};
      for (let i = 0; i < dayKeys.length; i += 4) {
        const batch = dayKeys.slice(i, i + 4);
        await Promise.all(
          batch.map(async dayKey => {
            const response = await fetch(`/api/analyze?league=${encodeURIComponent(league)}&date=${dayKey.replaceAll('-', '')}`);
            if (!response.ok) return;
            const payload = await response.json();
            (payload.matches || []).forEach((match: any) => {
              if (match.vigilance) next[match.id] = match.vigilance;
            });
          })
        );
        setScreenedScores(prev => ({ ...prev, ...next }));
      }
    } catch {
      setCalendarError('Le scan de vigilance n’a pas abouti. Réessayez.');
    } finally {
      setScreening(false);
    }
  };

  return (
    <main className="appShell">
      <header className="appHeader">
        <a className="brand" href="#top" aria-label="Terrain, accueil">
          <span className="brandMark">T</span>
          <span className="brandWords">
            TERRAIN
            <small>FOOTBALL INTELLIGENCE</small>
          </span>
        </a>
        <nav className="mainNav" aria-label="Navigation principale">
          <a className="navActive" href="#rencontres">
            Rencontres
          </a>
        </nav>
        <div className="dataStatus">
          <span className="statusPulse" /> API publique <i /> ESPN
        </div>
      </header>

      <section className="appHero" id="top">
        <div className="heroCopy">
          <div className="eyebrow">
            <span /> CENTRE DE MATCHS · SAISON EN COURS
          </div>
          <h1>
            Le calendrier,
            <br />
            <em>en un coup d’œil.</em>
          </h1>
          <p>
            Choisissez une compétition, parcourez tous les matchs du mois sous forme de cartes, puis ouvrez une rencontre pour consulter
            son analyse complète.
          </p>
          <div className="heroStats">
            <span>
              <b>08</b> facteurs examinés
            </span>
            <span>
              <b>16</b> compétitions
            </span>
            <span className="estimateNote">
              <i /> estimations, jamais garanties
            </span>
          </div>
        </div>
        <div className="heroPitch" aria-hidden="true">
          <div className="pitchCircle" />
          <div className="pitchLine" />
          <div className="pitchBall">⚽</div>
          <span>DATA / 90</span>
        </div>
      </section>

      <section className="toolbar" aria-label="Filtres du calendrier">
        <label className="selectField">
          <span className="fieldIcon">◈</span>
          <span className="fieldCopy">
            <small>COMPÉTITION</small>
            <select value={league} onChange={event => changeLeague(event.target.value)}>
              {leagues.map(item => (
                <option key={item.slug} value={item.slug}>
                  {item.name} · {item.country}
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="monthControl">
          <button className="iconButton" onClick={() => changeMonth(-1)} aria-label="Mois précédent">
            ‹
          </button>
          <div>
            <small>CALENDRIER MENSUEL</small>
            <strong>{monthLabel(month)}</strong>
          </div>
          <button className="iconButton" onClick={() => changeMonth(1)} aria-label="Mois suivant">
            ›
          </button>
        </div>
        <button
          className="todayButton"
          onClick={() => {
            setMonth(todayKey().slice(0, 7));
            setLastMatchId('');
          }}
        >
          <span>↻</span> Ce mois-ci
        </button>
        <div className="monthTotals">
          <b>{monthMatchCount}</b>
          <span>
            matchs
            <br />
            ce mois
          </span>
        </div>
      </section>

      <section className="monthMatchesPanel" id="rencontres">
        <div className="sectionHeader monthMatchesHeader">
          <div>
            <span className="sectionKicker">
              {currentLeagueName.toUpperCase()} · {monthLabel(month).toUpperCase()}
            </span>
            <h2>Tous les matchs du mois</h2>
            <p>
              {calendarError ? (
                <span className="inlineError">{calendarError}</span>
              ) : monthLoading ? (
                <>
                  <i className="tinySpinner" /> Chargement des rencontres du mois…
                </>
              ) : (
                <>
                  {monthMatchCount} rencontre{monthMatchCount > 1 ? 's' : ''} sur {datesWithMatches.length} journée
                  {datesWithMatches.length > 1 ? 's' : ''} · heures locales de Cotonou
                </>
              )}
            </p>
          </div>
          <div className="monthMatchesActions">
            {monthFixtures.length > 0 && (
              <>
                <label className="matchSearch monthSearch">
                  <span>⌕</span>
                  <input
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="Rechercher une équipe, un stade ou une date"
                  />
                </label>
                <button className="scanButton monthScanButton" onClick={scanMonth} disabled={screening || monthLoading}>
                  {screening ? (
                    <>
                      <i className="tinySpinner" /> Scan en cours…
                    </>
                  ) : (
                    <>⌕ &nbsp; Scanner les matchs</>
                  )}
                </button>
              </>
            )}
            <span className="dayCount">
              {visibleFixtures.length} match{visibleFixtures.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Onglets (Tabs) : À venir (par défaut) / Terminés */}
        <div className="statusTabsBar" role="tablist" aria-label="Statut des rencontres">
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'upcoming'}
            className={`statusTabButton ${statusTab === 'upcoming' ? 'statusTabActive' : ''}`}
            onClick={() => setStatusTab('upcoming')}
          >
            <span>À venir</span>
            <b>{counts.upcoming}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'finished'}
            className={`statusTabButton ${statusTab === 'finished' ? 'statusTabActive' : ''}`}
            onClick={() => setStatusTab('finished')}
          >
            <span>Terminés</span>
            <b>{counts.finished}</b>
          </button>
        </div>

        {monthFixtures.length > 0 ? (
          <>
            {visibleFixtures.length > 0 ? (
              <div className="monthCardsGrid">
                {visibleFixtures.map((item, index) => {
                  const score = screenedScores[item.id];
                  const finished = isFixtureFinished(item);
                  const isLastVisited = lastMatchId === item.id;
                  const matchHref = buildMatchUrl(league, item.dayKey, item.id);

                  return (
                    <Link
                      key={`${item.dayKey}-${item.id}`}
                      id={`match-card-${item.id}`}
                      href={matchHref}
                      prefetch={false}
                      className={`matchCard monthMatchCard ${isLastVisited ? 'matchResumed' : ''}`}
                      onClick={e => handleOpenMatch(e, item)}
                    >
                      <span className="matchCardTop">
                        <span className="matchOrdinal">{String(index + 1).padStart(2, '0')}</span>
                        <span className="matchDatePill">{shortDate(item.dayKey)}</span>
                        <span>{timeOf(item.date)} · COT</span>
                        {finished ? (
                          <span className="cardStateTag stateDone">Terminé</span>
                        ) : (
                          <span className="cardStateTag stateUpcoming">À venir</span>
                        )}
                        {score && (
                          <span className={`riskBadge ${score.score >= 30 ? 'riskHigh' : ''}`} title={`Signal exploratoire : ${score.level}`}>
                            Vigilance {score.score}
                          </span>
                        )}
                      </span>
                      <span className="matchTeams">
                        <span>
                          <TeamBadge team={item.home} size={34} />
                          <b>{item.home?.name}</b>
                          {finished && <strong>{item.home?.score}</strong>}
                        </span>
                        <span>
                          <TeamBadge team={item.away} size={34} />
                          <b>{item.away?.name}</b>
                          {finished && <strong>{item.away?.score}</strong>}
                        </span>
                      </span>
                      <span className="matchCardFoot">
                        <span>{item.venue || 'Lieu non renseigné'}</span>
                        <span className="openArrow">
                          {isLastVisited ? 'CONSULTÉ · REVOIR' : 'VOIR L’ANALYSE'} <b>→</b>
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="emptyState">
                <span className="emptyIcon">⚽</span>
                <b>
                  {search.trim()
                    ? `Aucune rencontre ne correspond à « ${search} »`
                    : statusTab === 'upcoming'
                    ? 'Aucun match à venir sur ce mois'
                    : 'Aucun match terminé sur ce mois'}
                </b>
                <span>Essayez de changer d’onglet ou de modifier votre recherche.</span>
              </div>
            )}
            <p className="panelDisclaimer">Les scores de vigilance sont des signaux exploratoires, pas des preuves de manipulation.</p>
          </>
        ) : monthLoading ? (
          <div className="emptyState">
            <i className="largeSpinner" />
            <b>Chargement des matchs du mois</b>
            <span>
              Récupération des rencontres de {currentLeagueName} pour {monthLabel(month)}…
            </span>
          </div>
        ) : (
          <div className="emptyState">
            <span className="emptyIcon">⚽</span>
            <b>Aucun match programmé ce mois-ci</b>
            <span>Changez de mois ou sélectionnez une autre compétition pour afficher ses rencontres.</span>
          </div>
        )}
      </section>

      {/* Bottom Sheet sur mobile */}
      {mobileSheet && (
        <div
          className="bottomSheetBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Analyse de la rencontre"
          onClick={e => {
            if (e.target === e.currentTarget) closeMobileSheet();
          }}
        >
          <div
            className="bottomSheetSheet"
            style={dragOffset > 0 ? { transform: `translateY(${dragOffset}px)`, transition: 'none' } : undefined}
          >
            <div
              className="bottomSheetHeader"
              onTouchStart={e => {
                touchStartYRef.current = e.touches[0]?.clientY ?? null;
              }}
              onTouchMove={e => {
                if (touchStartYRef.current === null) return;
                const delta = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current;
                if (delta > 0) setDragOffset(delta);
              }}
              onTouchEnd={() => {
                if (dragOffset > 90) {
                  closeMobileSheet();
                } else {
                  setDragOffset(0);
                }
                touchStartYRef.current = null;
              }}
            >
              <button
                type="button"
                className="bottomSheetGrabberBtn"
                onClick={closeMobileSheet}
                aria-label="Fermer la feuille d’analyse"
              >
                <span className="bottomSheetGrabber" />
              </button>
              <div className="bottomSheetTopRow">
                <button
                  type="button"
                  className="openFullPageLink"
                  onClick={() => {
                    const targetUrl = buildMatchUrl(league, mobileSheet.item.dayKey, mobileSheet.item.id);
                    setMobileSheet(null);
                    router.push(targetUrl);
                  }}
                >
                  Page dédiée ↗
                </button>
                <button type="button" className="bottomSheetCloseBtn" onClick={closeMobileSheet} aria-label="Fermer">
                  ✕ Fermer
                </button>
              </div>
            </div>
            <div className="bottomSheetContent">
              <MatchAnalysisPanel
                leagueSlug={league}
                leagueName={currentLeagueName}
                dayKey={mobileSheet.item.dayKey}
                matchId={mobileSheet.item.id}
                initialFixture={mobileSheet.item}
              />
            </div>
          </div>
        </div>
      )}

      <footer className="appFooter">
        <span>© TERRAIN · FOOTBALL INTELLIGENCE</span>
        <span>DONNÉES PUBLIQUES ESPN · ESTIMATIONS, JAMAIS DES CERTITUDES</span>
      </footer>
    </main>
  );
}

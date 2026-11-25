'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MatchAnalysisPanel } from './components/MatchAnalysisPanel';
import { apiFetch, type ClientError } from './lib/clientApi';
import { MatchCard } from './components/MatchCard';
import ScoreTicker from './components/ScoreTicker';
import { SiteFooter, SiteHeader } from './components/SiteHeader';
import { MATCH_TAG_CONFIG, MATCH_TAG_LABELS, type MatchTag, type MatchTagId } from './lib/matchTags';
import {
  buildMatchUrl,
  cachedLeagues,
  clearResumeScrollOnly,
  dayHeading,
  DayEvents,
  Fixture,
  isFixtureFinished,
  keyFor,
  League,
  MonthFixture,
  monthFixturesCache,
  monthLabel,
  monthLabelShort,
  pad,
  readResumeSnapshot,
  saveResumeSnapshot,
  setCachedLeagues,
  shortDate,
  StatusTab,
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
  /** Étiquettes des rencontres scannées (clé : identifiant de match). */
  const [screenedTags, setScreenedTags] = useState<Record<string, MatchTag[]>>({});
  /** Filtres d'étiquettes actifs : une rencontre est gardée si elle porte
   *  au moins une des étiquettes sélectionnées. */
  const [tagFilters, setTagFilters] = useState<MatchTagId[]>([]);
  const [calendarError, setCalendarError] = useState('');
  /** Réponse partielle : certaines journées n'ont pas pu être chargées. */
  const [calendarDegraded, setCalendarDegraded] = useState(false);
  /** Type de la dernière panne, pour proposer « réessayer » si utile. */
  const [calendarFailure, setCalendarFailure] = useState<ClientError | null>(null);
  /** Incrémenté pour forcer un nouvel essai de chargement du calendrier. */
  const [calendarRetry, setCalendarRetry] = useState(0);

  const [hydrated, setHydrated] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<SheetState>(null);
  /** Recherche dépliée directement dans la barre collante mobile. */
  const [mobileExpanded, setMobileExpanded] = useState(false);
  /** Bouton « revenir en haut » de la liste mobile. */
  const [showToTop, setShowToTop] = useState(false);
  const stickyBarRef = useRef<HTMLDivElement | null>(null);

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
    // Les étiquettes scannées appartiennent au mois affiché : on les
    // efface pour ne pas filtrer sur des rencontres disparues.
    setScreenedTags({});
    setTagFilters([]);

    const load = async () => {
      const combined: DayEvents = {};
      let failures = 0;
      let lastFailure: ClientError | null = null;
      for (let i = 0; i < keys.length; i += 6) {
        const batch = keys.slice(i, i + 6);
        const results = await Promise.all(
          batch.map(async key => {
            const outcome = await apiFetch<any>(
              `/api/fixtures?league=${encodeURIComponent(league)}&date=${key.replaceAll('-', '')}`
            );
            if (!outcome.ok) {
              failures += 1;
              lastFailure = outcome.error;
              return [key, [] as Fixture[]] as const;
            }
            return [key, ((outcome.data?.events || []) as Fixture[])] as const;
          })
        );
        if (!active) return;
        for (const [key, events] of results) combined[key] = events;
        setDayEvents({ ...combined });
      }
      if (!active) return;
      setCalendarFailure(lastFailure);
      if (failures === keys.length) {
        setCalendarDegraded(false);
        setCalendarError(
          lastFailure?.retryable
            ? 'Le calendrier est temporairement indisponible. Vérifiez votre connexion puis réessayez.'
            : 'Aucune journée n’a pu être chargée pour cette période.'
        );
      } else {
        if (failures === 0) {
          monthFixturesCache.set(cacheKey, { ...combined });
          setCalendarDegraded(false);
          setCalendarError('');
        } else {
          setCalendarDegraded(true);
          setCalendarError(
            `Calendrier partiel : ${failures} journée(s) sur ${keys.length} n’ont pas pu être chargées.`
          );
        }
      }
      setMonthLoading(false);
    };
    load();
    return () => {
      active = false;
    };
  }, [hydrated, league, month, calendarRetry]);

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
      if (tagFilters.length) {
        // Une rencontre est conservée si elle porte au moins une des
        // étiquettes sélectionnées.
        const tags = screenedTags[item.id] || [];
        if (!tags.some(tag => tagFilters.includes(tag.id))) return false;
      }
      if (!q) return true;
      return `${item.home?.name || ''} ${item.away?.name || ''} ${item.venue || ''} ${shortDate(item.dayKey)}`
        .toLowerCase()
        .includes(q);
    });
  }, [monthFixtures, statusTab, search, tagFilters, screenedTags]);

  /** Nombre de rencontres scannées portant chaque étiquette. */
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tags of Object.values(screenedTags)) {
      for (const tag of tags) {
        counts[tag.id] = (counts[tag.id] || 0) + 1;
      }
    }
    return counts;
  }, [screenedTags]);

  const scannedCount = Object.keys(screenedTags).length;

  const toggleTagFilter = (id: MatchTagId) => {
    setTagFilters(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
  };

  // Regroupement par journée pour les en-têtes de section
  const groupedDays = useMemo(() => {
    const map = new Map<string, MonthFixture[]>();
    for (const item of visibleFixtures) {
      const list = map.get(item.dayKey);
      if (list) list.push(item);
      else map.set(item.dayKey, [item]);
    }
    return Array.from(map.entries()).map(([dayKey, items]) => ({ dayKey, items }));
  }, [visibleFixtures]);

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

  // 6 bis. Verrou de défilement de l'arrière-plan.
  //
  // Un SEUL propriétaire pour `body.style.overflow` : deux effets qui
  // posent le verrou en lisant chacun la valeur courante se marchent
  // dessus (le second lit « hidden » et le restaure ensuite). Résultat
  // observé sur mobile : après « retour » depuis une fiche de rencontre,
  // la page refusait de défiler.
  //
  // On mémorise donc la valeur d'origine UNE fois, quand le premier
  // verrou apparaît, et on la restaure exactement quand le dernier
  // disparaît.
  const sheetOpen = Boolean(mobileSheet);
  const lockPreviousOverflowRef = useRef<string | null>(null);
  useEffect(() => {
    const shouldLock = sheetOpen || mobileExpanded;
    if (shouldLock && lockPreviousOverflowRef.current === null) {
      lockPreviousOverflowRef.current = document.body.style.overflow;
    }
    if (shouldLock) {
      document.body.style.overflow = 'hidden';
    } else if (lockPreviousOverflowRef.current !== null) {
      document.body.style.overflow = lockPreviousOverflowRef.current;
      lockPreviousOverflowRef.current = null;
    }
  }, [sheetOpen, mobileExpanded]);

  // Filet de sécurité : un déverrouillage oublié (erreur, page quittée
  // pendant une animation) ne doit jamais laisser la page figée.
  useEffect(() => {
    return () => {
      if (lockPreviousOverflowRef.current !== null) {
        document.body.style.overflow = lockPreviousOverflowRef.current;
        lockPreviousOverflowRef.current = null;
      }
    };
  }, []);

  // 7. Échap ferme la feuille ouverte au-dessus du calendrier
  useEffect(() => {
    if (!mobileSheet && !mobileExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileExpanded(false);
        if (mobileSheet) closeMobileSheet();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileSheet, mobileExpanded, closeMobileSheet]);

  // 8. Hauteur réelle du bloc collant mobile : les en-têtes de journée et les
  //    ancres s'y accrochent, la hauteur dépendant de la police du système.
  useEffect(() => {
    const el = stickyBarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      const height = Math.round(el.getBoundingClientRect().height);
      if (height > 0) document.documentElement.style.setProperty('--m-sticky-h', `${height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [search, counts.upcoming, counts.finished]);

  // 9. Bouton « haut de page » au-delà d'un écran de défilement
  useEffect(() => {
    const onScroll = () => setShowToTop(window.scrollY > 620);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const goToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

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
      const nextTags: Record<string, MatchTag[]> = {};
      for (let i = 0; i < dayKeys.length; i += 4) {
        const batch = dayKeys.slice(i, i + 4);
        await Promise.all(
          batch.map(async dayKey => {
            const response = await fetch(`/api/analyze?league=${encodeURIComponent(league)}&date=${dayKey.replaceAll('-', '')}`);
            if (!response.ok) return;
            const payload = await response.json();
            (payload.matches || []).forEach((match: any) => {
              if (match.vigilance) next[match.id] = match.vigilance;
              // Les étiquettes sont produites par le moteur : le front
              // ne fait que les afficher (aucun calcul ici).
              if (Array.isArray(match.tags) && match.tags.length) {
                nextTags[match.id] = match.tags as MatchTag[];
              }
            });
          })
        );
        setScreenedScores(prev => ({ ...prev, ...next }));
        setScreenedTags(prev => ({ ...prev, ...nextTags }));
      }
    } catch {
      setCalendarError('Le scan de vigilance n’a pas abouti. Réessayez.');
    } finally {
      setScreening(false);
    }
  };

  return (
    <main className="appShell">
      <a
        className="skipLink"
        href="#rencontres"
        onClick={event => {
          event.preventDefault();
          const target = document.getElementById('rencontres');
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }}
      >
        Aller au calendrier
      </a>
      <SiteHeader
        items={[
          { kind: 'anchor', href: '#rencontres', label: 'Rencontres', active: true },
          { kind: 'link', href: '/matchs', label: 'Tous les matchs' },
          { kind: 'link', href: '/pronostics', label: 'Pronostics' },
        ]}
        quickAction={{ href: '/matchs', label: 'Tous les matchs →' }}
      />

      {/* Bandeau collant : scores du jour, toutes compétitions. */}
      <ScoreTicker />

      <section className="appHero" id="top">
        <div className="heroCopy">
          <div className="eyebrow">
            <span /> CENTRE DE MATCHS · SAISON EN COURS
          </div>
          <p className="heroHeadline">
            Le calendrier,
            <br />
            <em>en un coup d’œil.</em>
          </p>
          <p>
            Choisissez une compétition, parcourez tous les matchs du mois sous forme de cartes, puis ouvrez une rencontre pour consulter
            son analyse complète.
          </p>
          <div className="heroStats">
            <span>
              <b>08</b> modules d’analyse
            </span>
            <span>
              <b>{leagues.length || 23}</b> compétitions
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

      {/* ---- Mobile : bloc collant (filtres rapides + statut) ---- */}
      <div className="mSticky" ref={stickyBarRef}>
        <div className="mBar">
          <button type="button" className="mBarLeague" onClick={() => setMobileExpanded(true)} aria-label="Changer de compétition et de mois">
            <span className="mBarIcon" aria-hidden="true">
              ◈
            </span>
            <span className="mBarText">
              <small>Compétition</small>
              <b>{currentLeagueName}</b>
            </span>
            <span className="mBarChevron" aria-hidden="true">
              ▾
            </span>
          </button>
          <div className="mBarMonth">
            <button type="button" className="mBarStep" onClick={() => changeMonth(-1)} aria-label="Mois précédent">
              ‹
            </button>
            <button type="button" className="mBarMonthLabel" onClick={() => setMobileExpanded(true)} aria-label="Choisir un mois">
              <b>
                <span className="mMonthLong">{monthLabel(month)}</span>
                <span className="mMonthShort">{monthLabelShort(month)}</span>
              </b>
              <small>{monthMatchCount} matchs</small>
            </button>
            <button type="button" className="mBarStep" onClick={() => changeMonth(1)} aria-label="Mois suivant">
              ›
            </button>
          </div>
          <button
            type="button"
            className="mBarFilterBtn"
            onClick={() => setMobileExpanded(true)}
            aria-label="Ouvrir les filtres"
            aria-expanded={mobileExpanded}
          >
            ☰
            {search.trim() ? <i aria-hidden="true">1</i> : null}
          </button>
        </div>
        <div className="mTabs" role="tablist" aria-label="Statut des rencontres">
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'upcoming'}
            className={`mTab ${statusTab === 'upcoming' ? 'mTabActive' : ''}`}
            onClick={() => setStatusTab('upcoming')}
          >
            À venir <b>{counts.upcoming}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusTab === 'finished'}
            className={`mTab ${statusTab === 'finished' ? 'mTabActive' : ''}`}
            onClick={() => setStatusTab('finished')}
          >
            Terminés <b>{counts.finished}</b>
          </button>
        </div>
      </div>

      {/* ---- Desktop : barre d'outils historique ---- */}
      <section className="toolbar" aria-label="Filtres du calendrier">
        <label className="selectField">
          <span className="fieldIcon">◈</span>
          <span className="fieldCopy">
            <small>COMPÉTITION</small>
            <select value={league} aria-label="Choisir une compétition" onChange={event => changeLeague(event.target.value)}>
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
            <h1>Tous les matchs du mois</h1>
            <p>
              {calendarError ? (
                <span className="inlineError">
                  {calendarError}
                  {calendarFailure?.retryable ? (
                    <button
                      type="button"
                      className="inlineRetry"
                      onClick={() => {
                        monthFixturesCache.delete(`${league}:${month}`);
                        setCalendarRetry(token => token + 1);
                      }}
                    >
                      Réessayer
                    </button>
                  ) : null}
                </span>
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
                    type="search"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="Rechercher une équipe, un stade ou une date"
                    aria-label="Rechercher une rencontre"
                    autoComplete="off"
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
          {search.trim() ? (
            <button type="button" className="mActiveSearch" onClick={() => setSearch('')}>
              Recherche : « {search.trim()} » <span>✕ Effacer</span>
            </button>
          ) : null}
        </div>

        {/* Onglets (desktop) : sur mobile, ils vivent dans le bloc collant. */}
        <div className="statusTabsBar statusTabsDesktop" role="tablist" aria-label="Statut des rencontres">
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

        {/* Filtres d'étiquettes : ils ne servent qu'après un scan, car les
            étiquettes sont produites par le moteur lors de l'analyse. */}
        {monthFixtures.length > 0 && (
          <div className="tagFilterBar" role="group" aria-label="Filtrer les rencontres par étiquette">
            <span className="tagFilterLabel">ÉTIQUETTES</span>
            {MATCH_TAG_CONFIG.order.map(id => {
              const meta = MATCH_TAG_LABELS[id];
              const count = tagCounts[id] || 0;
              const active = tagFilters.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={`tagFilterButton ${active ? 'tagFilterActive' : ''} ${count === 0 ? 'tagFilterEmpty' : ''}`}
                  onClick={() => toggleTagFilter(id)}
                  aria-pressed={active}
                  disabled={count === 0 && !active}
                  title={
                    count === 0
                      ? "Aucune rencontre scannée ne porte cette étiquette."
                      : `${count} rencontre(s) scannée(s) portent cette étiquette.`
                  }
                >
                  <i aria-hidden="true">{meta.emoji}</i>
                  {meta.label}
                  <b>{count}</b>
                </button>
              );
            })}
            {tagFilters.length > 0 && (
              <button type="button" className="tagFilterReset" onClick={() => setTagFilters([])}>
                Réinitialiser
              </button>
            )}
            {scannedCount === 0 && (
              <small className="tagFilterHint">
                Lancez le scan du mois pour classer les rencontres : les étiquettes sont calculées par le
                moteur au moment de l’analyse.
              </small>
            )}
          </div>
        )}

        {monthFixtures.length > 0 ? (
          <>
            {visibleFixtures.length > 0 ? (
              <div className="dayGroups">
                {groupedDays.map(group => (
                  <section className="dayGroup" key={group.dayKey}>
                    <header className="dayGroupHead">
                      <b>{dayHeading(group.dayKey)}</b>
                      <span>
                        {group.items.length} rencontre{group.items.length > 1 ? 's' : ''}
                      </span>
                    </header>
                    <div className="dayGroupList">
                      {group.items.map(item => (
                        <div key={`${item.dayKey}-${item.id}`} id={`match-card-${item.id}`}>
                          <MatchCard
                            fixture={item}
                            href={buildMatchUrl(league, item.dayKey, item.id)}
                            onOpen={handleOpenMatch}
                            highlighted={lastMatchId === item.id}
                            vigilance={screenedScores[item.id]}
                            tags={screenedTags[item.id]}
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
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

      <button type="button" className="mToTop" onClick={goToTop} aria-label="Revenir en haut de la liste" aria-hidden={!showToTop} style={showToTop ? undefined : { display: 'none' }}>
        ↑
      </button>

      {/* Feuille de filtres mobile : compétition, mois, statut, recherche */}
      {mobileExpanded ? (
        <div
          className="mSheetBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Filtres du calendrier"
          onClick={e => {
            if (e.target === e.currentTarget) setMobileExpanded(false);
          }}
        >
          <div className="mSheet">
            <div className="mSheetHead">
              <span className="bottomSheetGrabber" />
              <div className="mSheetTitleRow">
                <div>
                  <b className="mSheetTitle">Filtres du calendrier</b>
                  <small>
                    {monthMatchCount} rencontre{monthMatchCount > 1 ? 's' : ''} sur {datesWithMatches.length} journée
                    {datesWithMatches.length > 1 ? 's' : ''} ce mois
                  </small>
                </div>
                <button type="button" className="mSheetClose" onClick={() => setMobileExpanded(false)} aria-label="Fermer les filtres">
                  ✕
                </button>
              </div>
            </div>
            <div className="mSheetBody">
              <label className="mField">
                <small>Compétition</small>
                <select value={league} onChange={event => changeLeague(event.target.value)}>
                  {leagues.map(item => (
                    <option key={item.slug} value={item.slug}>
                      {item.name} · {item.country}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mField">
                <div className="mFieldRowHead">
                  <small>Calendrier mensuel</small>
                  <button
                    type="button"
                    className="mLinkButton"
                    onClick={() => {
                      setMonth(todayKey().slice(0, 7));
                      setLastMatchId('');
                    }}
                  >
                    Ce mois-ci
                  </button>
                </div>
                <div className="mStepper">
                  <button type="button" onClick={() => changeMonth(-1)} aria-label="Mois précédent">
                    ‹
                  </button>
                  <b>{monthLabel(month)}</b>
                  <button type="button" onClick={() => changeMonth(1)} aria-label="Mois suivant">
                    ›
                  </button>
                </div>
              </div>

              <div className="mField">
                <small>Statut</small>
                <div className="mSeg" role="tablist" aria-label="Statut des rencontres">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={statusTab === 'upcoming'}
                    className={statusTab === 'upcoming' ? 'isActive' : ''}
                    onClick={() => setStatusTab('upcoming')}
                  >
                    À venir · {counts.upcoming}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={statusTab === 'finished'}
                    className={statusTab === 'finished' ? 'isActive' : ''}
                    onClick={() => setStatusTab('finished')}
                  >
                    Terminés · {counts.finished}
                  </button>
                </div>
              </div>

              <label className="mField">
                <small>Recherche</small>
                <span className="mSearchBox">
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="Équipe, stade ou date"
                    aria-label="Rechercher une rencontre"
                    inputMode="search"
                    enterKeyHint="search"
                    autoComplete="off"
                  />
                  {search ? (
                    <button type="button" onClick={() => setSearch('')} aria-label="Effacer la recherche">
                      ✕
                    </button>
                  ) : null}
                </span>
              </label>
            </div>
            <div className="mSheetFoot">
              <button
                type="button"
                className="mGhost"
                onClick={() => {
                  setSearch('');
                  setStatusTab('upcoming');
                  setMonth(todayKey().slice(0, 7));
                }}
              >
                Réinitialiser
              </button>
              <button type="button" className="mPrimary" onClick={() => setMobileExpanded(false)}>
                Voir les {visibleFixtures.length} matchs
              </button>
            </div>
          </div>
        </div>
      ) : null}

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

      <SiteFooter />
    </main>
  );
}

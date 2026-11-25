'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, describeFailure, type ClientError } from '../lib/clientApi';
import { Fixture, isFixtureFinished, longDate, Team, timeOf } from '../lib/terrain';
import { TeamBadge } from './TeamBadge';
import { AiAnalysisLoader, MIN_ANALYSIS_MS } from './AiAnalysisLoader';
import { AnalystReportView } from './AnalystReportView';
import { MatchProbabilities } from './MatchProbabilities';
import { MatchOverview } from './MatchOverview';
import { pronosticsMarketCount, PronosticsPanel } from './PronosticsPanel';

export { TeamBadge };

function FactorCard({
  number,
  title,
  badge,
  leftLabel,
  rightLabel,
  left,
  right,
  extra,
  note,
}: {
  number: string;
  title: string;
  badge?: string;
  leftLabel?: string;
  rightLabel?: string;
  left?: any;
  right?: any;
  extra?: React.ReactNode;
  note?: string;
}) {
  return (
    <article className="factorCard">
      <div className="factorTitle">
        <span>{number}</span>
        <b>{title}</b>
        {badge && <em className="factorSourceBadge">{badge}</em>}
      </div>
      {leftLabel || rightLabel ? (
        <div className="factorValues">
          <div>
            <small>{leftLabel || 'Équipe A'}</small>
            <div className="factorValBody">{left || <p>Données indisponibles</p>}</div>
          </div>
          <div>
            <small>{rightLabel || 'Équipe B'}</small>
            <div className="factorValBody">{right || <p>Données indisponibles</p>}</div>
          </div>
        </div>
      ) : (
        <div className="factorSingle">{left || 'Données indisponibles'}</div>
      )}
      {extra}
      {note && <small className="factorNote">{note}</small>}
    </article>
  );
}

function AbsenceChips({ players, fallbackText }: { players?: any[]; fallbackText?: string }) {
  if (!Array.isArray(players)) {
    return <p>{fallbackText || 'Données indisponibles'}</p>;
  }
  if (players.length === 0) {
    return <p className="absenceNone">✓ Effectif au complet (aucune absence signalée)</p>;
  }
  return (
    <div className="absenceList">
      {players.slice(0, 6).map((p: any) => {
        const tagClass =
          p.type === 'suspension'
            ? 'absTagSusp'
            : p.type === 'doubtful'
            ? 'absTagDoubt'
            : 'absTagInj';
        return (
          <span key={p.id || p.name} className={`absenceChip ${p.isKeyPlayer ? 'absenceKey' : ''}`}>
            <i className={`absDot ${tagClass}`} />
            <b>{p.name}</b>
            {p.position && <small>{p.position}</small>}
            <em className={tagClass}>{p.labelFr}</em>
          </span>
        );
      })}
      {players.length > 6 && <small className="absenceMore">+{players.length - 6} autre(s) absent(s)</small>}
    </div>
  );
}

function formatRecent(label: string, freshness: any) {
  if (!freshness?.count) return `${label} : aucune rencontre dans la fenêtre récente.`;
  const last = freshness.latest
    ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${freshness.latest}T12:00:00`))
    : 'date inconnue';
  return `${label} : ${freshness.count}/5 matchs, dernier le ${last}${
    typeof freshness.daysSinceLatest === 'number' ? ` (${freshness.daysSinceLatest} j avant le match)` : ''
  }.`;
}

function styleSummary(value: any) {
  if (!value) return <p>Statistiques de style indisponibles via la source publique.</p>;
  return (
    <p>
      {value.possession}% possession · {value.shotsOnTarget} tirs cadrés · {value.shots} tirs · {value.corners} corners · {value.yellow}{' '}
      cartons
    </p>
  );
}

function formatAttackDefense(statsSide: any, xgSeasonSide: any) {
  if (!statsSide && !xgSeasonSide) return <p>Données indisponibles</p>;
  return (
    <div className="statsRichBlock">
      {statsSide && (
        <p>
          Attaque <b>{statsSide.attaque}</b> · concède <b>{statsSide.defense}</b> b/m
        </p>
      )}
      {xgSeasonSide && (
        <span className="xgMiniPill">
          Saison : <b>{xgSeasonSide.xgPerMatch}</b> xG/m · <b>{xgSeasonSide.xgaPerMatch}</b> xGA/m ({xgSeasonSide.xPoints} xPts)
        </span>
      )}
    </div>
  );
}

type MatchAnalysisPanelProps = {
  leagueSlug: string;
  leagueName?: string;
  dayKey: string;
  matchId: string;
  initialFixture?: Fixture | null;
  onClose?: () => void;
  closeLabel?: string;
  /**
   * Affiche le chargeur d'analyse en calque plein écran (fiche match)
   * plutôt qu'inséré dans le panneau (feuille de la page d'accueil).
   */
  fullPageLoader?: boolean;
  /**
   * Contexte « feuille » (accueil mobile) : la feuille fournit déjà son
   * chrome, donc le panneau n'affiche ni son titre ni son grand
   * scoreboard — qu'il remplacerait par un rappel compact de la rencontre.
   * Les actions (fermer, page dédiée) sont portées par l'en-tête unique.
   */
  sheetMode?: boolean;
};

export function MatchAnalysisPanel({
  leagueSlug,
  leagueName,
  dayKey,
  matchId,
  initialFixture = null,
  onClose,
  closeLabel = 'Retour aux rencontres',
  fullPageLoader = false,
  sheetMode = false,
}: MatchAnalysisPanelProps) {
  const [fixture, setFixture] = useState<Fixture | null>(initialFixture);
  const [fixtureLoading, setFixtureLoading] = useState(!initialFixture);
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisError, setAnalysisError] = useState('');
  /** Erreur typée : permet d'afficher « réessayer » seulement si utile. */
  const [analysisFailure, setAnalysisFailure] = useState<ClientError | null>(null);
  /** La réponse est exploitable mais partielle (données manquantes). */
  const [analysisDegraded, setAnalysisDegraded] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [tab, setTab] = useState<'resume' | 'pronostics' | 'facteurs' | 'analyste' | 'vigilance'>('resume');
  const [loaderElapsed, setLoaderElapsed] = useState(0);
  const [loaderProgress, setLoaderProgress] = useState(0);
  const loaderStartRef = useRef<number>(Date.now());
  const panelRef = useRef<HTMLElement | null>(null);

  /**
   * Sur mobile, un onglet peut être très long : en changeant d'onglet on
   * ramène l'utilisateur en haut du panneau pour qu'il ne reste pas au
   * milieu d'un contenu qui vient de changer.
   */
  const selectTab = useCallback((next: typeof tab) => {
    setTab(next);
    if (typeof window === 'undefined' || !window.matchMedia('(max-width: 760px)').matches) return;
    const el = panelRef.current;
    if (!el) return;
    // Le panneau défile soit avec la page (fiche match), soit dans la
    // feuille (`.bottomSheetContent`, qui est son propre conteneur de
    // défilement). Remonter la page ne sert à rien dans le second cas :
    // on cherche donc le premier ancêtre réellement défilable.
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const style = window.getComputedStyle(scroller);
      if (/(auto|scroll)/.test(`${style.overflowY}${style.overflow}`) && scroller.scrollHeight > scroller.clientHeight + 8) break;
      scroller = scroller.parentElement;
    }
    // La barre d'onglets est collante : sans cette marge, le titre du
    // nouvel onglet atterrit dessous, à moitié caché.
    const sticky = panelRef.current?.querySelector<HTMLElement>('.analysisSticky');
    const gap = (sticky?.getBoundingClientRect().height || 0) + 4;
    if (scroller) {
      // `offsetTop` est relatif à l'offsetParent, pas au conteneur
      // défilant : on passe par des rectangles écran, toujours justes.
      const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - gap), behavior: 'smooth' });
      return;
    }
    const top = el.getBoundingClientRect().top + window.scrollY - gap;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  // Le sommaire du rapport se cale sous la barre d'onglets collante :
  // sa position dépend donc de la hauteur réelle de cette barre.
  const [stickyHeight, setStickyHeight] = useState(0);
  useEffect(() => {
    const el = panelRef.current?.querySelector<HTMLElement>('.analysisSticky');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setStickyHeight(el.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [analysisLoading, fixture]);

  // Le changement d'onglet doit aussi remettre la barre d'onglets à gauche.
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const active = bar.querySelector<HTMLElement>('button[aria-selected="true"]');
    if (!active) return;
    if (active.offsetLeft < bar.scrollLeft || active.offsetLeft + active.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: Math.max(0, active.offsetLeft - 12), behavior: 'smooth' });
    }
  }, [tab, analysisLoading]);

  // Séquence d'analyse de 10 secondes minimum : elle démarre à l'ouverture du match
  // et tourne en parallèle de la récupération des données.
  useEffect(() => {
    loaderStartRef.current = Date.now();
    setLoaderElapsed(0);
    setLoaderProgress(0);
    const id = window.setInterval(() => {
      const elapsed = Date.now() - loaderStartRef.current;
      setLoaderElapsed(elapsed);
      const ratio = Math.min(1, elapsed / MIN_ANALYSIS_MS);
      const eased = 1 - Math.pow(1 - ratio, 3);
      setLoaderProgress(Math.min(98, eased * 98));
    }, 60);
    return () => window.clearInterval(id);
  }, [matchId]);

  useEffect(() => {
    if (initialFixture) {
      setFixture(initialFixture);
      setFixtureLoading(false);
    }
  }, [initialFixture]);

  useEffect(() => {
    let active = true;
    const compactDate = dayKey.replaceAll('-', '');

    if (!initialFixture) {
      setFixtureLoading(true);
      fetch(`/api/fixtures?league=${encodeURIComponent(leagueSlug)}&date=${encodeURIComponent(compactDate)}`)
        .then(r => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then(d => {
          if (!active) return;
          const found = ((d.events || []) as Fixture[]).find(ev => String(ev.id) === String(matchId)) || null;
          setFixture(found);
        })
        .catch(() => {
          // On laissera l'analyse tenter de fournir des infos si possible
        })
        .finally(() => active && setFixtureLoading(false));
    }

    setAnalysisLoading(true);
    setAnalysis(null);
    setAnalysisError('');
    setAnalysisFailure(null);
    setAnalysisDegraded(false);
    setTab('resume');

    apiFetch<any>(
      `/api/analyze?league=${encodeURIComponent(leagueSlug)}&date=${encodeURIComponent(compactDate)}&match=${encodeURIComponent(matchId)}`
    ).then(outcome => {
      if (!active) return;
      if (!outcome.ok) {
        setAnalysisFailure(outcome.error);
        setAnalysisError(describeFailure(outcome.error));
        return;
      }
      const payload = outcome.data;
      const result = (payload?.matches || [])[0];
      // Réponse partielle : le service a répondu mais certaines données
      // manquent. On le signale sans masquer l'analyse disponible.
      setAnalysisDegraded(Boolean(payload?.degraded));
      if (result?.error) {
        setAnalysisError(result.error);
        setAnalysisFailure({
          code: payload?.code || 'no_data',
          message: result.error,
          retryable: Boolean(payload?.retryable),
          degraded: true,
          status: 0,
        });
      } else {
        setAnalysis(result || null);
        if (!initialFixture && result?.home && result?.away) {
          setFixture(prev =>
            prev || {
              id: String(result.id || matchId),
              date: result.date || `${dayKey}T12:00:00Z`,
              name: `${result.home?.name || ''} - ${result.away?.name || ''}`,
              home: result.home,
              away: result.away,
              venue: result.venue,
            }
          );
        }
      }
    }).finally(() => active && setAnalysisLoading(false));

    return () => {
      active = false;
    };
  }, [leagueSlug, dayKey, matchId, initialFixture, retryToken]);

  const probabilities = analysis?.probabilities || {};
  const factors = analysis?.factors || {};
  const vigilance = analysis?.vigilance || {};
  const fotmob = analysis?.fotmob || null;
  const realMatchXg = analysis?.realMatchXg || factors.stats?.xgMatchReel || null;
  const xgSaison = factors.stats?.xgSaison || null;
  const freshHome = factors.forme?.fraicheurHome?.count ?? 0;
  const freshAway = factors.forme?.fraicheurAway?.count ?? 0;
  const finished = fixture ? isFixtureFinished(fixture) : false;

  const analyst = analysis?.analyst || null;
  const dataReady = !analysisLoading;
  const minElapsedReached = loaderElapsed >= MIN_ANALYSIS_MS;
  const showLoader = !(minElapsedReached && dataReady);
  const effectiveProgress = showLoader ? loaderProgress : 100;

  // Plein écran : on masque le contenu de la page (en-tête, onglets,
  // panneau) pendant l'attente. Le DOM reste intact : la récupération de
  // données et l'état des onglets survivent au dévoilement.
  useEffect(() => {
    if (!fullPageLoader) return;
    const show = showLoader;
    document.body.classList.toggle('analysisLoadingBody', show);
    // `inert` retire le contenu masqué du parcours clavier ET des
    // lecteurs d'écran : sans lui, on tabulerait vers des liens que
    // personne ne voit. `visibility:hidden` seul ne suffit pas toujours.
    const shell = document.querySelector<HTMLElement>('.matchPageShell');
    if (shell) {
      if (show) shell.setAttribute('inert', '');
      else shell.removeAttribute('inert');
    }
    return () => {
      document.body.classList.remove('analysisLoadingBody');
      shell?.removeAttribute('inert');
    };
  }, [fullPageLoader, showLoader]);

  const referee = factors.autres?.arbitre || fotmob?.referee || null;
  const coaches = factors.autres?.entraineurs || fotmob?.coaches || null;
  const homeAbsenceCount = Array.isArray(factors.blessures?.homePlayers) ? factors.blessures.homePlayers.length : null;
  const awayAbsenceCount = Array.isArray(factors.blessures?.awayPlayers) ? factors.blessures.awayPlayers.length : null;

  return (
    <section
      className={`analysisPanel ${sheetMode ? 'isSheet' : ''}`}
      id="analyse"
      ref={panelRef}
      style={{ ['--m-analysis-sticky' as any]: `${Math.round(stickyHeight)}px` }}
    >
      {/* En-tête collant : score rapide + onglets, toujours visibles sur mobile.
          Dans la feuille, la barre de score est déjà dans l'en-tête de la
          feuille : on ne la répète pas, seule la barre d'onglets reste. */}
      <div className="analysisSticky">
        {fixture && !sheetMode && (
          <div className="matchQuickBar">
            {onClose && (
              <button type="button" className="matchQuickBack" onClick={onClose} aria-label={closeLabel}>
                ←
              </button>
            )}
            <div className="matchQuickTeams">
              <span className="matchQuickSide">
                <TeamBadge team={fixture.home} size={22} />
                <b>{fixture.home?.short || fixture.home?.name || 'Dom.'}</b>
              </span>
              <strong>{finished ? `${fixture.home?.score}–${fixture.away?.score}` : timeOf(fixture.date)}</strong>
              <span className="matchQuickSide matchQuickSideAway">
                <b>{fixture.away?.short || fixture.away?.name || 'Ext.'}</b>
                <TeamBadge team={fixture.away} size={22} />
              </span>
            </div>
          </div>
        )}

        {!showLoader && (
          <div className="analysisTabs" role="tablist" aria-label="Sections de l’analyse" ref={tabsRef}>
            {([
              ['resume', 'Aperçu', ''],
              ['pronostics', 'Marchés', analyst?.pronostics ? String(pronosticsMarketCount(analyst.pronostics)) : ''],
              ['analyste', 'Rapport IA', ''],
              ['facteurs', 'Facteurs', String((homeAbsenceCount || 0) + (awayAbsenceCount || 0))],
              ['vigilance', 'Vigilance', typeof vigilance.score === 'number' ? String(vigilance.score) : ''],
            ] as const).map(([id, label, count]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tabActive' : ''}
                onClick={() => selectTab(id)}
              >
                {id === 'vigilance' ? (
                  <i className={vigilance.score >= 30 ? 'tabDotWarn' : ''} aria-hidden="true" />
                ) : null}
                {label}
                {count && count !== '0' ? <small className="tabCountTag">{count}</small> : null}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`analysisTopline ${fixture ? 'hasFixture' : ''}`}>
        <div className="analysisToplineLeft">
          {onClose && (
            <button type="button" className="backLinkButton" onClick={onClose}>
              <span>←</span> {closeLabel}
            </button>
          )}
          <div>
            <span className="sectionKicker">{leagueName || leagueSlug.toUpperCase()}</span>
            <h2>Analyse de la rencontre</h2>
          </div>
        </div>
      </div>

      {fixture ? (
        <>
          {sheetMode ? (
            /* Feuille : un seul rappel compact de la rencontre. Le grand
               scoreboard faisait doublon avec la barre de la feuille et
               repoussait le verdict sous la ligne de flottaison. */
            <div className="sheetMatchLine">
              <div className="sheetMatchTop">
                <span className="sheetMatchSide">
                  <TeamBadge team={fixture.home} size={26} />
                  <b>{fixture.home?.short || fixture.home?.name}</b>
                </span>
                <strong>
                  {finished ? (
                    <>
                      {fixture.home?.score}
                      <i>–</i>
                      {fixture.away?.score}
                    </>
                  ) : (
                    timeOf(fixture.date)
                  )}
                </strong>
                <span className="sheetMatchSide sheetMatchSideAway">
                  <b>{fixture.away?.short || fixture.away?.name}</b>
                  <TeamBadge team={fixture.away} size={26} />
                </span>
              </div>
              <div className="sheetMatchMeta">
                <span>{longDate(dayKey)}</span>
                {fixture.venue ? (
                  <>
                    <span>·</span>
                    <span className="sheetMatchVenue">{fixture.venue}</span>
                  </>
                ) : null}
                <span className={`matchStatusPill ${finished ? 'statusDone' : 'statusUpcoming'}`}>
                  {finished ? 'Terminé' : 'À venir'}
                </span>
              </div>
            </div>
          ) : (
          <div className="matchHero">
            <div className="analysisMatchMeta">
              <span>{longDate(dayKey)}</span>
              {fixture.venue && (
                <>
                  <span>·</span>
                  <span>{fixture.venue}</span>
                </>
              )}
              {referee?.name && (
                <>
                  <span>·</span>
                  <span title="Arbitre désigné">⚖ {referee.name}</span>
                </>
              )}
              <span className={`matchStatusPill ${finished ? 'statusDone' : 'statusUpcoming'}`}>
                {finished ? 'Terminé' : 'À venir'}
              </span>
            </div>
            <div className="scoreboard">
              <div className="scoreTeam">
                <TeamBadge team={fixture.home} size={64} />
                <b>{fixture.home?.name}</b>
                <small>
                  DOMICILE{coaches?.home ? ` · ${coaches.home}` : ''}
                </small>
              </div>
              <div className="scoreMiddle">
                {finished ? (
                  <div className="finalScoreBox">
                    <strong>
                      {fixture.home?.score} <i>–</i> {fixture.away?.score}
                    </strong>
                    <small>SCORE FINAL</small>
                  </div>
                ) : (
                  <span className="vsToken">VS</span>
                )}
                <small className="scoreKick">{timeOf(fixture.date)} COT</small>
              </div>
              <div className="scoreTeam">
                <TeamBadge team={fixture.away} size={64} />
                <b>{fixture.away?.name}</b>
                <small>
                  EXTÉRIEUR{coaches?.away ? ` · ${coaches.away}` : ''}
                </small>
              </div>
            </div>
            {analysis && (
              <div className="xgHeroRow">
                <div className="xgSummary">
                  <span>xG MODÈLE (AVANT-MATCH)</span>
                  <b>{analysis.expectedGoals?.home}</b>
                  <i>—</i>
                  <b>{analysis.expectedGoals?.away}</b>
                </div>
                {realMatchXg && typeof realMatchXg.homeXg === 'number' && (
                  <div className="xgSummary xgRealSummary">
                    <span>xG RÉELS DU MATCH</span>
                    <b>{realMatchXg.homeXg}</b>
                    <i>—</i>
                    <b>{realMatchXg.awayXg}</b>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {showLoader ? (
            <AiAnalysisLoader
              fixture={fixture}
              elapsed={loaderElapsed}
              progress={effectiveProgress}
              dataReady={dataReady}
              analyst={analyst}
              fullPage={fullPageLoader}
            />
          ) : (
            <>
          {analysisError && (
            <div className="analysisError" role="alert">
              <span>{analysisError}</span>
              {analysisFailure?.retryable && (
                <button
                  type="button"
                  className="analysisRetry"
                  onClick={() => setRetryToken(token => token + 1)}
                >
                  Réessayer
                </button>
              )}
            </div>
          )}
          {analysisError && sheetMode && (
            <div className="analysisFallback">
              <span>Le détail statistique n’est pas disponible pour cette rencontre.</span>
              <button type="button" onClick={() => window.open(`/match/${leagueSlug}/${dayKey}/${matchId}`, '_self')}>
                Ouvrir la fiche de la rencontre <span aria-hidden="true">↗</span>
              </button>
            </div>
          )}
          {analysisDegraded && !analysisError && (
            <div className="dataWarning" role="status">
              Données partielles : certaines statistiques n’ont pas pu être collectées pour
              ce match. Les probabilités affichées reposent sur les données disponibles.
            </div>
          )}

          {analysis && tab === 'resume' && (
            <MatchOverview analysis={analysis} analyst={analyst} fixture={fixture} onOpenTab={selectTab} />
          )}

          {analysis && tab === 'facteurs' && (
            <div className="factorArea">
              <div className="subsectionHeading">
                <span className="sectionKicker">MÉTHODE RAPIDE EN 5 MINUTES</span>
                <h3>Les 8 facteurs pris en compte</h3>
                <p>Synthèse des indicateurs clés de la rencontre (forme, blessés/suspendus, xG, confrontations directes, arbitre).</p>
              </div>
              <div className="factorGrid">
                <FactorCard
                  number="01"
                  title="Forme récente · 5 matchs max"
                  leftLabel={fixture.home?.name}
                  rightLabel={fixture.away?.name}
                  left={<p>{factors.forme?.home}</p>}
                  right={<p>{factors.forme?.away}</p>}
                  note={`${factors.forme?.note || ''} ${formatRecent('Domicile', factors.forme?.fraicheurHome)} ${formatRecent(
                    'Extérieur',
                    factors.forme?.fraicheurAway
                  )}`}
                />
                <FactorCard
                  number="02"
                  title="Domicile / extérieur"
                  leftLabel="À domicile"
                  rightLabel="À l’extérieur"
                  left={<p>{factors.domicileExterieur?.home}</p>}
                  right={<p>{factors.domicileExterieur?.away}</p>}
                />
                <FactorCard
                  number="03"
                  title="Confrontations directes"
                  left={factors.h2h?.resume}
                  extra={
                    Array.isArray(factors.h2h?.detail) && factors.h2h.detail.length > 0 ? (
                      <div className="h2hMiniList">
                        {factors.h2h.detail.slice(0, 4).map((duel: any, idx: number) => (
                          <span key={idx} className="h2hMiniChip">
                            {duel.date ? <small>{duel.date.slice(0, 7)}</small> : null}
                            <b>
                              {duel.homeName} {duel.homeScore}–{duel.awayScore} {duel.awayName}
                            </b>
                          </span>
                        ))}
                      </div>
                    ) : null
                  }
                  note={factors.h2h?.note}
                />
                <FactorCard
                  number="04"
                  title="Blessés / suspendus"
                  leftLabel={fixture.home?.short || fixture.home?.name}
                  rightLabel={fixture.away?.short || fixture.away?.name}
                  left={<AbsenceChips players={factors.blessures?.homePlayers} fallbackText={factors.blessures?.home} />}
                  right={<AbsenceChips players={factors.blessures?.awayPlayers} fallbackText={factors.blessures?.away} />}
                  note={factors.blessures?.note}
                />
                <FactorCard
                  number="05"
                  title="Enjeu & classement"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={
                    <p>
                      {factors.enjeu?.home}
                      {factors.enjeu?.classementHome
                        ? ` (${factors.enjeu.classementHome.rank}e · ${factors.enjeu.classementHome.points} pts)`
                        : ''}
                    </p>
                  }
                  right={
                    <p>
                      {factors.enjeu?.away}
                      {factors.enjeu?.classementAway
                        ? ` (${factors.enjeu.classementAway.rank}e · ${factors.enjeu.classementAway.points} pts)`
                        : ''}
                    </p>
                  }
                />
                <FactorCard
                  number="06"
                  title="Style de jeu récent"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={styleSummary(factors.style?.home)}
                  right={styleSummary(factors.style?.away)}
                  note="Moyennes des derniers matchs disponibles : possession, tirs, tirs cadrés, corners et cartons."
                />
                <FactorCard
                  number="07"
                  title="Attaque, défense & xG"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={formatAttackDefense(factors.stats?.home, xgSaison?.home)}
                  right={formatAttackDefense(factors.stats?.away, xgSaison?.away)}
                  note={factors.stats?.note}
                />
                <FactorCard
                  number="08"
                  title="Météo, repos, arbitre & bancs"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={
                    <p>
                      {factors.autres?.reposHome ?? '—'} j. de repos
                      {coaches?.home ? ` · Coach : ${coaches.home}` : ''}
                      {coaches?.formationHome ? ` (${coaches.formationHome})` : ''}
                    </p>
                  }
                  right={
                    <p>
                      {factors.autres?.reposAway ?? '—'} j. de repos
                      {coaches?.away ? ` · Coach : ${coaches.away}` : ''}
                      {coaches?.formationAway ? ` (${coaches.formationAway})` : ''}
                    </p>
                  }
                  note={`${
                    factors.autres?.meteo ? `Météo : ${factors.autres.meteo.description || 'données disponibles'}. ` : 'Météo non disponible. '
                  }${factors.autres?.note || ''}`}
                />
              </div>
              <div className="fiveMinuteNote">
                <b>Lecture rapide</b>
                <span>
                  Les absences (blessés/suspendus) et les xG/xGA de la saison ajustent directement les buts attendus (λ) du modèle
                  Dixon-Coles. Vérifiez toujours le onze officiel publié 1h avant le coup d’envoi.
                </span>
              </div>
            </div>
          )}

          {analysis && tab === 'pronostics' && (
            <div className="marketsArea">
              <div className="detailHead">
                <span className="sectionKicker">MOTEUR QUANTITATIF V3</span>
                <h3>Probabilités du match</h3>
                <p>
                  Forme récente ({freshHome}/5 et {freshAway}/5 matchs)
                  {analyst
                    ? ' · score bivarié, covariance, répartition des périodes, Monte-Carlo 10 000'
                    : fotmob
                    ? ' · xG, effectifs et confrontations intégrés'
                    : ' · sur 60 jours maximum'}
                </p>
                {analyst ? (
                  <div className="detailMeta">
                    <span>λ {analyst.lambdas?.home} – {analyst.lambdas?.away}</span>
                    <span>ρ {analyst.dixonColes?.rho}</span>
                    {typeof analyst.periodSplit?.firstHalfShare === 'number' ? (
                      <span>1re période {Math.round(analyst.periodSplit.firstHalfShare * 100)} %</span>
                    ) : null}
                    <span>Monte-Carlo 10 000</span>
                  </div>
                ) : null}
              </div>
              <MatchProbabilities analysis={analysis} analyst={analyst} fixture={fixture} />
              {(freshHome < 5 || freshAway < 5) && (
                <div className="dataWarning">
                  Échantillon récent incomplet. Les données plus anciennes sont exclues ; la confiance dans l’estimation est donc plus
                  limitée.
                </div>
              )}
              <PronosticsPanel analyst={analyst} />
              <p className="legalNote">
                Les probabilités sont des estimations statistiques. Elles ne constituent ni conseil de pari ni garantie de résultat.
              </p>
            </div>
          )}

          {analysis && tab === 'analyste' && (
            <AnalystReportView analyst={analyst} meta={{ leagueName, leagueSlug }} />
          )}

          {analysis && tab === 'vigilance' && (
            <div className="vigilancePage">
              <div className={`vigilanceScore ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}>
                <span>INDICE EXPLORATOIRE</span>
                <b>
                  {vigilance.score ?? '—'}
                  <small>/100</small>
                </b>
                <strong>{vigilance.level || '—'}</strong>
                <p>Ce signal n’est ni une accusation ni une preuve de manipulation.</p>
              </div>
              <div className="vigilanceDetails">
                <span className="sectionKicker">ÉLÉMENTS DE CONTEXTE</span>
                <h3>Pourquoi ce niveau ?</h3>
                {(vigilance.reasons || []).map((reason: string, index: number) => (
                  <div className="reasonRow" key={index}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <p>{reason}</p>
                  </div>
                ))}
                {(!vigilance.reasons || !vigilance.reasons.length) && (
                  <p className="factorSingle">Aucun élément de vigilance particulier n’a été retourné.</p>
                )}
                <div className="integrityNotice">
                  <b>À retenir</b>
                  <p>
                    Un score élevé peut refléter un écart modèle/marché, des absences majeures détectées ou une incertitude statistique.
                    Seules les autorités et organismes d’intégrité peuvent enquêter.
                  </p>
                </div>
              </div>
            </div>
          )}
            </>
          )}
        </>
      ) : showLoader ? (
        <AiAnalysisLoader
          fixture={null}
          elapsed={loaderElapsed}
          progress={effectiveProgress}
          dataReady={dataReady}
          analyst={analyst}
          fullPage={fullPageLoader}
        />
      ) : fixtureLoading ? (
        <div className="analysisLoading">
          <i className="largeSpinner" />
          <div>
            <b>Chargement de la rencontre…</b>
            <span>Récupération des données de la rencontre…</span>
          </div>
        </div>
      ) : (
        <div className="analysisPlaceholder">
          <div className="placeholderIcon">◉</div>
          <b>Rencontre introuvable</b>
          <p>Cette rencontre n’a pas pu être chargée ou n’est plus disponible pour cette journée.</p>
        </div>
      )}
    </section>
  );
}

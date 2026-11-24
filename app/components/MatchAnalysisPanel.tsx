'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch, describeFailure, type ClientError } from '../lib/clientApi';
import { Fixture, isFixtureFinished, longDate, Team, timeOf } from '../lib/terrain';
import { TeamBadge } from './TeamBadge';
import { AiAnalysisLoader, MIN_ANALYSIS_MS } from './AiAnalysisLoader';
import { AnalystReportView } from './AnalystReportView';
import { ProbBar } from './ProbBar';
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
};

export function MatchAnalysisPanel({
  leagueSlug,
  leagueName,
  dayKey,
  matchId,
  initialFixture = null,
  onClose,
  closeLabel = 'Retour aux rencontres',
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

  const referee = factors.autres?.arbitre || fotmob?.referee || null;
  const coaches = factors.autres?.entraineurs || fotmob?.coaches || null;
  const homeAbsenceCount = Array.isArray(factors.blessures?.homePlayers) ? factors.blessures.homePlayers.length : null;
  const awayAbsenceCount = Array.isArray(factors.blessures?.awayPlayers) ? factors.blessures.awayPlayers.length : null;

  return (
    <section className="analysisPanel" id="analyse">
      {/* En-tête collant : score rapide + onglets, toujours visibles sur mobile */}
      <div className="analysisSticky">
        {fixture && (
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
          <div className="analysisTabs" role="tablist" aria-label="Sections de l’analyse">
            {([
              ['resume', 'Vue d’ensemble'],
              ['pronostics', 'Pronostics'],
              ['analyste', 'Analyste IA'],
              ['facteurs', '8 facteurs'],
              ['vigilance', 'Vigilance'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tabActive' : ''}
                onClick={() => setTab(id)}
              >
                {label}
                {id === 'pronostics' && analyst?.pronostics ? (
                  <small className="tabCountTag">
                    {pronosticsMarketCount(analyst.pronostics)} marchés
                  </small>
                ) : null}
                {id === 'analyste' && analyst ? <small className="tabCountTag">8 modules</small> : null}
                {id === 'facteurs' && (homeAbsenceCount || awayAbsenceCount) ? (
                  <small className="tabCountTag">{(homeAbsenceCount || 0) + (awayAbsenceCount || 0)} abs.</small>
                ) : null}
                {id === 'vigilance' && <i />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="analysisTopline">
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

          {showLoader ? (
            <AiAnalysisLoader
              fixture={fixture}
              elapsed={loaderElapsed}
              progress={effectiveProgress}
              dataReady={dataReady}
              analyst={analyst}
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
          {analysisDegraded && !analysisError && (
            <div className="dataWarning" role="status">
              Données partielles : certaines statistiques n’ont pas pu être collectées pour
              ce match. Les probabilités affichées reposent sur les données disponibles.
            </div>
          )}

          {analysis && tab === 'resume' && (
            <>
              <div className="predictionIntro">
                <div>
                  <span className="sectionKicker">
                    {analyst ? 'MOTEUR QUANTITATIF V3 · VALIDATION EMPIRIQUE' : 'MODÈLE STATISTIQUE ENRICHI'}
                  </span>
                  <h3>Estimations du match</h3>
                  <small>
                    Forme récente ({freshHome}/5 & {freshAway}/5 matchs)
                    {analyst
                      ? ' · score bivarié, covariance, répartition des périodes, Monte-Carlo 10 000'
                      : fotmob
                      ? ' · xG, effectifs & confrontations intégrés'
                      : ' · sur 60 jours max'}
                  </small>
                </div>
                <span className="modelMark">{analyst ? 'Bivarié + xG · V3' : fotmob ? 'Poisson + xG' : 'Poisson'}</span>
              </div>
              {analyst && (
                <div className="analystStrip">
                  <div className="analystStripScore">
                    <span>SCORE ANALYSTE</span>
                    <b>
                      {analyst.confidence?.score ?? '—'}
                      <small>/100</small>
                    </b>
                    <em>{analyst.confidence?.label || '—'}</em>
                    <small className="analystStripBasis">complétude · séparation · accord</small>
                    {typeof analyst.confidence?.probability === 'number' ? (
                      <small className="analystStripMeasured">
                        probabilité mesurée {Math.round(analyst.confidence.probability * 100)} %
                        {analyst.confidence?.interval
                          ? ` [${Math.round(analyst.confidence.interval.low * 100)}–${Math.round(
                              analyst.confidence.interval.high * 100
                            )} %]`
                          : ''}
                      </small>
                    ) : null}
                  </div>
                  <div className="analystStripBody">
                    <span className="sectionKicker">SYNTHÈSE DE L’ANALYSTE IA</span>
                    <b>{analyst.synthesis?.headline}</b>
                    <p>{analyst.synthesis?.text}</p>
                    <div className="analystStripMeta">
                      <span>λ {analyst.lambdas?.home} – {analyst.lambdas?.away}</span>
                      <span>ρ {analyst.dixonColes?.rho}</span>
                      {typeof analyst.covariance?.value === 'number' ? (
                        <span>cov {analyst.covariance.value}</span>
                      ) : null}
                      {typeof analyst.periodSplit?.firstHalfShare === 'number' ? (
                        <span>1re période {Math.round(analyst.periodSplit.firstHalfShare * 100)} %</span>
                      ) : null}
                      <span>MC 10 000</span>
                      <span>temps pondéré e^(−ξΔt)</span>
                    </div>
                  </div>
                  <button type="button" onClick={() => setTab('analyste')}>
                    Rapport complet <span>→</span>
                  </button>
                </div>
              )}

              {(freshHome < 5 || freshAway < 5) && (
                <div className="dataWarning">
                  Échantillon récent incomplet. Les données plus anciennes sont exclues ; la confiance dans l’estimation est donc plus
                  limitée.
                </div>
              )}

              {/* Aperçu rapide des absents majeurs directement sur la vue d'ensemble */}
              {(homeAbsenceCount !== null || awayAbsenceCount !== null) && ((homeAbsenceCount || 0) > 0 || (awayAbsenceCount || 0) > 0) && (
                <div className="squadQuickBanner">
                  <div className="squadQuickHeader">
                    <span>✚ EFFECTIFS & ABSENCES</span>
                    <button type="button" onClick={() => setTab('facteurs')}>
                      Voir les 8 facteurs →
                    </button>
                  </div>
                  <div className="squadQuickCols">
                    <div>
                      <small>{fixture.home?.name}</small>
                      <p>{factors.blessures?.home}</p>
                    </div>
                    <div>
                      <small>{fixture.away?.name}</small>
                      <p>{factors.blessures?.away}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="predictionGrid">
                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>1X2</span>
                    <div>
                      <b>Résultat final</b>
                      <small>Temps réglementaire</small>
                    </div>
                  </div>
                  <ProbBar
                    label={`Victoire · ${fixture.home?.short || 'domicile'}`}
                    value={probabilities.home}
                    interval={analyst?.uncertainty?.home}
                  />
                  <ProbBar
                    label="Match nul"
                    value={probabilities.draw}
                    color="var(--gold)"
                    interval={analyst?.uncertainty?.draw}
                  />
                  <ProbBar
                    label={`Victoire · ${fixture.away?.short || 'extérieur'}`}
                    value={probabilities.away}
                    color="var(--blue)"
                    interval={analyst?.uncertainty?.away}
                  />
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>↗</span>
                    <div>
                      <b>Les deux équipes marquent</b>
                      <small>BTTS · match entier</small>
                    </div>
                  </div>
                  <ProbBar label="Oui · les deux équipes marquent" value={probabilities.bttsYes} />
                  <ProbBar label="Non · une équipe muette" value={probabilities.bttsNo} color="var(--blue)" />
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>Σ</span>
                    <div>
                      <b>Total de buts</b>
                      <small>Plus / moins · match entier</small>
                    </div>
                  </div>
                  <ProbBar label="Plus de 1,5 buts" value={probabilities.over15} />
                  <ProbBar label="Moins de 1,5 buts" value={probabilities.under15} color="var(--blue)" />
                  <ProbBar label="Plus de 2,5 buts" value={probabilities.over25} />
                  <ProbBar label="Moins de 2,5 buts" value={probabilities.under25} color="var(--blue)" />
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>⌗</span>
                    <div>
                      <b>Scores les plus probables</b>
                      <small>Estimations du modèle</small>
                    </div>
                  </div>
                  {(analysis.topScores || []).slice(0, 5).map((score: any) => (
                    <ProbBar key={`${score.h}-${score.a}`} label={`${score.h} – ${score.a}`} value={score.p} />
                  ))}
                </article>

                <article className="predictionCard fullPrediction">
                  <div className="cardHeading">
                    <span>½</span>
                    <div>
                      <b>Buts par période</b>
                      <small>Probabilités par mi-temps</small>
                    </div>
                  </div>
                  <div className="periodRows">
                    {[
                      ['1re mi-temps', probabilities.firstHalf],
                      ['2e mi-temps', probabilities.secondHalf],
                    ].map(([label, period]: any) => (
                      <div className="periodGroup" key={label}>
                        <span className="periodGroupLabel">{label}</span>
                        {[
                          ['1,5', period?.over15],
                          ['2,5', period?.over25],
                        ].map(([line, value]: any) => (
                          <div key={line}>
                            <ProbBar label={`Plus de ${line} buts`} value={value} />
                            <ProbBar
                              label={`Moins de ${line} buts`}
                              value={typeof value === 'number' ? 1 - value : undefined}
                              color="var(--blue)"
                            />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <small className="tableNote">Estimations par période, indépendantes du score à la pause.</small>
                </article>
              </div>

              {Array.isArray(fotmob?.insights) && fotmob.insights.length > 0 && (
                <div className="fotmobInsightsBox">
                  <span className="sectionKicker">FAITS MARQUANTS</span>
                  <ul>
                    {fotmob.insights.slice(0, 4).map((line: string, i: number) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className={`vigilanceSummary ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}>
                <span className="vigilanceIcon">!</span>
                <div>
                  <b>
                    Vigilance · {vigilance.level || '—'} <small>{vigilance.score ?? '—'}/100</small>
                  </b>
                  <p>{vigilance.reasons?.[0] || 'Aucun signal majeur détecté avec les données disponibles.'}</p>
                </div>
                <button onClick={() => setTab('vigilance')}>
                  Détails <span>→</span>
                </button>
              </div>
              <p className="legalNote">
                Les probabilités sont des estimations statistiques. Elles ne constituent ni conseil de pari ni garantie de résultat.
              </p>
            </>
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

          {analysis && tab === 'pronostics' && <PronosticsPanel analyst={analyst} />}

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

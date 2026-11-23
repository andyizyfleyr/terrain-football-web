'use client';

import { useEffect, useState } from 'react';
import { Fixture, isFixtureFinished, longDate, pct, Team, timeOf } from '../lib/terrain';

export function TeamBadge({ team, size = 36 }: { team?: Team; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [team?.id, team?.logo]);
  const logo = team?.logo || (team?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${team.id}.png` : '');
  return (
    <span className="teamBadge" style={{ width: size, height: size }}>
      {logo && !broken ? (
        <img src={logo} alt={`${team?.name || 'Équipe'} — logo`} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span>{(team?.short || team?.name || '?').slice(0, 3)}</span>
      )}
    </span>
  );
}

function ProbBar({ label, value, color = 'var(--green)' }: { label: string; value: any; color?: string }) {
  const width = typeof value === 'number' ? Math.max(2, Math.min(100, value * 100)) : 0;
  return (
    <div className="probRow">
      <div className="probLabel">
        <span>{label}</span>
        <b>{pct(value)}</b>
      </div>
      <div className="probTrack">
        <i style={{ width: `${width}%`, background: color }} />
      </div>
    </div>
  );
}

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
          FotMob : <b>{xgSeasonSide.xgPerMatch}</b> xG/m · <b>{xgSeasonSide.xgaPerMatch}</b> xGA/m ({xgSeasonSide.xPoints} xPts)
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
  const [tab, setTab] = useState<'resume' | 'facteurs' | 'vigilance'>('resume');

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
    setTab('resume');

    fetch(
      `/api/analyze?league=${encodeURIComponent(leagueSlug)}&date=${encodeURIComponent(compactDate)}&match=${encodeURIComponent(matchId)}`
    )
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(d => {
        if (!active) return;
        const result = (d.matches || [])[0];
        if (result?.error) setAnalysisError(result.error);
        else {
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
      })
      .catch(() => active && setAnalysisError('Analyse momentanément indisponible. Réessayez.'))
      .finally(() => active && setAnalysisLoading(false));

    return () => {
      active = false;
    };
  }, [leagueSlug, dayKey, matchId, initialFixture]);

  const probabilities = analysis?.probabilities || {};
  const factors = analysis?.factors || {};
  const vigilance = analysis?.vigilance || {};
  const fotmob = analysis?.fotmob || null;
  const realMatchXg = analysis?.realMatchXg || factors.stats?.xgMatchReel || null;
  const xgSaison = factors.stats?.xgSaison || null;
  const freshHome = factors.forme?.fraicheurHome?.count ?? 0;
  const freshAway = factors.forme?.fraicheurAway?.count ?? 0;
  const finished = fixture ? isFixtureFinished(fixture) : false;

  const referee = factors.autres?.arbitre || fotmob?.referee || null;
  const coaches = factors.autres?.entraineurs || fotmob?.coaches || null;
  const homeAbsenceCount = Array.isArray(factors.blessures?.homePlayers) ? factors.blessures.homePlayers.length : null;
  const awayAbsenceCount = Array.isArray(factors.blessures?.awayPlayers) ? factors.blessures.awayPlayers.length : null;

  return (
    <section className="analysisPanel" id="analyse">
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
        <div className="analysisTopBadges">
          {fotmob && <span className="fotmobActivePill">ESPN + FOTMOB</span>}
          <span className="estimatePill">ESTIMATION · NON GARANTIE</span>
        </div>
      </div>

      {fixture ? (
        <>
          <div className="matchHero">
            <div className="analysisMatchMeta">
              <span>{longDate(dayKey)}</span>
              <span>·</span>
              <span>{timeOf(fixture.date)} COT</span>
              {fixture.venue && (
                <>
                  <span>·</span>
                  <span>{fixture.venue}</span>
                </>
              )}
              {referee?.name && (
                <>
                  <span>·</span>
                  <span title="Arbitre désigné (FotMob)">⚖ {referee.name}</span>
                </>
              )}
              <span className={`matchStatusPill ${finished ? 'statusDone' : 'statusUpcoming'}`}>
                {finished ? 'Terminé' : 'À venir'}
              </span>
            </div>
            <div className="scoreboard">
              <div>
                <TeamBadge team={fixture.home} size={56} />
                <b>{fixture.home?.name}</b>
                <small>
                  DOMICILE{coaches?.home ? ` · ${coaches.home}` : ''}
                </small>
              </div>
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
              <div>
                <TeamBadge team={fixture.away} size={56} />
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
                    <span>xG RÉELS DU MATCH (FOTMOB)</span>
                    <b>{realMatchXg.homeXg}</b>
                    <i>—</i>
                    <b>{realMatchXg.awayXg}</b>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="analysisTabs">
            {([
              ['resume', 'Vue d’ensemble'],
              ['facteurs', '8 facteurs'],
              ['vigilance', 'Vigilance'],
            ] as const).map(([id, label]) => (
              <button key={id} className={tab === id ? 'tabActive' : ''} onClick={() => setTab(id)}>
                {label}
                {id === 'facteurs' && (homeAbsenceCount || awayAbsenceCount) ? (
                  <small className="tabCountTag">{(homeAbsenceCount || 0) + (awayAbsenceCount || 0)} abs.</small>
                ) : null}
                {id === 'vigilance' && <i />}
              </button>
            ))}
          </div>

          {analysisLoading && (
            <div className="analysisLoading">
              <i className="largeSpinner" />
              <div>
                <b>Analyse en cours</b>
                <span>Croisement ESPN & FotMob (xG, blessés/suspendus, H2H, arbitre)…</span>
              </div>
            </div>
          )}

          {!analysisLoading && analysisError && <div className="analysisError">{analysisError}</div>}

          {!analysisLoading && analysis && tab === 'resume' && (
            <>
              <div className="predictionIntro">
                <div>
                  <span className="sectionKicker">MODÈLE STATISTIQUE ENRICHI</span>
                  <h3>Estimations du match</h3>
                  <small>
                    Forme récente ({freshHome}/5 & {freshAway}/5 matchs)
                    {fotmob ? ' · xG, effectifs & H2H FotMob intégrés' : ' · sur 60 jours max'}
                  </small>
                </div>
                <span className="modelMark">{fotmob ? 'Poisson + xG FotMob' : 'Poisson'}</span>
              </div>
              {(freshHome < 5 || freshAway < 5) && (
                <div className="dataWarning">
                  Échantillon récent incomplet. Les données plus anciennes sont exclues ; la confiance dans l’estimation est donc plus
                  limitée.
                </div>
              )}

              {/* Aperçu rapide des absents majeurs directement sur la vue d'ensemble si FotMob signale des blessés/suspendus */}
              {(homeAbsenceCount !== null || awayAbsenceCount !== null) && ((homeAbsenceCount || 0) > 0 || (awayAbsenceCount || 0) > 0) && (
                <div className="squadQuickBanner">
                  <div className="squadQuickHeader">
                    <span>✚ EFFECTIFS & ABSENCES (FOTMOB)</span>
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
                  <ProbBar label={`Victoire · ${fixture.home?.short || 'domicile'}`} value={probabilities.home} />
                  <ProbBar label="Match nul" value={probabilities.draw} color="var(--gold)" />
                  <ProbBar label={`Victoire · ${fixture.away?.short || 'extérieur'}`} value={probabilities.away} color="var(--blue)" />
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>↗</span>
                    <div>
                      <b>Les deux équipes marquent</b>
                      <small>BTTS · match entier</small>
                    </div>
                  </div>
                  <div className="bttsGrid">
                    <div>
                      <small>OUI</small>
                      <b>{pct(probabilities.bttsYes)}</b>
                      <i style={{ width: `${(probabilities.bttsYes || 0) * 100}%` }} />
                    </div>
                    <div>
                      <small>NON</small>
                      <b>{pct(probabilities.bttsNo)}</b>
                      <i style={{ width: `${(probabilities.bttsNo || 0) * 100}%` }} />
                    </div>
                  </div>
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>Σ</span>
                    <div>
                      <b>Total de buts</b>
                      <small>Plus / moins · match entier</small>
                    </div>
                  </div>
                  <div className="totalsTable">
                    <div>
                      <span>SEUIL</span>
                      <span>PLUS</span>
                      <span>MOINS</span>
                    </div>
                    {[
                      ['1,5', probabilities.over15, probabilities.under15],
                      ['2,5', probabilities.over25, probabilities.under25],
                    ].map(row => (
                      <div key={row[0]}>
                        <b>{row[0]}</b>
                        <strong>{pct(row[1])}</strong>
                        <strong>{pct(row[2])}</strong>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>⌗</span>
                    <div>
                      <b>Scores les plus probables</b>
                      <small>Estimations du modèle</small>
                    </div>
                  </div>
                  <div className="scoreChips">
                    {(analysis.topScores || []).slice(0, 5).map((score: any) => (
                      <span key={`${score.h}-${score.a}`}>
                        <b>
                          {score.h}–{score.a}
                        </b>
                        <small>{pct(score.p)}</small>
                      </span>
                    ))}
                  </div>
                </article>

                <article className="predictionCard fullPrediction">
                  <div className="cardHeading">
                    <span>½</span>
                    <div>
                      <b>Buts par période</b>
                      <small>Probabilités par mi-temps</small>
                    </div>
                  </div>
                  <div className="halfTable">
                    <div>
                      <span>PÉRIODE</span>
                      <span>SEUIL</span>
                      <span>PLUS</span>
                      <span>MOINS</span>
                    </div>
                    {[
                      ['1re mi-temps', '1,5', probabilities.firstHalf?.over15],
                      ['1re mi-temps', '2,5', probabilities.firstHalf?.over25],
                      ['2e mi-temps', '1,5', probabilities.secondHalf?.over15],
                      ['2e mi-temps', '2,5', probabilities.secondHalf?.over25],
                    ].map((row, index) => (
                      <div key={index}>
                        <span>{row[0]}</span>
                        <b>{row[1]}</b>
                        <strong>{pct(row[2])}</strong>
                        <strong>{pct(typeof row[2] === 'number' ? 1 - row[2] : undefined)}</strong>
                      </div>
                    ))}
                  </div>
                  <small className="tableNote">Estimations par période, indépendantes du score à la pause.</small>
                </article>
              </div>

              {Array.isArray(fotmob?.insights) && fotmob.insights.length > 0 && (
                <div className="fotmobInsightsBox">
                  <span className="sectionKicker">FAITS MARQUANTS · FOTMOB / OPTA</span>
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
                Les probabilités sont des estimations fondées sur des flux publics (ESPN & FotMob). Elles ne constituent ni conseil de pari
                ni garantie de résultat.
              </p>
            </>
          )}

          {!analysisLoading && analysis && tab === 'facteurs' && (
            <div className="factorArea">
              <div className="subsectionHeading">
                <span className="sectionKicker">MÉTHODE RAPIDE EN 5 MINUTES</span>
                <h3>Les 8 facteurs pris en compte</h3>
                <p>Données croisées entre ESPN et le flux JSON public FotMob (blessés/suspendus, vrais xG, H2H multi-saisons, arbitre).</p>
              </div>
              <div className="factorGrid">
                <FactorCard
                  number="01"
                  title="Forme récente · 5 matchs max"
                  badge="ESPN"
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
                  badge="ESPN"
                  leftLabel="À domicile"
                  rightLabel="À l’extérieur"
                  left={<p>{factors.domicileExterieur?.home}</p>}
                  right={<p>{factors.domicileExterieur?.away}</p>}
                />
                <FactorCard
                  number="03"
                  title="Confrontations directes"
                  badge={factors.h2h?.source === 'FotMob' ? 'FotMob' : 'ESPN'}
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
                  badge={Array.isArray(factors.blessures?.homePlayers) ? 'FotMob' : 'ESPN'}
                  leftLabel={fixture.home?.short || fixture.home?.name}
                  rightLabel={fixture.away?.short || fixture.away?.name}
                  left={<AbsenceChips players={factors.blessures?.homePlayers} fallbackText={factors.blessures?.home} />}
                  right={<AbsenceChips players={factors.blessures?.awayPlayers} fallbackText={factors.blessures?.away} />}
                  note={factors.blessures?.note}
                />
                <FactorCard
                  number="05"
                  title="Enjeu & classement"
                  badge="ESPN"
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
                  badge="ESPN"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={styleSummary(factors.style?.home)}
                  right={styleSummary(factors.style?.away)}
                  note="Moyennes des derniers matchs disponibles : possession, tirs, tirs cadrés, corners et cartons."
                />
                <FactorCard
                  number="07"
                  title="Attaque, défense & vrais xG"
                  badge={xgSaison?.home || realMatchXg ? 'ESPN + FotMob' : 'ESPN'}
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={formatAttackDefense(factors.stats?.home, xgSaison?.home)}
                  right={formatAttackDefense(factors.stats?.away, xgSaison?.away)}
                  note={factors.stats?.note}
                />
                <FactorCard
                  number="08"
                  title="Météo, repos, arbitre & bancs"
                  badge={fotmob ? 'ESPN + FotMob' : 'ESPN'}
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
                  Les absences (blessés/suspendus) et les vrais xG/xGA FotMob ajustent directement les buts attendus (λ) du modèle de
                  Poisson. Vérifiez toujours le onze officiel publié 1h avant le coup d’envoi.
                </span>
              </div>
            </div>
          )}

          {!analysisLoading && analysis && tab === 'vigilance' && (
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
      ) : fixtureLoading || analysisLoading ? (
        <div className="analysisLoading">
          <i className="largeSpinner" />
          <div>
            <b>Chargement de la rencontre…</b>
            <span>Récupération des informations ESPN & FotMob…</span>
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

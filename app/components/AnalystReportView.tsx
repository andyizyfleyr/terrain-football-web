'use client';

import { pct } from '../lib/terrain';

function fmtPct(value: any): string {
  return typeof value === 'number' ? `${Math.round(value * 100)} %` : '—';
}

function fmtSigned(value: any): string {
  if (typeof value !== 'number') return '—';
  const pts = Math.round(value * 1000) / 10;
  return `${pts > 0 ? '+' : ''}${pts} pts`;
}

function statusLabel(status: string): string {
  if (status === 'ok') return 'Actif';
  if (status === 'partial') return 'Partiel';
  return 'Données absentes';
}

export function AnalystReportView({ analyst }: { analyst: any }) {
  if (!analyst) {
    return (
      <div className="analystEmpty">
        <div className="placeholderIcon">◉</div>
        <b>Rapport quantitatif indisponible</b>
        <p>
          Le moteur d&apos;analyse n&apos;a pas pu être alimenté pour cette rencontre (données publiques indisponibles ou
          indisponibles au moment de la requête).
        </p>
      </div>
    );
  }

  const confidence = analyst.confidence || {};
  const market = analyst.market || {};
  const simulation = analyst.simulation || {};
  const modules: any[] = Array.isArray(analyst.modules) ? analyst.modules : [];
  const synthesis = analyst.synthesis || {};
  const finishing = analyst.finishing || {};
  const absences = analyst.absences || {};
  const context = analyst.context || {};
  const tactics = analyst.tactics || {};
  const schedule = analyst.scheduleStrength || {};
  const homeName = analyst.homeName || 'Dom.';
  const awayName = analyst.awayName || 'Ext.';

  const outcomeRows = [
    { label: `Victoire ${homeName}`, model: market.pureModel?.home, calibrated: market.calibrated?.home, market: market.devigged?.home, edge: market.edges?.home },
    { label: 'Match nul', model: market.pureModel?.draw, calibrated: market.calibrated?.draw, market: market.devigged?.draw, edge: market.edges?.draw },
    { label: `Victoire ${awayName}`, model: market.pureModel?.away, calibrated: market.calibrated?.away, market: market.devigged?.away, edge: market.edges?.away },
  ];

  return (
    <div className="analystArea">
      {/* ---------- Verdict & confiance ---------- */}
      <section className="analystVerdict">
        <div className="analystConfidence">
          <span>INDICE DE CONFIANCE</span>
          <b>
            {confidence.score ?? '—'}
            <small>/100</small>
          </b>
          <strong>{confidence.label || '—'}</strong>
          <div className="analystGauge">
            <i style={{ width: `${Math.max(3, Math.min(100, confidence.score ?? 0))}%` }} />
          </div>
          <p>
            Complétude {Math.round((confidence.completeness ?? 0) * 100)} % · séparation {Math.round((confidence.separation ?? 0) * 100)} %
            · accord marché {Math.round((confidence.agreement ?? 0) * 100)} %
          </p>
        </div>
        <div className="analystVerdictBody">
          <span className="sectionKicker">SYNTHÈSE DE L&apos;ANALYSTE IA</span>
          <h3>{synthesis.headline || 'Estimation en cours.'}</h3>
          <ul className="analystBullets">
            {(synthesis.bullets || []).map((b: string, i: number) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <p className="analystVerdictText">{synthesis.text}</p>
        </div>
      </section>

      {/* ---------- Modèle pur vs marché ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 06 · CALIBRATION BAYÉSIENNE</span>
          <h3>Modèle pur, marché et valeur détectée</h3>
          <p>
            {market.note ||
              'Comparaison entre le modèle quantitatif et les probabilités de marché après retrait de la marge bookmaker.'}
          </p>
        </div>
        <div className="analystEdgeTable">
          <div className="analystEdgeHead">
            <span>ISSUE</span>
            <span>MODÈLE PUR</span>
            <span>CALIBRÉ</span>
            <span>MARCHÉ</span>
            <span>ÉCART</span>
          </div>
          {outcomeRows.map(row => (
            <div className="analystEdgeRow" key={row.label}>
              <span>{row.label}</span>
              <b>{fmtPct(row.model)}</b>
              <b className="analystEdgeCalib">{fmtPct(row.calibrated)}</b>
              <b>{fmtPct(row.market)}</b>
              <em className={(row.edge ?? 0) >= 0 ? 'edgePos' : 'edgeNeg'}>{fmtSigned(row.edge)}</em>
            </div>
          ))}
          {market.available ? (
            <div className="analystEdgeFoot">
              <span>Poids modèle {Math.round((market.weights?.model ?? 0) * 100)} % / marché {Math.round((market.weights?.market ?? 0) * 100)} %</span>
              <span>Marge retirée : {market.method} · surcharge {Math.round(((market.overround ?? 1) - 1) * 1000) / 10} %</span>
            </div>
          ) : (
            <div className="analystEdgeFoot">
              <span>Aucune cote disponible : modèle pur conservé sans calibrage.</span>
            </div>
          )}
        </div>
        {market.value?.pick ? (
          <div className="analystValueBanner">
            <span>◆</span>
            <b>{market.value.label}</b>
            <em>{fmtSigned(market.value.edge)}</em>
          </div>
        ) : null}
      </section>

      {/* ---------- Les 8 modules ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MOTEUR QUANTITATIF V2</span>
          <h3>Les 8 modules d&apos;analyse</h3>
          <p>Chaque module alimente le modèle final ; les indicateurs ci-dessous sont les valeurs réellement utilisées.</p>
        </div>
        <div className="analystModuleGrid">
          {modules.map((m: any) => (
            <article className="analystModuleCard" key={m.id}>
              <div className="analystModuleHead">
                <span>{String(m.id).padStart(2, '0')}</span>
                <b>{m.title}</b>
                <em className={`analystStatus analystStatus${m.status}`}>{statusLabel(m.status)}</em>
              </div>
              <p className="analystModuleSummary">{m.summary}</p>
              <div className="analystModuleMetrics">
                {(m.metrics || []).map((metric: any, i: number) => (
                  <div key={i}>
                    <small>{metric.label}</small>
                    <b>{metric.value}</b>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ---------- xG, set pieces, gardiens ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 03 · QUALITÉ OFFENSIVE</span>
          <h3>xG hors penalties, coups de pied arrêtés & gardiens</h3>
        </div>
        <div className="analystTwoCol">
          <div className="analystMiniTable">
            <div className="analystMiniHead">
              <span>INDICATEUR</span>
              <span>{homeName}</span>
              <span>{awayName}</span>
            </div>
            {[
              ['xG / match', finishing.home?.xg, finishing.away?.xg],
              ['npxG / match', finishing.home?.npxg, finishing.away?.npxg],
              ['Penalties obtenus', finishing.home?.penaltiesWon, finishing.away?.penaltiesWon],
              ['Grandes occasions', finishing.home?.bigChances, finishing.away?.bigChances],
              ['Conversion grandes occ.', finishing.home?.bigChanceConversion, finishing.away?.bigChanceConversion],
              ['Touches surface', finishing.home?.boxTouches, finishing.away?.boxTouches],
              ['Corners', finishing.home?.corners, finishing.away?.corners],
              ['Buts sur CPA', finishing.home?.setPieceGoals, finishing.away?.setPieceGoals],
              ['Buts CPA encaissés', finishing.home?.setPieceGoalsConceded, finishing.away?.setPieceGoalsConceded],
              ['Ratio finition', finishing.home?.finishingRatio, finishing.away?.finishingRatio],
            ].map(row => (
              <div key={String(row[0])}>
                <span>{row[0]}</span>
                <b>{row[1] ?? '—'}</b>
                <b>{row[2] ?? '—'}</b>
              </div>
            ))}
          </div>
          <div className="analystKeeperBox">
            <span className="sectionKicker">GARDIENS</span>
            <div className="analystKeeper">
              <b>{finishing.goalkeepers?.home?.name || '—'}</b>
              <small>Buts évités (xGOT) : {finishing.goalkeepers?.home?.goalsPrevented ?? '—'}</small>
              <small>Arrêts : {finishing.goalkeepers?.home?.savePercentage ?? '—'} %</small>
              <em>Facteur ×{finishing.goalkeepers?.home?.factor ?? '—'}</em>
            </div>
            <div className="analystKeeper">
              <b>{finishing.goalkeepers?.away?.name || '—'}</b>
              <small>Buts évités (xGOT) : {finishing.goalkeepers?.away?.goalsPrevented ?? '—'}</small>
              <small>Arrêts : {finishing.goalkeepers?.away?.savePercentage ?? '—'} %</small>
              <em>Facteur ×{finishing.goalkeepers?.away?.factor ?? '—'}</em>
            </div>
            <p className="analystKeeperNote">
              Le « Goals Prevented » mesure l'écart entre le xGOT et les buts réellement encaissés : c'est le meilleur indicateur
              disponible de la qualité d'un gardien sur la saison.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- Calendrier & contexte ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 07 · CONTEXTE</span>
          <h3>Congestion, calendrier européen, enjeux, arbitre & météo</h3>
        </div>
        <div className="analystTwoCol">
          <div className="analystMiniTable">
            <div className="analystMiniHead">
              <span>CALENDRIER</span>
              <span>{homeName}</span>
              <span>{awayName}</span>
            </div>
            {[
              ['Matchs sur 7 jours', context.home?.matches7, context.away?.matches7],
              ['Matchs sur 14 jours', context.home?.matches14, context.away?.matches14],
              ['Jours de repos', context.home?.restDays ?? '—', context.away?.restDays ?? '—'],
              ['Indice de fatigue', `${Math.round((context.home?.fatigue ?? 0) * 100)} %`, `${Math.round((context.away?.fatigue ?? 0) * 100)} %`],
            ].map(row => (
              <div key={String(row[0])}>
                <span>{row[0]}</span>
                <b>{row[1] ?? '—'}</b>
                <b>{row[2] ?? '—'}</b>
              </div>
            ))}
          </div>
          <div className="analystContextBox">
            <div className="analystContextRow">
              <b>Enjeu {homeName}</b>
              <span>{context.stakes?.home || '—'}</span>
            </div>
            <div className="analystContextRow">
              <b>Enjeu {awayName}</b>
              <span>{context.stakes?.away || '—'}</span>
            </div>
            <div className="analystContextRow">
              <b>Arbitre</b>
              <span>
                {context.referee?.name || 'Non désigné'} — {context.referee?.note || '—'}
              </span>
            </div>
            <div className="analystContextRow">
              <b>Météo</b>
              <span>{context.weather?.note || '—'}</span>
            </div>
            <div className="analystContextRow">
              <b>Europe</b>
              <span>
                {context.home?.european?.note || '—'}
                {context.away?.european?.found ? ` · ${awayName} : ${context.away.european.note}` : ''}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Tactique ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 05 · CONFRONTATION TACTIQUE</span>
          <h3>Profils de jeu et effet sur le rythme du match</h3>
        </div>
        <div className="analystTacticalRow">
          <div className="analystTacticalCard">
            <b>{homeName}</b>
            <strong>{tactics.home?.profile || '—'}</strong>
            <small>{tactics.home?.note || '—'}</small>
            <em>Tempo ×{tactics.home?.tempo ?? '—'}</em>
          </div>
          <div className="analystTacticalCard analystTacticalMid">
            <span>{tactics.matchup?.label || 'Confrontation'}</span>
            <b>×{tactics.matchup?.tempoFactor ?? '—'}</b>
            <small>Facteur de tempo global · ajustement ρ {tactics.matchup?.rhoAdjustment ?? '—'}</small>
          </div>
          <div className="analystTacticalCard">
            <b>{awayName}</b>
            <strong>{tactics.away?.profile || '—'}</strong>
            <small>{tactics.away?.note || '—'}</small>
            <em>Tempo ×{tactics.away?.tempo ?? '—'}</em>
          </div>
        </div>
        <ul className="analystEffectList">
          {(tactics.matchup?.effects || []).map((e: string, i: number) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </section>

      {/* ---------- Absences ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 04 · EFFECTIFS</span>
          <h3>Absences intelligentes &amp; onze officiel</h3>
          <p>
            {absences.officialLineup?.note ||
              'Les joueurs de longue durée sont déjà intégrés aux xG de saison : ils ne sont donc pas pénalisés une seconde fois.'}
          </p>
        </div>
        <div className="analystTwoCol">
          <div className="analystAbsenceCol">
            <b>{homeName}</b>
            <span>
              Impact attaque −{Math.round((absences.home?.attackImpact ?? 0) * 100)} % · défense +
              {Math.round((absences.home?.defenceImpact ?? 0) * 100)} %
            </span>
            <ul>
              {(absences.home?.items || []).map((it: any, i: number) => (
                <li key={i} className={it.longTerm ? 'absenceLong' : ''}>
                  <b>{it.name}</b>
                  <small>{it.role}</small>
                  <em>{it.note}</em>
                </li>
              ))}
              {!(absences.home?.items || []).length && <li className="absenceLong">Aucun absent signalé.</li>}
            </ul>
          </div>
          <div className="analystAbsenceCol">
            <b>{awayName}</b>
            <span>
              Impact attaque −{Math.round((absences.away?.attackImpact ?? 0) * 100)} % · défense +
              {Math.round((absences.away?.defenceImpact ?? 0) * 100)} %
            </span>
            <ul>
              {(absences.away?.items || []).map((it: any, i: number) => (
                <li key={i} className={it.longTerm ? 'absenceLong' : ''}>
                  <b>{it.name}</b>
                  <small>{it.role}</small>
                  <em>{it.note}</em>
                </li>
              ))}
              {!(absences.away?.items || []).length && <li className="absenceLong">Aucun absent signalé.</li>}
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- Monte-Carlo ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 08 · MONTE-CARLO</span>
          <h3>
            {simulation.runs ? simulation.runs.toLocaleString('fr-FR') : '10 000'} simulations minute par minute
          </h3>
          <p>
            Chaque itération rejoue les 90 minutes avec une courbe d&apos;intensité par période, des états de jeu dynamiques
            (équipe menée qui pousse, équipe en tête qui protège) et un regain de buts après la 70e minute.
          </p>
        </div>
        <div className="analystSimGrid">
          <div className="analystSimCard">
            <small>Victoire {homeName}</small>
            <b>{fmtPct(simulation.home)}</b>
          </div>
          <div className="analystSimCard">
            <small>Match nul</small>
            <b>{fmtPct(simulation.draw)}</b>
          </div>
          <div className="analystSimCard">
            <small>Victoire {awayName}</small>
            <b>{fmtPct(simulation.away)}</b>
          </div>
          <div className="analystSimCard">
            <small>Intervalle de buts (5-95 %)</small>
            <b>
              {simulation.goalRange?.low ?? '—'} – {simulation.goalRange?.high ?? '—'}
            </b>
          </div>
          <div className="analystSimCard">
            <small>But après la 70e</small>
            <b>{fmtPct(simulation.lateGoalProbability)}</b>
          </div>
          <div className="analystSimCard">
            <small>Les deux équipes marquent</small>
            <b>{fmtPct(simulation.btts)}</b>
          </div>
        </div>
        <div className="analystScenarios">
          {(simulation.scenarios || []).map((sc: any, i: number) => (
            <div key={i}>
              <span>{sc.label}</span>
              <div className="analystScenarioTrack">
                <i style={{ width: `${Math.round(sc.probability * 100)}%` }} />
              </div>
              <b>{fmtPct(sc.probability)}</b>
            </div>
          ))}
        </div>
        <div className="analystScoreChips">
          {(simulation.topScores || []).slice(0, 6).map((sc: any, i: number) => (
            <span key={i}>
              <b>
                {sc.h}–{sc.a}
              </b>
              <small>{pct(sc.p)}</small>
            </span>
          ))}
        </div>
      </section>

      {/* ---------- Force du calendrier ---------- */}
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MODULE 02 · FORCE DU CALENDRIER</span>
          <h3>xG ajusté selon les adversaires et les splits terrain</h3>
          <p>{schedule.splits?.note}</p>
        </div>
        <div className="analystTwoCol">
          <div className="analystMiniTable">
            <div className="analystMiniHead">
              <span>INDICATEUR</span>
              <span>{homeName}</span>
              <span>{awayName}</span>
            </div>
            {[
              ['Force des adversaires', `${Math.round((schedule.home?.sos ?? 1) * 100)} %`, `${Math.round((schedule.away?.sos ?? 1) * 100)} %`],
              ['Attaque ajustée / m.', schedule.home?.attack, schedule.away?.attack],
              ['Défense ajustée / m.', schedule.home?.defence, schedule.away?.defence],
              ['Matchs analysés', schedule.home?.matches, schedule.away?.matches],
              ['Buts marqués (split)', schedule.splits?.homeAttack, schedule.splits?.awayAttack],
              ['Buts encaissés (split)', schedule.splits?.homeDefence, schedule.splits?.awayDefence],
              ['Avantage domicile du championnat', `×${schedule.splits?.leagueHomeAdvantage ?? '—'}`, '—'],
            ].map(row => (
              <div key={String(row[0])}>
                <span>{row[0]}</span>
                <b>{row[1] ?? '—'}</b>
                <b>{row[2] ?? '—'}</b>
              </div>
            ))}
          </div>
          <div className="analystContextBox">
            <div className="analystContextRow">
              <b>Décroissance exponentielle</b>
              <span>
                {analyst.timeDecay?.homeMatches ?? 0} matchs (dom.) et {analyst.timeDecay?.awayMatches ?? 0} (ext.) pondérés —
                demi-vie {analyst.timeDecay?.halfLifeDays ?? '—'} jours.
              </span>
            </div>
            <div className="analystContextRow">
              <b>Corrélation ρ</b>
              <span>{analyst.dixonColes?.note}</span>
            </div>
            <div className="analystContextRow">
              <b>Buts attendus</b>
              <span>
                λ {analyst.lambdas?.home} – {analyst.lambdas?.away} (total {analyst.lambdas?.total})
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

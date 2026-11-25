'use client';

import { useMemo } from 'react';
import { Fixture } from '../lib/terrain';
import { TeamBadge } from './TeamBadge';

export const MIN_ANALYSIS_MS = 10000;

export type AnalysisStep = {
  id: string;
  label: string;
  detail: string;
  start: number;
  end: number;
};

/** Les 12 étapes analytiques affichées pendant la séquence de 10 secondes */
export const ANALYSIS_STEPS: AnalysisStep[] = (() => {
  const durations = [600, 700, 700, 750, 750, 800, 800, 800, 800, 800, 950, 1350];
  const steps: AnalysisStep[] = [];
  const defs: { id: string; label: string; detail: string }[] = [
    { id: 'collect', label: 'Collecte des données de la rencontre', detail: 'Calendrier, forme, effectifs, xG, tactique, cotes' },
    { id: 'dixon', label: 'Modèle bivarié de Dixon-Coles', detail: 'Correction de la corrélation sur les scores serrés (ρ)' },
    { id: 'decay', label: 'Décroissance exponentielle de la forme', detail: 'Pondération e^(−ξΔt) des rencontres récentes' },
    { id: 'sos', label: 'Force du calendrier (xG ajustés)', detail: 'Chaque match pesé selon la force de l\'adversaire' },
    { id: 'splits', label: 'Splits domicile / extérieur', detail: 'xG, buts encaissés et avantage domicile du championnat' },
    { id: 'npxg', label: 'xG hors penalties & coups de pied arrêtés', detail: 'npxG, corners, surface de penalty, finition, gardiens' },
    { id: 'squad', label: 'Effectifs, absences & onze officiel', detail: 'Titulaires vs longue absence, rotation du onze' },
    { id: 'tactics', label: 'Confrontation tactique', detail: 'Pressing, bloc bas, transitions, jeu direct, tempo' },
    { id: 'market', label: 'Calibration bayésienne vs marché', detail: 'Retrait de la marge bookmaker (Shin / Power) puis arbitrage' },
    { id: 'context', label: 'Congestion 14 j, enjeux, arbitre & météo', detail: 'Calendrier européen, pression du classement, friction' },
    { id: 'montecarlo', label: 'Simulation Monte-Carlo (10 000 itérations)', detail: 'Minute par minute, états de jeu dynamiques, 90\' + arrêts' },
    { id: 'synthesis', label: 'Synthèse de l\'Analyste IA', detail: 'Confiance, scénarios tactiques et verdict final' },
  ];
  let cursor = 0;
  for (let i = 0; i < defs.length; i++) {
    const d = durations[i] ?? 800;
    steps.push({ ...defs[i], start: cursor, end: cursor + d });
    cursor += d;
  }
  return steps;
})();

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

type AiAnalysisLoaderProps = {
  fixture?: Fixture | null;
  elapsed: number;
  progress: number;
  dataReady: boolean;
  analyst?: any;
  /**
   * Couvre toute la page (calque fixe plein viewport) au lieu de
   * s'insérer dans le panneau d'analyse. Utilisé par la fiche match.
   */
  fullPage?: boolean;
};

export function AiAnalysisLoader({
  fixture,
  elapsed,
  progress,
  dataReady,
  analyst,
  fullPage = false,
}: AiAnalysisLoaderProps) {
  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < ANALYSIS_STEPS.length; i++) {
      if (elapsed >= ANALYSIS_STEPS[i].start) idx = i;
    }
    return idx;
  }, [elapsed]);

  const waiting = elapsed >= MIN_ANALYSIS_MS && !dataReady;

  const telemetry = useMemo(() => {
    const a = analyst;
    return [
      { label: 'λ ATTENDUS', value: a ? `${a.lambdas?.home} – ${a.lambdas?.away}` : '—', ready: Boolean(a) },
      { label: 'ρ DIXON-COLES', value: a ? `${a.dixonColes?.rho > 0 ? '+' : ''}${a.dixonColes?.rho}` : '—', ready: Boolean(a) },
      { label: 'SIMULATIONS', value: a ? '10 000' : '10 000', ready: Boolean(a) },
      { label: 'CONFIANCE', value: a ? `${a.confidence?.score}/100` : '—', ready: Boolean(a) },
      {
        label: 'MARCHÉ DÉVIGGÉ',
        value: a?.market?.available
          ? `${Math.round(a.market.devigged.home * 100)}/${Math.round(a.market.devigged.draw * 100)}/${Math.round(
              a.market.devigged.away * 100
            )}`
          : '—',
        ready: Boolean(a?.market?.available),
      },
    ];
  }, [analyst]);

  // `fullPage` : le loader devient un calque fixe qui couvre TOUTE la page
  // (en-tête, onglets, panneau), au lieu d'une carte insérée dans le
  // panneau d'analyse. Le contenu réel reste monté derrière : il n'est que
  // visuellement masqué, donc aucun état n'est perdu au dévoilement.
  return (
    <div className={`aiLoader ${fullPage ? 'aiLoaderFullPage' : ''}`} role="status" aria-live="polite">
      {fullPage ? <div className="aiLoaderBackdrop" aria-hidden="true" /> : null}
      <div className="aiLoaderGlow" />
      <div className={fullPage ? 'aiLoaderInner aiLoaderInnerCentered' : 'aiLoaderInner'}>
      <div className="aiLoaderHead">
        <span className="aiLoaderPulse">
          <i />
        </span>
        <div>
          <b>L’IA ANALYSE LE MATCH</b>
          <small>Moteur quantitatif · 8 modules · simulation minute par minute</small>
        </div>
        <span className="aiLoaderPct">{Math.round(progress)}%</span>
      </div>

      <div className="aiLoaderTeams">
        <div className="aiLoaderTeam">
          <TeamBadge team={fixture?.home} size={40} />
          <b>{fixture?.home?.short || fixture?.home?.name || 'Équipe 1'}</b>
        </div>
        <span className="aiLoaderVersus">VS</span>
        <div className="aiLoaderTeam">
          <TeamBadge team={fixture?.away} size={40} />
          <b>{fixture?.away?.short || fixture?.away?.name || 'Équipe 2'}</b>
        </div>
      </div>

      <div className="aiLoaderBar">
        <i style={{ width: `${Math.min(100, progress)}%` }} />
      </div>

      <div className="aiLoaderSteps">
        {ANALYSIS_STEPS.map((step, index) => {
          const done = index < activeIndex || (dataReady && index <= activeIndex);
          const active = index === activeIndex && !done;
          return (
            <div
              key={step.id}
              className={`aiLoaderStep ${done ? 'aiLoaderStepDone' : ''} ${active ? 'aiLoaderStepActive' : ''}`}
            >
              <span className="aiLoaderStepIcon">{done ? '✓' : active ? '◉' : '·'}</span>
              <div>
                <b>{step.label}</b>
                <small>{step.detail}</small>
              </div>
            </div>
          );
        })}
      </div>

      <div className="aiLoaderTelemetry">
        {telemetry.map(t => (
          <span key={t.label} className={`aiLoaderChip ${t.ready ? 'aiLoaderChipReady' : ''}`}>
            <small>{t.label}</small>
            <b>{t.value}</b>
          </span>
        ))}
      </div>

      <p className="aiLoaderFoot">
        {waiting
          ? 'Récupération finale des données de la rencontre…'
          : 'Traitement quantitatif en cours — aucune estimation n’est publiée avant la fin du calcul.'}
      </p>
      </div>
    </div>
  );
}

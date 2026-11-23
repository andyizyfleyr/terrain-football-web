'use client';

/**
 * Barre de probabilité : libellé, valeur en pourcentage et intervalle
 * de crédibilité optionnel.
 */
export function ProbBar({
  label,
  value,
  color = 'var(--green)',
  interval,
  note,
}: {
  label: string;
  value: any;
  color?: string;
  interval?: { low: number; high: number } | null;
  note?: string;
}) {
  const width = typeof value === 'number' ? Math.max(2, Math.min(100, value * 100)) : 0;
  const hasInterval =
    interval &&
    typeof interval.low === 'number' &&
    typeof interval.high === 'number' &&
    Number.isFinite(interval.low) &&
    Number.isFinite(interval.high);
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  return (
    <div className="probRow">
      <div className="probLabel">
        <span>{label}</span>
        <b>{hasValue ? `${Math.round(value * 100)}%` : '—'}</b>
        {hasInterval ? (
          <em className="probInterval">
            {Math.round(interval!.low * 100)}–{Math.round(interval!.high * 100)} %
          </em>
        ) : null}
      </div>
      <div className="probTrack">
        <i style={{ width: `${width}%`, background: color }} />
      </div>
      {note ? <small className="probNote">{note}</small> : null}
    </div>
  );
}

export default ProbBar;

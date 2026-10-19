import { deltaClass, formatSigned } from '../lib/format.js';

function Sparkline({ values }) {
  const width = 96;
  const height = 28;
  const inset = 3;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(1, high - low);
  const points = values.map((value, index) => [
    inset + (index / (values.length - 1)) * (width - inset * 2),
    inset + (1 - (value - low) / range) * (height - inset * 2),
  ]);
  const last = points[points.length - 1];
  return (
    <svg className="sparkline" width={width} height={height} viewBox={'0 0 ' + width + ' ' + height} aria-hidden="true">
      <polyline
        points={points.map((point) => point.map((n) => n.toFixed(1)).join(',')).join(' ')}
        fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"
      />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3" fill="var(--accent)" />
    </svg>
  );
}

export default function Kpis({ kpis }) {
  const highRiskCount = kpis.criticalCount + kpis.highCount;
  return (
    <section className="kpi-strip" aria-label="Key figures">
      <div className="kpi-cell">
        <span className="kpi-label">Safety score</span>
        <div className="kpi-score-row">
          <span className="kpi-value kpi-value-hero">{kpis.score}<span className="kpi-unit">/100</span></span>
          <Sparkline values={kpis.sparkline} />
        </div>
        <span className={'kpi-foot ' + deltaClass(kpis.scoreDelta, true)}>
          <span className="num">{formatSigned(kpis.scoreDelta)} {kpis.deltaLabel}</span>
        </span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">Incidents</span>
        <span className="kpi-value">{kpis.incidentCount}</span>
        <span className={'kpi-foot ' + deltaClass(kpis.incidentDelta, false)}>
          <span className="num">{formatSigned(kpis.incidentDelta)} {kpis.deltaLabel}</span>
        </span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">High risk</span>
        <span className="kpi-value">
          {highRiskCount}
          {highRiskCount > 0 && (
            <span className="severity-breakdown">
              <span className="severity-breakdown-item severity-critical"><span className="severity-tick" /><span className="mono">{kpis.criticalCount}</span></span>
              <span className="severity-breakdown-item severity-high"><span className="severity-tick" /><span className="mono">{kpis.highCount}</span></span>
            </span>
          )}
        </span>
        <span className="kpi-foot">Critical and High</span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">Leading violation</span>
        <span className="kpi-value kpi-value-text">{kpis.leading ? kpis.leading.name : 'None'}</span>
        <span className="kpi-foot">
          <span className="num">{kpis.leading ? kpis.leading.count : 0} of {kpis.incidentCount} incidents</span>
        </span>
      </div>

      <div className="kpi-cell">
        <span className="kpi-label">Compliance rate</span>
        <span className="kpi-value">{kpis.complianceRate}<span className="kpi-unit">%</span></span>
        <span className="kpi-foot">
          <span className="num">{kpis.peopleCompliant} of {kpis.peopleObserved} people observed</span>
        </span>
      </div>
    </section>
  );
}

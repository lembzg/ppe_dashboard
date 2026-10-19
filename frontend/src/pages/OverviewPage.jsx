import Kpis from '../components/Kpis.jsx';
import TrendChart from '../components/TrendChart.jsx';
import { useDashboard } from '../components/DashboardContext.js';
import {
  ActionLink, Bar, EmptyRow, IncidentRow, NumericCell, Panel, ScoreCell, Severity, ShiftName, Table,
} from '../components/ui.jsx';

function TypeList({ types }) {
  const total = types.reduce((sum, type) => sum + type.count, 0);
  return (
    <ul className="type-list">
      {types.map((type) => {
        const severityClass = type.severity === 'Critical' || type.severity === 'High' ? 'severity-' + type.severity.toLowerCase() : '';
        return (
          <li key={type.name} className="type-row">
            <span className="type-name">{type.name}</span>
            <Bar share={total ? type.count / total : 0} className={severityClass} />
            <span className="type-count mono">{type.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

const SCORE_COLUMNS = (label) => [{ label }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true }];

function Ranking({ ranking, currentSiteId }) {
  return (
    <>
      <ol className="rank-list">
        {ranking.rows.map((row, index) => {
          const isCurrent = row.id === currentSiteId;
          return (
            <li key={row.id} className={'rank-row' + (isCurrent ? ' is-current' : '')} aria-current={isCurrent ? 'true' : undefined}>
              <span className="rank-number mono">{index + 1}</span>
              <span className="rank-name">{row.name}</span>
              <Bar share={row.score / 100} />
              <span className="rank-score mono">{row.score}</span>
            </li>
          );
        })}
      </ol>
      <div className="rank-stats"><span>Company average<span className="mono">{ranking.average}</span></span></div>
    </>
  );
}

export default function OverviewPage({ model }) {
  const { data } = useDashboard();
  const site = data.sites.find((item) => item.id === data.currentSiteId);
  return (
    <div className="sheet">
      <Kpis kpis={model.kpis} />
      <div className="row row-2-1">
        <Panel title="Safety score" meta={model.trend.periodLabel}>
          <div className="trend-key">
            <span className="trend-key-item"><span className="key-line" />{site.name}</span>
            <span className="trend-key-item"><span className="key-line key-line-dashed" />Previous period</span>
          </div>
          <TrendChart trend={model.trend} />
        </Panel>
        <Panel title="Incidents by type">
          <div><TypeList types={model.types} /></div>
        </Panel>
      </div>
      <div className="row row-1-1">
        <Panel title="Shifts" action={<ActionLink label="View shifts" route="shifts" />}>
          <Table widths={[null, '120px', '88px']} columns={SCORE_COLUMNS('Shift')}>
            {model.shifts.map((shift) => (
              <tr key={shift.name}>
                <td><ShiftName shift={shift} /></td>
                <td><ScoreCell score={shift.score} /></td>
                <NumericCell value={shift.count} />
              </tr>
            ))}
          </Table>
        </Panel>
        <Panel title="Zones" action={<ActionLink label="View zones" route="zones" />}>
          <Table widths={[null, '120px', '88px']} columns={SCORE_COLUMNS('Zone')}>
            {model.zones.map((zone) => (
              <tr key={zone.name}>
                <td>{zone.name}</td>
                <td><ScoreCell score={zone.score} /></td>
                <NumericCell value={zone.count} />
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
      <div className="row row-2-1">
        <Panel title="Recent incidents" meta="Today" action={<ActionLink label="View all incidents" route="incidents" />}>
          <Table
            widths={['72px', null, '112px', null]}
            columns={[{ label: 'Time' }, { label: 'Violation' }, { label: 'Severity' }, { label: 'Zone' }]}
          >
            {model.recent.length ? model.recent.map((incident) => (
              <IncidentRow key={incident.id} incident={incident}>
                <td className="mono">{incident.time}</td>
                <td>{incident.type}</td>
                <td><Severity severity={incident.severity} /></td>
                <td>{incident.zone}</td>
              </IncidentRow>
            )) : <EmptyRow columnCount={4} />}
          </Table>
        </Panel>
        <Panel title="Site ranking" action={<ActionLink label="Compare sites" route="reports" />}>
          <Ranking ranking={model.ranking} currentSiteId={data.currentSiteId} />
        </Panel>
      </div>
    </div>
  );
}

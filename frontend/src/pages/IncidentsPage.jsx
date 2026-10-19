import { useRef } from 'react';
import { useDashboard } from '../components/DashboardContext.js';
import { PlayIcon } from '../components/icons.jsx';
import { EmptyRow, IncidentRow, Panel, Severity, Table, incidentWhen } from '../components/ui.jsx';
import { formatPoints } from '../lib/format.js';

export const NO_FILTERS = { severity: 'all', zone: 'all', type: 'all' };

const COLUMNS = [
  { label: 'Time' }, { label: 'Event ID' }, { label: 'Violation' }, { label: 'Severity' }, { label: 'Zone' },
  { label: 'Camera' }, { label: 'Shift' }, { label: 'Points', numeric: true }, { label: 'Clip', numeric: true },
];

function FilterSelect({ value, allLabel, options, onChange }) {
  return (
    <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="all">{allLabel}</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

export default function IncidentsPage({ model, filters, setFilters }) {
  const { data, derivations } = useDashboard();
  const allSeverityRef = useRef(null);
  const setFilter = (key, value) => setFilters({ ...filters, [key]: value });

  const incidents = model.periodIncidents.filter((incident) =>
    (filters.severity === 'all' || incident.severity === filters.severity) &&
    (filters.zone === 'all' || incident.zone === filters.zone) &&
    (filters.type === 'all' || incident.type === filters.type));
  const countLabel = incidents.length === model.periodIncidents.length
    ? String(incidents.length)
    : incidents.length + ' of ' + model.periodIncidents.length;
  const isFiltered = filters.severity !== 'all' || filters.zone !== 'all' || filters.type !== 'all';
  const showDate = model.window.dates.length > 1;

  return (
    <div className="sheet">
      <Panel title="Incidents" action={<span className="panel-count mono">{countLabel}</span>}>
        <div className="filter-bar">
          <div className="filter">
            <span className="filter-label" id="severity-filter-label">Severity</span>
            <div className="segmented" role="group" aria-labelledby="severity-filter-label">
              {['all', ...Object.keys(data.severities)].map((severity, index) => (
                <button
                  key={severity}
                  type="button"
                  aria-pressed={filters.severity === severity}
                  ref={index === 0 ? allSeverityRef : undefined}
                  onClick={() => setFilter('severity', severity)}
                >
                  {severity === 'all' ? 'All' : severity}
                </button>
              ))}
            </div>
          </div>
          <label className="filter">
            <span className="filter-label">Zone</span>
            <FilterSelect value={filters.zone} allLabel="All zones" options={data.zones.map((zone) => zone.name)} onChange={(value) => setFilter('zone', value)} />
          </label>
          <label className="filter">
            <span className="filter-label">Violation</span>
            <FilterSelect value={filters.type} allLabel="All violations" options={data.violationTypes.map((type) => type.name)} onChange={(value) => setFilter('type', value)} />
          </label>
          {isFiltered && (
            <button
              type="button"
              className="link link-button"
              onClick={() => {
                setFilters(NO_FILTERS);
                allSeverityRef.current.focus();
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <Table widths={[showDate ? '152px' : '72px', '156px', null, '96px', null, '76px', '64px', '60px', '48px']} columns={COLUMNS}>
          {incidents.length ? incidents.map((incident) => (
            <IncidentRow key={incident.id} incident={incident}>
              <td className="mono">{incidentWhen(incident, showDate)}</td>
              <td className="mono">{incident.id}</td>
              <td>{incident.type}</td>
              <td><Severity severity={incident.severity} /></td>
              <td>{incident.zone}</td>
              <td className="mono">{incident.camera}</td>
              <td>{incident.shift}</td>
              <td className="is-numeric mono points">{formatPoints(derivations.deductionOf(incident))}</td>
              <td className="is-numeric">{incident.clip && <button type="button" className="clip-button" tabIndex={-1} aria-label="Play clip"><PlayIcon /></button>}</td>
            </IncidentRow>
          )) : <EmptyRow columnCount={COLUMNS.length} />}
        </Table>
      </Panel>
    </div>
  );
}

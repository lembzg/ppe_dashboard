/* Small building blocks shared by every page. */
import { formatDay } from '../lib/dates.js';
import { useDashboard } from './DashboardContext.js';

export function Severity({ severity }) {
  return (
    <span className={'severity severity-' + severity.toLowerCase()}>
      <span className="severity-mark" />{severity}
    </span>
  );
}

export function Bar({ share, className }) {
  const width = Math.max(0, Math.min(100, share * 100)).toFixed(1);
  return (
    <span className="bar-track">
      <span className={'bar-fill ' + (className || '')} style={{ width: width + '%' }} />
    </span>
  );
}

export function ScoreCell({ score }) {
  return <div className="cell-score"><Bar share={score / 100} /><span className="mono">{score}</span></div>;
}

export function Leading({ leading }) {
  return leading ? leading.name : <span className="text-3">None</span>;
}

export function Panel({ title, meta, action, className, children }) {
  return (
    <section className={'panel' + (className ? ' ' + className : '')} aria-label={title}>
      <div className="panel-header">
        <h2 className="panel-title">{title}</h2>
        {meta != null && <span className="panel-meta">{meta}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

export function ActionLink({ label, route }) {
  return <a className="link panel-action" href={'#/' + route}>{label}</a>;
}

export function Table({ className, widths, columns, children, foot }) {
  return (
    <table className={'table' + (className ? ' ' + className : '')}>
      <colgroup>
        {widths.map((width, index) => <col key={index} style={width ? { width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>
          {columns.map((column, index) => (
            <th key={index} className={column.numeric ? 'is-numeric' : undefined}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
      {foot && <tfoot>{foot}</tfoot>}
    </table>
  );
}

export function EmptyRow({ columnCount }) {
  return <tr><td colSpan={columnCount} className="text-3">None</td></tr>;
}

export function NumericCell({ value, className }) {
  return <td className={'is-numeric mono' + (className ? ' ' + className : '')}>{value}</td>;
}

export function ShiftName({ shift }) {
  return (
    <div className="cell-flex">
      <span className="truncate">{shift.name}</span>
      {shift.inProgress && <span className="tag">In progress</span>}
    </div>
  );
}

export function incidentWhen(incident, showDate) {
  return showDate ? formatDay(incident.date) + ' ' + incident.time : incident.time;
}

// A table row that opens the incident drawer on click, Enter or Space.
export function IncidentRow({ incident, children }) {
  const { selectedIncidentId, openDrawer } = useDashboard();
  return (
    <tr
      className={'is-clickable' + (incident.id === selectedIncidentId ? ' is-selected' : '')}
      tabIndex={0}
      data-incident-id={incident.id}
      onClick={() => openDrawer(incident.id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDrawer(incident.id);
      }}
    >
      {children}
    </tr>
  );
}

// A count table of violation types against shifts or zones.
export function Matrix({ columnLabels, cellCount }) {
  const { data } = useDashboard();
  const totals = columnLabels.map((label) => data.violationTypes.reduce((sum, type) => sum + cellCount(type.name, label), 0));
  return (
    <Table
      className="table-matrix"
      widths={['140px', ...columnLabels.map(() => null)]}
      columns={[{ label: 'Violation' }, ...columnLabels.map((label) => ({ label, numeric: true }))]}
      foot={<tr><td>Total</td>{totals.map((total, index) => <NumericCell key={index} value={total} />)}</tr>}
    >
      {data.violationTypes.map((type) => (
        <tr key={type.name}>
          <td>{type.name}</td>
          {columnLabels.map((label) => {
            const count = cellCount(type.name, label);
            return <NumericCell key={label} value={count} className={count ? '' : 'text-3'} />;
          })}
        </tr>
      ))}
    </Table>
  );
}

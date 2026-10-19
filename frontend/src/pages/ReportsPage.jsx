import { useDashboard } from '../components/DashboardContext.js';
import { NumericCell, Panel, Table } from '../components/ui.jsx';
import { formatDay } from '../lib/dates.js';
import { PERIOD_NAMES } from '../lib/format.js';

const PERIODS = Object.keys(PERIOD_NAMES);

function ScoreCells({ scores }) {
  return PERIODS.map((period) => <NumericCell key={period} value={scores[period]} />);
}

export default function ReportsPage({ model }) {
  const { data } = useDashboard();
  const comparison = model.siteComparison;
  return (
    <div className="sheet">
      <Panel title="Site comparison" meta="Safety score">
        <Table
          className="table-ranked"
          widths={['64px', null, '120px', '120px', '120px']}
          columns={[{ label: 'Rank' }, { label: 'Site' }, ...PERIODS.map((period) => ({ label: PERIOD_NAMES[period], numeric: true }))]}
          foot={(
            <>
              <tr><td /><td>Company average</td><ScoreCells scores={comparison.average} /></tr>
              <tr><td /><td>Median</td><ScoreCells scores={comparison.median} /></tr>
            </>
          )}
        >
          {comparison.rows.map((row, index) => {
            const isCurrent = row.id === data.currentSiteId;
            return (
              <tr key={row.id} className={isCurrent ? 'is-current' : undefined} aria-current={isCurrent ? 'true' : undefined}>
                <td className="mono text-3">{index + 1}</td>
                <td>{row.name}</td>
                <ScoreCells scores={row.scores} />
              </tr>
            );
          })}
        </Table>
      </Panel>
      <div className="row row-2-1">
        <Panel title="Scheduled reports">
          <Table
            widths={[null, '176px', null, '140px', '96px']}
            columns={[{ label: 'Report' }, { label: 'Frequency' }, { label: 'Recipients' }, { label: 'Last sent' }, { label: 'File', numeric: true }]}
          >
            {data.scheduledReports.map((report) => {
              const [dateKey, time] = report.lastSent.split(' ');
              return (
                <tr key={report.name}>
                  <td>{report.name}</td>
                  <td className="text-2">{report.frequency}</td>
                  <td className="text-2">{report.recipients}</td>
                  <td className="mono">{formatDay(dateKey) + ' ' + time}</td>
                  <td className="is-numeric"><a className="link" href="#" onClick={(event) => event.preventDefault()}>Download</a></td>
                </tr>
              );
            })}
          </Table>
        </Panel>
        <Panel title="Dashboard benchmark">
          <div className="panel-note">Available once enough sites contribute data</div>
        </Panel>
      </div>
    </div>
  );
}

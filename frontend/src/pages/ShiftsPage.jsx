import { useDashboard } from '../components/DashboardContext.js';
import { Leading, Matrix, NumericCell, Panel, ScoreCell, ShiftName, Table } from '../components/ui.jsx';
import { formatDay } from '../lib/dates.js';
import { shiftContains } from '../lib/model.js';

export default function ShiftsPage({ model }) {
  const { data, derivations } = useDashboard();
  return (
    <div className="sheet">
      <Panel title="Shift performance">
        <Table
          widths={['160px', '140px', '120px', '96px', '96px', null]}
          columns={[{ label: 'Shift' }, { label: 'Hours' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true },
            { label: 'High risk', numeric: true }, { label: 'Leading violation' }]}
        >
          {model.shifts.map((shift) => (
            <tr key={shift.name}>
              <td><ShiftName shift={shift} /></td>
              <td className="mono">{shift.hours}</td>
              <td><ScoreCell score={shift.score} /></td>
              <NumericCell value={shift.count} />
              <NumericCell value={shift.highRisk} />
              <td><Leading leading={shift.leading} /></td>
            </tr>
          ))}
        </Table>
      </Panel>
      <div className="row row-1-1">
        <Panel title="Violations by shift">
          <Matrix
            columnLabels={data.shifts.map((shift) => shift.name)}
            cellCount={(typeName, shiftName) => {
              const shift = data.shifts.find((candidate) => candidate.name === shiftName);
              return model.incidents.filter((incident) => incident.type === typeName && shiftContains(shift, incident.time)).length;
            }}
          />
        </Panel>
        <Panel title="Daily score by shift">
          <div className="table-scroll">
            <Table
              widths={['128px', null, null, null, null]}
              columns={[{ label: 'Day' }, ...data.shifts.map((shift) => ({ label: shift.name, numeric: true })), { label: 'Site', numeric: true }]}
            >
              {model.window.dates.slice().reverse().map((dateKey) => (
                <tr key={dateKey}>
                  <td className="mono">{formatDay(dateKey)}</td>
                  {data.shifts.map((shift) => (
                    <NumericCell key={shift.name} value={derivations.dayScore(dateKey, (incident) => shiftContains(shift, incident.time))} />
                  ))}
                  <NumericCell value={derivations.dayScore(dateKey)} />
                </tr>
              ))}
            </Table>
          </div>
        </Panel>
      </div>
    </div>
  );
}

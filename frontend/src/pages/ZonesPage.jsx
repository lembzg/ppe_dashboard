import { useDashboard } from '../components/DashboardContext.js';
import { Leading, Matrix, NumericCell, Panel, ScoreCell, Table, incidentWhen } from '../components/ui.jsx';

export default function ZonesPage({ model }) {
  const { data } = useDashboard();
  const showDate = model.window.dates.length > 1;
  return (
    <div className="sheet">
      <Panel title="Zone performance">
        <Table
          widths={['180px', '120px', '96px', '96px', null, '160px']}
          columns={[{ label: 'Zone' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true },
            { label: 'High risk', numeric: true }, { label: 'Leading violation' }, { label: 'Cameras' }]}
        >
          {model.zones.map((zone) => (
            <tr key={zone.name}>
              <td>{zone.name}</td>
              <td><ScoreCell score={zone.score} /></td>
              <NumericCell value={zone.count} />
              <NumericCell value={zone.highRisk} />
              <td><Leading leading={zone.leading} /></td>
              <td className="mono text-2">{zone.cameras.join(' ')}</td>
            </tr>
          ))}
        </Table>
      </Panel>
      <div className="row row-1-1">
        <Panel title="Violations by zone">
          <Matrix
            columnLabels={data.zones.map((zone) => zone.name)}
            cellCount={(typeName, zoneName) =>
              model.incidents.filter((incident) => incident.type === typeName && incident.zone === zoneName).length}
          />
        </Panel>
        <Panel title="Cameras">
          <Table
            widths={['88px', null, '96px', '88px', showDate ? '140px' : '96px']}
            columns={[{ label: 'Camera' }, { label: 'Zone' }, { label: 'Status' }, { label: 'Incidents', numeric: true }, { label: 'Last event' }]}
          >
            {model.cameras.map((camera) => (
              <tr key={camera.id}>
                <td className="mono">{camera.id}</td>
                <td>{camera.zone || <span className="text-3">Unassigned</span>}</td>
                <td className="text-2">{camera.online ? 'Online' : 'Offline'}</td>
                <NumericCell value={camera.count} />
                <td className="mono">{camera.lastIncident ? incidentWhen(camera.lastIncident, showDate) : <span className="text-3">None</span>}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
    </div>
  );
}

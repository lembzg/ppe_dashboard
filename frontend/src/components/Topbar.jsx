import { formatDay } from '../lib/dates.js';
import { PERIOD_NAMES } from '../lib/format.js';
import Scope from './Scope.jsx';

export default function Topbar({ data, live, period, setPeriod, showPeriod, openMenu, setOpenMenu }) {
  return (
    <header className="topbar">
      <Scope data={data} openMenu={openMenu} setOpenMenu={setOpenMenu} />
      <div className="topbar-spacer" />
      <span className="topbar-date mono">{formatDay(data.clock.date, { year: true })}</span>
      <div className="segmented" role="group" aria-label="Period" hidden={!showPeriod}>
        {Object.keys(PERIOD_NAMES).map((key) => (
          <button key={key} type="button" aria-pressed={key === period} onClick={() => setPeriod(key)}>
            {PERIOD_NAMES[key]}
          </button>
        ))}
      </div>
      <div className="live">
        <span className="live-state"><span className="live-dot" aria-hidden="true" />Live</span>
        <span className="live-meta mono">{live.camerasOnline} of {live.cameraCount} cameras online</span>
        <span className="live-meta mono">Last event {live.lastEventTime || 'None'}</span>
      </div>
      <button type="button" className="button">Export</button>
    </header>
  );
}

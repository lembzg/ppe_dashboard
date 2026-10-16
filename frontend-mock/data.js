/*
 * NODE home page mock data.
 *
 * Everything the page shows is derived in app.js from the records below.
 * History before today is generated with a seeded random function so the
 * page is identical on every reload. Days listed in historyPlan.anchoredDays
 * are solved so their incident mix lands exactly on the recorded score.
 */
(function (root) {
  'use strict';

  const severities = {
    Critical: { rank: 4, deduction: 15 },
    High: { rank: 3, deduction: 8 },
    Medium: { rank: 2, deduction: 4 },
    Low: { rank: 1, deduction: 2 },
  };

  // isPpe marks the violation types that count against compliance rate.
  const violationTypes = [
    { name: 'Person near forklift', severity: 'Critical', isPpe: false },
    { name: 'Outside walkway', severity: 'High', isPpe: false },
    { name: 'No high-vis', severity: 'Medium', isPpe: true },
    { name: 'No hard hat', severity: 'Medium', isPpe: true },
    { name: 'Dock door open', severity: 'Low', isPpe: false },
  ];

  const shifts = [
    { name: 'Night', start: '22:00', end: '06:00' },
    { name: 'Early', start: '06:00', end: '14:00' },
    { name: 'Late', start: '14:00', end: '22:00' },
  ];

  const zones = [
    { name: 'Goods In', cameras: ['CAM-01', 'CAM-03'] },
    { name: 'Loading Dock', cameras: ['CAM-07', 'CAM-08'] },
    { name: 'Racking Aisle B', cameras: ['CAM-11', 'CAM-12'] },
    { name: 'Goods Out', cameras: ['CAM-05', 'CAM-06'] },
    { name: 'Despatch', cameras: ['CAM-14', 'CAM-15'] },
  ];

  const cameras = [
    'CAM-01', 'CAM-02', 'CAM-03', 'CAM-04', 'CAM-05', 'CAM-06',
    'CAM-07', 'CAM-08', 'CAM-11', 'CAM-12', 'CAM-14', 'CAM-15',
  ].map((id) => ({ id, online: true }));

  const organisations = [{ id: 'northline', name: 'Northline Logistics' }];

  // Trafford Park scores are derived from its incidents. The other sites
  // only report period scores to this page.
  const sites = [
    { id: 'widnes', name: 'Widnes', scores: { today: 91, week: 89, month: 88 } },
    { id: 'warrington', name: 'Warrington', scores: { today: 84, week: 82, month: 83 } },
    { id: 'salford-quays', name: 'Salford Quays', scores: { today: 77, week: 79, month: 78 } },
    { id: 'trafford-park', name: 'Trafford Park', scores: null },
    { id: 'stockport', name: 'Stockport', scores: { today: 58, week: 64, month: 67 } },
  ];

  const scheduledReports = [
    { name: 'Daily safety summary', frequency: 'Every day 06:00', recipients: 'Site managers', lastSent: '2026-10-22 06:00' },
    { name: 'Weekly safety summary', frequency: 'Mondays 07:00', recipients: 'Site and safety managers', lastSent: '2026-10-19 07:00' },
    { name: 'Monthly safety review', frequency: '1st of the month 07:00', recipients: 'Operations leadership', lastSent: '2026-10-01 07:00' },
  ];

  const currentUser = { name: 'Site manager 1', role: null };

  const clock = { date: '2026-10-22', time: '15:40' };

  const today = {
    date: '2026-10-22',
    peopleObserved: 214,
    incidents: [
      { id: 'EVT-20261022-0001', time: '02:14', type: 'No high-vis', severity: 'Medium', zone: 'Goods In', camera: 'CAM-03' },
      { id: 'EVT-20261022-0002', time: '06:52', type: 'Dock door open', severity: 'Low', zone: 'Loading Dock', camera: 'CAM-07' },
      { id: 'EVT-20261022-0003', time: '09:31', type: 'No hard hat', severity: 'Medium', zone: 'Racking Aisle B', camera: 'CAM-11' },
      { id: 'EVT-20261022-0004', time: '11:08', type: 'Person near forklift', severity: 'Critical', zone: 'Racking Aisle B', camera: 'CAM-12' },
      { id: 'EVT-20261022-0005', time: '13:47', type: 'No high-vis', severity: 'Medium', zone: 'Goods Out', camera: 'CAM-05' },
      { id: 'EVT-20261022-0006', time: '15:22', type: 'Outside walkway', severity: 'High', zone: 'Goods Out', camera: 'CAM-05' },
    ],
  };

  // Appended by app.js 20 seconds after load, while the Today view is open.
  const liveEvent = {
    delayMs: 20000,
    clockTimeAfter: '15:41',
    incident: { id: 'EVT-20261022-0007', time: '15:41', type: 'No hard hat', severity: 'Medium', zone: 'Despatch', camera: 'CAM-14' },
  };

  const historyPlan = {
    seed: 2677,
    firstDate: '2026-09-01',
    lastDate: '2026-10-21',
    // Recorded daily scores. count and highRisk steer the solved mix.
    anchoredDays: {
      '2026-10-16': { score: 82, count: 5, highRisk: 1, ppe: 1 },
      '2026-10-17': { score: 79, count: 4, highRisk: 1, ppe: 0 },
      '2026-10-18': { score: 85, count: 1, highRisk: 1, ppe: 0 },
      '2026-10-19': { score: 71, count: 4, highRisk: 2, ppe: 1 },
      '2026-10-20': { score: 76, count: 4, highRisk: 2, ppe: 2 },
      '2026-10-21': { score: 74, count: 7, highRisk: 0, ppe: 6 },
    },
    // Remaining days are drawn around these means.
    segments: [
      { from: '2026-09-01', to: '2026-09-30', meanScore: 79.5, meanCount: 5.2, meanHighRisk: 1.1, meanPpe: 2.4, criticalShare: 0.2 },
      { from: '2026-10-01', to: '2026-10-11', meanScore: 77, meanCount: 6.3, meanHighRisk: 2.3, meanPpe: 3.6, criticalShare: 0 },
      { from: '2026-10-12', to: '2026-10-15', meanScore: 78.5, meanCount: 6.3, meanHighRisk: 2.3, meanPpe: 3.6, criticalShare: 0 },
    ],
    peopleObserved: { weekday: 160, weekend: 88, spread: 18 },
  };

  /* Seeded generation ------------------------------------------------ */

  function createSeededRandom(seed) {
    let state = seed >>> 0;
    return function nextRandom() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function parseDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function formatDateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function eachDateKey(firstDate, lastDate) {
    const keys = [];
    for (let date = parseDate(firstDate); date <= parseDate(lastDate); date.setUTCDate(date.getUTCDate() + 1)) {
      keys.push(formatDateKey(date));
    }
    return keys;
  }

  // Finds counts of Critical, High, Medium and Low incidents whose
  // deductions add up to the target, staying close to the requested mix.
  function solveSeverityMix(target) {
    const { deduction, count, highRisk, ppe, critical } = target;
    let best = null;
    for (let total = Math.max(0, count - 3); total <= count + 3; total++) {
      for (let criticalCount = 0; criticalCount <= total; criticalCount++) {
        for (let highCount = 0; highCount <= total - criticalCount; highCount++) {
          for (let mediumCount = 0; mediumCount <= total - criticalCount - highCount; mediumCount++) {
            const lowCount = total - criticalCount - highCount - mediumCount;
            const mixDeduction = criticalCount * 15 + highCount * 8 + mediumCount * 4 + lowCount * 2;
            const cost =
              Math.abs(mixDeduction - deduction) * 12 +
              Math.abs(total - count) * 3 +
              Math.abs(criticalCount + highCount - highRisk) * 3 +
              Math.abs(mediumCount - ppe) +
              Math.abs(criticalCount - critical);
            if (!best || cost < best.cost) {
              best = { cost, Critical: criticalCount, High: highCount, Medium: mediumCount, Low: lowCount };
            }
          }
        }
      }
    }
    return best;
  }

  const typeBySeverity = {
    Critical: ['Person near forklift'],
    High: ['Outside walkway'],
    Medium: ['No high-vis', 'No high-vis', 'No hard hat'],
    Low: ['Dock door open'],
  };
  const zonesForType = {
    'Dock door open': ['Loading Dock', 'Goods In', 'Despatch'],
  };

  function pick(list, nextRandom) {
    return list[Math.floor(nextRandom() * list.length)];
  }

  function formatMinutes(totalMinutes) {
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    return hours + ':' + minutes;
  }

  function buildIncidents(dateKey, mix, nextRandom) {
    const severityList = [];
    ['Critical', 'High', 'Medium', 'Low'].forEach((severity) => {
      for (let i = 0; i < mix[severity]; i++) severityList.push(severity);
    });
    // Shuffle so severities are spread through the day.
    for (let i = severityList.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [severityList[i], severityList[j]] = [severityList[j], severityList[i]];
    }
    const minutes = severityList
      .map(() => 20 + Math.floor(nextRandom() * 1400))
      .sort((a, b) => a - b);
    const compactDate = dateKey.replace(/-/g, '');
    return severityList.map((severity, index) => {
      const type = pick(typeBySeverity[severity], nextRandom);
      const zoneName = pick(zonesForType[type] || zones.map((zone) => zone.name), nextRandom);
      const zone = zones.find((candidate) => candidate.name === zoneName);
      return {
        id: 'EVT-' + compactDate + '-' + String(index + 1).padStart(4, '0'),
        time: formatMinutes(minutes[index]),
        type,
        severity,
        zone: zoneName,
        camera: pick(zone.cameras, nextRandom),
      };
    });
  }

  function jitter(nextRandom, spread) {
    return (nextRandom() + nextRandom() - 1) * spread;
  }

  function generateHistory(plan) {
    const nextRandom = createSeededRandom(plan.seed);
    return eachDateKey(plan.firstDate, plan.lastDate).map((dateKey) => {
      const anchor = plan.anchoredDays[dateKey];
      let target;
      if (anchor) {
        target = {
          deduction: 100 - anchor.score,
          count: anchor.count,
          highRisk: anchor.highRisk,
          ppe: anchor.ppe,
          critical: anchor.highRisk > 0 ? 1 : 0,
        };
      } else {
        const segment = plan.segments.find((candidate) => dateKey >= candidate.from && dateKey <= candidate.to);
        const highRisk = Math.max(0, Math.round(segment.meanHighRisk + jitter(nextRandom, 1.2)));
        target = {
          deduction: Math.max(0, Math.round(100 - segment.meanScore + jitter(nextRandom, 10))),
          count: Math.max(1, Math.round(segment.meanCount + jitter(nextRandom, 2.5))),
          highRisk,
          ppe: Math.max(0, Math.round(segment.meanPpe + jitter(nextRandom, 1.5))),
          critical: nextRandom() < segment.criticalShare * highRisk ? 1 : 0,
        };
      }
      const mix = solveSeverityMix(target);
      const weekday = parseDate(dateKey).getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;
      const people = plan.peopleObserved;
      const peopleObserved = Math.round((isWeekend ? people.weekend : people.weekday) + jitter(nextRandom, people.spread));
      return { date: dateKey, peopleObserved, incidents: buildIncidents(dateKey, mix, nextRandom) };
    });
  }

  const dailyRecords = generateHistory(historyPlan).concat([today]);

  root.NODE_DATA = {
    severities,
    violationTypes,
    shifts,
    zones,
    cameras,
    organisations,
    sites,
    currentSiteId: 'trafford-park',
    currentUser,
    scheduledReports,
    clock,
    liveEvent,
    dailyRecords,
  };
})(typeof window !== 'undefined' ? window : globalThis);

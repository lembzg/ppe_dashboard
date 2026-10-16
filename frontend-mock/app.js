/*
 * NODE front end mock. Every figure is derived from window.NODE_DATA.
 * Derivation functions come first, then one render function per panel,
 * then one render function per page, selected by the URL hash.
 */
(function () {
  'use strict';

  const data = window.NODE_DATA;
  const MINUS = '−';
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const ICONS = {
    caret: '<svg class="icon icon-small" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>',
    check: '<svg class="icon icon-small" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6"/></svg>',
    play: '<svg class="icon icon-small icon-fill" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2v8l6.5-4Z"/></svg>',
    playLarge: '<svg class="icon icon-fill" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l8.5-5Z"/></svg>',
    close: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  const state = {
    period: 'today',
    clockTime: data.clock.time,
    organisationId: data.organisations[0].id,
    siteId: data.currentSiteId,
    zoneName: null, // null means All zones
    openMenu: null,
    drawerIncidentId: null,
    drawerReturnFocus: null,
    freshIncidentId: null,
    liveEventDue: false,
    liveEventDelivered: false,
    incidentFilters: { severity: 'all', zone: 'all', type: 'all' },
  };

  const RECENT_INCIDENT_LIMIT = 5;

  const recordsByDate = new Map(data.dailyRecords.map((record) => [record.date, record]));
  const violationTypeByName = new Map(data.violationTypes.map((type) => [type.name, type]));

  /* Formatting --------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatSigned(value) {
    if (value > 0) return '+' + value;
    if (value < 0) return MINUS + Math.abs(value);
    return '0';
  }

  // higherIsBetter decides whether a rise is shown as positive or negative.
  function deltaClass(value, higherIsBetter) {
    if (value === 0) return 'delta-neutral';
    return (value > 0) === higherIsBetter ? 'delta-positive' : 'delta-negative';
  }

  function formatPoints(deduction) {
    return MINUS + deduction;
  }

  function initialsOf(name) {
    // "Site manager 1" becomes "S1", "Tom Noble" becomes "TN".
    const parts = name.split(/\s+/);
    const last = parts[parts.length - 1];
    return (parts[0][0] + (/^\d+$/.test(last) ? last : parts.length > 1 ? last[0] : '')).slice(0, 2).toUpperCase();
  }

  /* Dates and times ---------------------------------------------------- */

  function parseDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function toDateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(dateKey, days) {
    const date = parseDate(dateKey);
    date.setUTCDate(date.getUTCDate() + days);
    return toDateKey(date);
  }

  function datesBetween(firstDate, lastDate) {
    const dates = [];
    for (let dateKey = firstDate; dateKey <= lastDate; dateKey = addDays(dateKey, 1)) dates.push(dateKey);
    return dates;
  }

  function daysInMonthOf(dateKey) {
    const date = parseDate(dateKey);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  }

  function formatDay(dateKey, options) {
    const settings = Object.assign({ weekday: true, month: true, year: false }, options);
    const date = parseDate(dateKey);
    const parts = [];
    if (settings.weekday) parts.push(WEEKDAY_NAMES[date.getUTCDay()]);
    parts.push(String(date.getUTCDate()));
    if (settings.month) parts.push(MONTH_NAMES[date.getUTCMonth()]);
    if (settings.year) parts.push(String(date.getUTCFullYear()));
    return parts.join(' ');
  }

  function toMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  function formatMinutes(totalMinutes) {
    return String(Math.floor(totalMinutes / 60)).padStart(2, '0') + ':' + String(totalMinutes % 60).padStart(2, '0');
  }

  /* Derivation --------------------------------------------------------- */

  function deductionOf(incident) {
    return data.severities[incident.severity].deduction;
  }

  function severityRankOfType(typeName) {
    return data.severities[violationTypeByName.get(typeName).severity].rank;
  }

  function isHighRisk(incident) {
    return incident.severity === 'Critical' || incident.severity === 'High';
  }

  function isPpeViolation(incident) {
    return violationTypeByName.get(incident.type).isPpe;
  }

  function scoreFor(incidents) {
    return Math.max(0, 100 - incidents.reduce((total, incident) => total + deductionOf(incident), 0));
  }

  function mean(values) {
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function byTime(a, b) {
    return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  }

  function incidentsOn(dateKey) {
    const record = recordsByDate.get(dateKey);
    if (!record) return [];
    return record.incidents.map((incident) => Object.assign({ date: dateKey }, incident)).sort(byTime);
  }

  function dayScore(dateKey, filter) {
    const incidents = incidentsOn(dateKey);
    return scoreFor(filter ? incidents.filter(filter) : incidents);
  }

  // Groups incidents by type, ranked by highest count, then higher default
  // severity, then most recent.
  function rankViolationTypes(incidents) {
    const groups = new Map();
    incidents.forEach((incident) => {
      const stamp = incident.date + 'T' + incident.time;
      const group = groups.get(incident.type) || { name: incident.type, count: 0, latest: '' };
      group.count += 1;
      if (stamp > group.latest) group.latest = stamp;
      groups.set(incident.type, group);
    });
    const ranked = Array.from(groups.values()).sort((a, b) =>
      b.count - a.count ||
      severityRankOfType(b.name) - severityRankOfType(a.name) ||
      (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
    return ranked;
  }

  function leadingViolation(incidents) {
    return rankViolationTypes(incidents)[0] || null;
  }

  function shiftContains(shift, time) {
    const minute = toMinutes(time);
    const start = toMinutes(shift.start);
    const end = toMinutes(shift.end);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  function shiftOf(time) {
    return data.shifts.find((shift) => shiftContains(shift, time));
  }

  function periodWindow(period) {
    const today = data.clock.date;
    if (period === 'week') {
      const daysSinceMonday = (parseDate(today).getUTCDay() + 6) % 7;
      const monday = addDays(today, -daysSinceMonday);
      return {
        dates: datesBetween(monday, today),
        previousDates: datesBetween(addDays(monday, -7), addDays(today, -7)),
        deltaLabel: 'vs same point last week',
      };
    }
    if (period === 'month') {
      const firstOfMonth = today.slice(0, 8) + '01';
      const firstOfPreviousMonth = toDateKey(new Date(Date.UTC(parseDate(today).getUTCFullYear(), parseDate(today).getUTCMonth() - 1, 1)));
      const samePointDay = Math.min(parseDate(today).getUTCDate(), daysInMonthOf(firstOfPreviousMonth));
      return {
        dates: datesBetween(firstOfMonth, today),
        previousDates: datesBetween(firstOfPreviousMonth, addDays(firstOfPreviousMonth, samePointDay - 1)),
        deltaLabel: 'vs same point last month',
      };
    }
    return { dates: [today], previousDates: [addDays(today, -1)], deltaLabel: 'vs yesterday' };
  }

  function periodScore(dates, filter) {
    return Math.round(mean(dates.map((dateKey) => dayScore(dateKey, filter))));
  }

  function summarise(incidents) {
    return {
      count: incidents.length,
      highRisk: incidents.filter(isHighRisk).length,
      leading: leadingViolation(incidents),
    };
  }

  function deriveKpis(window, incidents) {
    const score = periodScore(window.dates);
    const previousScore = periodScore(window.previousDates);
    const previousCount = window.previousDates.flatMap(incidentsOn).length;
    const peopleObserved = window.dates.reduce((total, dateKey) => total + recordsByDate.get(dateKey).peopleObserved, 0);
    const peopleCompliant = peopleObserved - incidents.filter(isPpeViolation).length;
    const sparkDates = datesBetween(addDays(data.clock.date, -6), data.clock.date);
    return {
      score,
      scoreDelta: score - previousScore,
      deltaLabel: window.deltaLabel,
      sparkline: sparkDates.map((dateKey) => dayScore(dateKey)),
      incidentCount: incidents.length,
      incidentDelta: incidents.length - previousCount,
      criticalCount: incidents.filter((incident) => incident.severity === 'Critical').length,
      highCount: incidents.filter((incident) => incident.severity === 'High').length,
      leading: leadingViolation(incidents),
      peopleObserved,
      peopleCompliant,
      complianceRate: ((peopleCompliant / peopleObserved) * 100).toFixed(1),
    };
  }

  // Types with incidents in the leading violation order, then the rest by severity.
  function deriveTypes(incidents) {
    const ranked = rankViolationTypes(incidents).map((group) => group.name);
    const orderOf = (type) => (ranked.includes(type.name) ? ranked.indexOf(type.name) : ranked.length);
    return data.violationTypes
      .map((type) => ({
        name: type.name,
        severity: type.severity,
        count: incidents.filter((incident) => incident.type === type.name).length,
      }))
      .sort((a, b) => orderOf(a) - orderOf(b) || data.severities[b.severity].rank - data.severities[a.severity].rank);
  }

  function deriveShifts(window, incidents) {
    return data.shifts.map((shift) => {
      const inShift = (incident) => shiftContains(shift, incident.time);
      return Object.assign({
        name: shift.name,
        hours: shift.start + ' to ' + shift.end,
        score: periodScore(window.dates, inShift),
        inProgress: shiftContains(shift, state.clockTime),
      }, summarise(incidents.filter(inShift)));
    });
  }

  function deriveZones(window, incidents) {
    return data.zones
      .map((zone) => {
        const inZone = (incident) => incident.zone === zone.name;
        return Object.assign({
          name: zone.name,
          cameras: zone.cameras,
          score: periodScore(window.dates, inZone),
        }, summarise(incidents.filter(inZone)));
      })
      .sort((a, b) => a.score - b.score || b.count - a.count);
  }

  function deriveRanking(siteScore) {
    const rows = data.sites
      .map((site) => ({
        id: site.id,
        name: site.name,
        score: site.id === data.currentSiteId ? siteScore : site.scores[state.period],
      }))
      .sort((a, b) => b.score - a.score);
    const scores = rows.map((row) => row.score);
    return { rows, average: Math.round(mean(scores)), median: Math.round(median(scores)) };
  }

  // A day's incidents in time order, each with its shift and the site score after it.
  function incidentsWithContext(dateKey) {
    let runningScore = 100;
    return incidentsOn(dateKey).map((incident) => {
      runningScore = Math.max(0, runningScore - deductionOf(incident));
      return Object.assign({ scoreAfter: runningScore, shift: shiftOf(incident.time).name }, incident);
    });
  }

  function newestFirst(a, b) {
    const stampA = a.date + 'T' + a.time;
    const stampB = b.date + 'T' + b.time;
    return stampA < stampB ? 1 : stampA > stampB ? -1 : 0;
  }

  function findIncident(incidentId) {
    for (const dateKey of recordsByDate.keys()) {
      const match = incidentsWithContext(dateKey).find((incident) => incident.id === incidentId);
      if (match) return match;
    }
    return null;
  }

  function deriveRecentIncidents() {
    return incidentsWithContext(data.clock.date).reverse().slice(0, RECENT_INCIDENT_LIMIT);
  }

  function deriveTrend(period) {
    const today = data.clock.date;
    if (period === 'today') {
      const nowMinute = toMinutes(state.clockTime);
      const stepsFor = (dateKey, untilMinute) => {
        let score = 100;
        const steps = [{ minute: 0, score, count: 0, severity: null }];
        incidentsOn(dateKey).forEach((incident) => {
          const minute = toMinutes(incident.time);
          if (minute > untilMinute) return;
          score = Math.max(0, score - deductionOf(incident));
          steps.push({ minute, score, count: steps.length, severity: incident.severity });
        });
        return steps;
      };
      return {
        kind: 'step',
        endMinute: nowMinute,
        current: stepsFor(today, nowMinute),
        previous: stepsFor(addDays(today, -1), 1440),
        xTicks: [0, 240, 480, 720, 960, 1200, 1440].map((minute) => ({ position: minute / 1440, label: formatMinutes(minute) })),
        periodLabel: formatDay(today) + ' 00:00 to ' + state.clockTime,
      };
    }

    let slotDates;
    let previousSlotDates;
    let xTickIndexes;
    let periodLabel;
    if (period === 'week') {
      const monday = periodWindow('week').dates[0];
      slotDates = datesBetween(monday, addDays(monday, 6));
      previousSlotDates = slotDates.map((dateKey) => addDays(dateKey, -7));
      xTickIndexes = [0, 1, 2, 3, 4, 5, 6];
      periodLabel = formatDay(slotDates[0], { month: false }) + ' to ' + formatDay(slotDates[6]);
    } else {
      const firstOfMonth = today.slice(0, 8) + '01';
      slotDates = datesBetween(firstOfMonth, addDays(firstOfMonth, daysInMonthOf(today) - 1));
      const firstOfPreviousMonth = periodWindow('month').previousDates[0];
      previousSlotDates = datesBetween(firstOfPreviousMonth, addDays(firstOfPreviousMonth, daysInMonthOf(firstOfPreviousMonth) - 1));
      xTickIndexes = [0, 7, 14, 21, 28];
      periodLabel = formatDay(firstOfMonth, { weekday: false, month: false }) + ' to ' + formatDay(slotDates[slotDates.length - 1], { weekday: false });
    }
    const pointFor = (dateKey, index) => ({ index, dateKey, score: dayScore(dateKey), count: incidentsOn(dateKey).length });
    return {
      kind: 'daily',
      slotCount: slotDates.length,
      current: slotDates.map(pointFor).filter((point) => point.dateKey <= today),
      previous: previousSlotDates.map(pointFor),
      xTicks: xTickIndexes.map((index) => ({
        position: index / (slotDates.length - 1),
        label: period === 'week' ? formatDay(slotDates[index], { month: false }) : formatDay(slotDates[index], { weekday: false }),
      })),
      periodLabel,
    };
  }

  function deriveCameras(incidents) {
    return data.cameras.map((camera) => {
      const zone = data.zones.find((candidate) => candidate.cameras.includes(camera.id));
      const cameraIncidents = incidents.filter((incident) => incident.camera === camera.id).sort(newestFirst);
      return {
        id: camera.id,
        online: camera.online,
        zone: zone ? zone.name : null,
        count: cameraIncidents.length,
        lastIncident: cameraIncidents[0] || null,
      };
    });
  }

  // Scores for every site in every period, for the Reports page.
  function deriveSiteComparison() {
    const periods = ['today', 'week', 'month'];
    const rows = data.sites.map((site) => {
      const scores = {};
      periods.forEach((period) => {
        scores[period] = site.id === data.currentSiteId ? periodScore(periodWindow(period).dates) : site.scores[period];
      });
      return { id: site.id, name: site.name, scores };
    }).sort((a, b) => b.scores.today - a.scores.today);
    const summary = (reduce) => {
      const values = {};
      periods.forEach((period) => { values[period] = Math.round(reduce(rows.map((row) => row.scores[period]))); });
      return values;
    };
    return { rows, average: summary(mean), median: summary(median) };
  }

  function deriveModel() {
    const window = periodWindow(state.period);
    const incidents = window.dates.flatMap(incidentsOn);
    const kpis = deriveKpis(window, incidents);
    const todaysIncidents = incidentsOn(data.clock.date);
    return {
      window,
      incidents,
      periodIncidents: window.dates.flatMap(incidentsWithContext).sort(newestFirst),
      cameras: deriveCameras(incidents),
      siteComparison: deriveSiteComparison(),
      kpis,
      trend: deriveTrend(state.period),
      types: deriveTypes(incidents),
      shifts: deriveShifts(window, incidents),
      zones: deriveZones(window, incidents),
      ranking: deriveRanking(kpis.score),
      recent: deriveRecentIncidents(),
      live: {
        camerasOnline: data.cameras.filter((camera) => camera.online).length,
        cameraCount: data.cameras.length,
        lastEventTime: todaysIncidents.length ? todaysIncidents[todaysIncidents.length - 1].time : null,
      },
    };
  }

  /* Shared markup ------------------------------------------------------ */

  function severityMarkup(severity) {
    return '<span class="severity severity-' + severity.toLowerCase() + '"><span class="severity-mark"></span>' + escapeHtml(severity) + '</span>';
  }

  function barMarkup(share, extraClass) {
    const width = Math.max(0, Math.min(100, share * 100)).toFixed(1);
    return '<span class="bar-track"><span class="bar-fill ' + (extraClass || '') + '" style="width:' + width + '%"></span></span>';
  }

  function scoreCellMarkup(score) {
    return '<div class="cell-score">' + barMarkup(score / 100) + '<span class="mono">' + score + '</span></div>';
  }

  function leadingMarkup(leading) {
    return leading ? escapeHtml(leading.name) : '<span class="text-3">None</span>';
  }

  /* Header and sidebar ------------------------------------------------- */

  function renderSidebarUser() {
    const user = data.currentUser;
    document.getElementById('sidebar-user').innerHTML =
      '<span class="avatar" aria-hidden="true">' + escapeHtml(initialsOf(user.name)) + '</span>' +
      '<div><div class="user-name">' + escapeHtml(user.name) + '</div>' + (user.role ? '<div class="user-role">' + escapeHtml(user.role) + '</div>' : '') + '</div>' +
      '<a class="link" href="#" data-action="sign-out">Sign out</a>';
  }

  function scopeMenus() {
    const organisation = data.organisations.find((item) => item.id === state.organisationId);
    const site = data.sites.find((item) => item.id === state.siteId);
    return [
      {
        key: 'organisation',
        label: organisation.name,
        options: data.organisations.map((item) => ({ value: item.id, label: item.name, selected: item.id === state.organisationId })),
      },
      {
        key: 'site',
        label: site.name,
        options: data.sites.map((item) => ({ value: item.id, label: item.name, selected: item.id === state.siteId })),
      },
      {
        key: 'zone',
        label: state.zoneName || 'All zones',
        options: [{ value: '', label: 'All zones', selected: !state.zoneName }].concat(
          data.zones.map((zone) => ({ value: zone.name, label: zone.name, selected: zone.name === state.zoneName }))),
      },
    ];
  }

  function renderScope() {
    const container = document.getElementById('scope');
    container.innerHTML = scopeMenus().map((menu, index) => {
      const isOpen = state.openMenu === menu.key;
      const menuMarkup = isOpen
        ? '<div class="menu" role="menu" aria-label="' + escapeHtml(menu.key) + '">' +
          menu.options.map((option) =>
            '<button type="button" class="menu-item" role="menuitemradio" aria-checked="' + option.selected + '"' +
            ' data-menu="' + menu.key + '" data-value="' + escapeHtml(option.value) + '">' +
            '<span>' + escapeHtml(option.label) + '</span>' + (option.selected ? ICONS.check : '') + '</button>').join('') +
          '</div>'
        : '';
      return (index ? '<span class="scope-separator" aria-hidden="true">/</span>' : '') +
        '<div class="scope-segment scope-segment-' + menu.key + '">' +
        '<button type="button" class="scope-trigger" aria-haspopup="menu" aria-expanded="' + isOpen + '" data-menu-trigger="' + menu.key + '">' +
        '<span>' + escapeHtml(menu.label) + '</span>' + ICONS.caret + '</button>' + menuMarkup + '</div>';
    }).join('');
  }

  function focusSelectedMenuItem() {
    const selected = document.querySelector('#scope .menu [aria-checked="true"]') || document.querySelector('#scope .menu-item');
    if (selected) selected.focus();
  }

  function renderPeriodControl() {
    document.getElementById('clock-date').textContent = formatDay(data.clock.date, { year: true });
    document.querySelectorAll('#period-control button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.period === state.period));
    });
  }

  function renderLiveStatus(live) {
    document.getElementById('live-status').innerHTML =
      '<span class="live-state"><span class="live-dot" aria-hidden="true"></span>Live</span>' +
      '<span class="live-meta mono">' + live.camerasOnline + ' of ' + live.cameraCount + ' cameras online</span>' +
      '<span class="live-meta mono">Last event ' + (live.lastEventTime || 'None') + '</span>';
  }

  /* KPI strip ---------------------------------------------------------- */

  function sparklineMarkup(values) {
    const width = 96;
    const height = 28;
    const inset = 3;
    const low = Math.min.apply(null, values);
    const high = Math.max.apply(null, values);
    const range = Math.max(1, high - low);
    const points = values.map((value, index) => [
      inset + (index / (values.length - 1)) * (width - inset * 2),
      inset + (1 - (value - low) / range) * (height - inset * 2),
    ]);
    const last = points[points.length - 1];
    return '<svg class="sparkline" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" aria-hidden="true">' +
      '<polyline points="' + points.map((point) => point.map((n) => n.toFixed(1)).join(',')).join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3" fill="var(--accent)"/></svg>';
  }

  function renderKpis(kpis) {
    const highRiskCount = kpis.criticalCount + kpis.highCount;
    const breakdown = highRiskCount > 0
      ? '<span class="severity-breakdown">' +
        '<span class="severity-breakdown-item severity-critical"><span class="severity-tick"></span><span class="mono">' + kpis.criticalCount + '</span></span>' +
        '<span class="severity-breakdown-item severity-high"><span class="severity-tick"></span><span class="mono">' + kpis.highCount + '</span></span></span>'
      : '';

    const cells = [
      '<div class="kpi-cell">' +
        '<span class="kpi-label">Safety score</span>' +
        '<div class="kpi-score-row"><span class="kpi-value kpi-value-hero">' + kpis.score + '<span class="kpi-unit">/100</span></span>' +
        sparklineMarkup(kpis.sparkline) + '</div>' +
        '<span class="kpi-foot ' + deltaClass(kpis.scoreDelta, true) + '"><span class="num">' + formatSigned(kpis.scoreDelta) + ' ' + kpis.deltaLabel + '</span></span>' +
      '</div>',

      '<div class="kpi-cell">' +
        '<span class="kpi-label">Incidents</span>' +
        '<span class="kpi-value">' + kpis.incidentCount + '</span>' +
        '<span class="kpi-foot ' + deltaClass(kpis.incidentDelta, false) + '"><span class="num">' + formatSigned(kpis.incidentDelta) + ' ' + kpis.deltaLabel + '</span></span>' +
      '</div>',

      '<div class="kpi-cell">' +
        '<span class="kpi-label">High risk</span>' +
        '<span class="kpi-value">' + highRiskCount + breakdown + '</span>' +
        '<span class="kpi-foot">Critical and High</span>' +
      '</div>',

      '<div class="kpi-cell">' +
        '<span class="kpi-label">Leading violation</span>' +
        '<span class="kpi-value kpi-value-text">' + (kpis.leading ? escapeHtml(kpis.leading.name) : 'None') + '</span>' +
        '<span class="kpi-foot"><span class="num">' + (kpis.leading ? kpis.leading.count : 0) + ' of ' + kpis.incidentCount + ' incidents</span></span>' +
      '</div>',

      '<div class="kpi-cell">' +
        '<span class="kpi-label">Compliance rate</span>' +
        '<span class="kpi-value">' + kpis.complianceRate + '<span class="kpi-unit">%</span></span>' +
        '<span class="kpi-foot"><span class="num">' + kpis.peopleCompliant + ' of ' + kpis.peopleObserved + ' people observed</span></span>' +
      '</div>',
    ];
    document.getElementById('kpi-strip').innerHTML = cells.join('');
  }

  /* Safety score trend ------------------------------------------------- */

  let trendHoverModel = null;

  function renderTrendHeader(trend) {
    const site = data.sites.find((item) => item.id === data.currentSiteId);
    document.getElementById('trend-period').textContent = trend.periodLabel;
    document.getElementById('trend-key').innerHTML =
      '<span class="trend-key-item"><span class="key-line"></span>' + escapeHtml(site.name) + '</span>' +
      '<span class="trend-key-item"><span class="key-line key-line-dashed"></span>Previous period</span>';
  }

  function renderTrendChart(trend) {
    const container = document.getElementById('trend-chart');
    const styles = getComputedStyle(container);
    const width = container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const height = 220;
    const margin = { top: 8, right: 36, bottom: 24, left: 0 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const plotRight = margin.left + plotWidth;
    const plotBottom = margin.top + plotHeight;
    const y = (score) => margin.top + (1 - score / 100) * plotHeight;
    const xAt = (position) => margin.left + position * plotWidth;

    const parts = [];

    [0, 25, 50, 75, 100].forEach((value) => {
      if (value > 0 && value < 100) {
        parts.push('<line x1="' + margin.left + '" x2="' + plotRight + '" y1="' + y(value) + '" y2="' + y(value) + '" stroke="var(--border)" shape-rendering="crispEdges"/>');
      }
      parts.push('<text class="chart-axis-label" x="' + width + '" y="' + (y(value) + 4) + '" text-anchor="end">' + value + '</text>');
    });
    parts.push('<line x1="' + margin.left + '" x2="' + plotRight + '" y1="' + plotBottom + '" y2="' + plotBottom + '" stroke="var(--border-strong)" shape-rendering="crispEdges"/>');

    trend.xTicks.forEach((tick, index) => {
      const anchor = index === 0 ? 'start' : index === trend.xTicks.length - 1 && tick.position === 1 ? 'end' : 'middle';
      parts.push('<text class="chart-axis-label" x="' + xAt(tick.position) + '" y="' + (height - 4) + '" text-anchor="' + anchor + '">' + escapeHtml(tick.label) + '</text>');
    });

    if (trend.kind === 'step') {
      const xMinute = (minute) => xAt(minute / 1440);
      const stepPath = (steps, endMinute) => {
        let path = 'M' + xMinute(steps[0].minute) + ',' + y(steps[0].score);
        steps.slice(1).forEach((step) => { path += 'H' + xMinute(step.minute) + 'V' + y(step.score); });
        return path + 'H' + xMinute(endMinute);
      };
      parts.push('<path d="' + stepPath(trend.previous, 1440) + '" fill="none" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3"/>');
      parts.push('<path d="' + stepPath(trend.current, trend.endMinute) + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/>');
      trend.current.slice(1).forEach((step) => {
        const colour = step.severity === 'Critical' ? 'var(--critical)' : step.severity === 'High' ? 'var(--high)' : 'var(--text-3)';
        const tickX = xMinute(step.minute);
        parts.push('<line x1="' + tickX + '" x2="' + tickX + '" y1="' + (y(step.score) + 4) + '" y2="' + (y(step.score) + 11) + '" stroke="' + colour + '" stroke-width="2"/>');
      });
      const lastStep = trend.current[trend.current.length - 1];
      parts.push('<circle cx="' + xMinute(trend.endMinute) + '" cy="' + y(lastStep.score) + '" r="3" fill="var(--accent)"/>');

      trendHoverModel = {
        pointAt(offsetX) {
          const minute = Math.round(Math.max(0, Math.min(trend.endMinute, ((offsetX - margin.left) / plotWidth) * 1440)));
          const step = trend.current.filter((candidate) => candidate.minute <= minute).pop();
          return { x: xMinute(minute), title: formatMinutes(minute), score: step.score, count: step.count };
        },
      };
    } else {
      const xIndex = (index) => xAt(index / (trend.slotCount - 1));
      const linePath = (points) => points.map((point, index) => (index ? 'L' : 'M') + xIndex(point.index) + ',' + y(point.score)).join('');
      parts.push('<path d="' + linePath(trend.previous) + '" fill="none" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3"/>');
      parts.push('<path d="' + linePath(trend.current) + '" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>');
      if (trend.slotCount <= 7) {
        trend.current.forEach((point) => {
          parts.push('<circle cx="' + xIndex(point.index) + '" cy="' + y(point.score) + '" r="2" fill="var(--accent)"/>');
        });
      }
      const lastPoint = trend.current[trend.current.length - 1];
      parts.push('<circle cx="' + xIndex(lastPoint.index) + '" cy="' + y(lastPoint.score) + '" r="3" fill="var(--accent)"/>');

      trendHoverModel = {
        pointAt(offsetX) {
          const rawIndex = Math.round(((offsetX - margin.left) / plotWidth) * (trend.slotCount - 1));
          const point = trend.current[Math.max(0, Math.min(lastPoint.index, rawIndex))];
          return { x: xIndex(point.index), title: formatDay(point.dateKey), score: point.score, count: point.count };
        },
      };
    }

    parts.push('<line class="chart-crosshair" x1="0" x2="0" y1="' + margin.top + '" y2="' + plotBottom + '" stroke="var(--border-strong)" visibility="hidden" shape-rendering="crispEdges"/>');
    parts.push('<rect class="chart-hit-area" x="' + margin.left + '" y="' + margin.top + '" width="' + plotWidth + '" height="' + plotHeight + '" fill="transparent"/>');

    container.innerHTML =
      '<svg width="' + width + '" height="' + height + '" role="img" aria-label="Safety score trend">' + parts.join('') + '</svg>' +
      '<div class="chart-tooltip" aria-hidden="true"></div>';

    const hitArea = container.querySelector('.chart-hit-area');
    const crosshair = container.querySelector('.chart-crosshair');
    const tooltip = container.querySelector('.chart-tooltip');
    const paddingLeft = parseFloat(styles.paddingLeft);

    hitArea.addEventListener('mousemove', (event) => {
      const svgBox = container.querySelector('svg').getBoundingClientRect();
      const point = trendHoverModel.pointAt(event.clientX - svgBox.left);
      crosshair.setAttribute('x1', point.x);
      crosshair.setAttribute('x2', point.x);
      crosshair.setAttribute('visibility', 'visible');
      tooltip.innerHTML =
        '<div class="chart-tooltip-title mono">' + escapeHtml(point.title) + '</div>' +
        '<div class="chart-tooltip-row"><span>Score</span><span class="mono">' + point.score + '</span></div>' +
        '<div class="chart-tooltip-row"><span>Incidents</span><span class="mono">' + point.count + '</span></div>';
      tooltip.classList.add('is-visible');
      const tooltipWidth = tooltip.offsetWidth;
      const preferredLeft = paddingLeft + point.x + 12;
      const left = preferredLeft + tooltipWidth > container.clientWidth - 8 ? paddingLeft + point.x - tooltipWidth - 12 : preferredLeft;
      tooltip.style.left = left + 'px';
    });
    hitArea.addEventListener('mouseleave', () => {
      crosshair.setAttribute('visibility', 'hidden');
      tooltip.classList.remove('is-visible');
    });
  }

  /* Incidents by type -------------------------------------------------- */

  function renderTypes(types) {
    const total = types.reduce((sum, type) => sum + type.count, 0);
    document.getElementById('types-body').innerHTML =
      '<ul class="type-list">' + types.map((type) => {
        const severityClass = type.severity === 'Critical' || type.severity === 'High' ? 'severity-' + type.severity.toLowerCase() : '';
        return '<li class="type-row">' +
          '<span class="type-name">' + escapeHtml(type.name) + '</span>' +
          barMarkup(total ? type.count / total : 0, severityClass) +
          '<span class="type-count mono">' + type.count + '</span></li>';
      }).join('') + '</ul>';
  }

  /* Shared panels and tables ------------------------------------------- */

  const PERIOD_NAMES = { today: 'Today', week: 'This week', month: 'This month' };

  function panelMarkup(options) {
    return '<section class="panel' + (options.className ? ' ' + options.className : '') + '" aria-label="' + escapeHtml(options.title) + '">' +
      '<div class="panel-header"><h2 class="panel-title">' + escapeHtml(options.title) + '</h2>' +
      (options.meta ? '<span class="panel-meta"' + (options.metaId ? ' id="' + options.metaId + '"' : '') + '>' + options.meta + '</span>' : '') +
      (options.action || '') + '</div>' +
      (options.body || '') + '</section>';
  }

  function actionLink(label, route) {
    return '<a class="link panel-action" href="#/' + route + '">' + escapeHtml(label) + '</a>';
  }

  function colgroupMarkup(widths) {
    return '<colgroup>' + widths.map((width) => (width ? '<col style="width:' + width + '">' : '<col>')).join('') + '</colgroup>';
  }

  function headerRowMarkup(columns) {
    return '<thead><tr>' + columns.map((column) =>
      '<th' + (column.numeric ? ' class="is-numeric"' : '') + '>' + escapeHtml(column.label) + '</th>').join('') + '</tr></thead>';
  }

  function emptyTableMarkup(columnCount) {
    return '<tr><td colspan="' + columnCount + '" class="text-3">None</td></tr>';
  }

  function incidentRowOpen(incident) {
    const classes = ['is-clickable'];
    if (incident.id === state.freshIncidentId) classes.push('is-fresh');
    if (incident.id === state.drawerIncidentId) classes.push('is-selected');
    return '<tr class="' + classes.join(' ') + '" tabindex="0" data-incident-id="' + escapeHtml(incident.id) + '" data-focus-key="row-' + escapeHtml(incident.id) + '">';
  }

  function incidentWhen(incident, showDate) {
    return showDate ? formatDay(incident.date) + ' ' + incident.time : incident.time;
  }

  function shiftNameMarkup(shift) {
    return '<div class="cell-flex"><span class="truncate">' + escapeHtml(shift.name) + '</span>' +
      (shift.inProgress ? '<span class="tag">In progress</span>' : '') + '</div>';
  }

  // A count table of violation types against shifts or zones.
  function matrixMarkup(columnLabels, cellCount) {
    const columns = [{ label: 'Violation' }].concat(columnLabels.map((label) => ({ label, numeric: true })));
    const rows = data.violationTypes.map((type) => {
      const counts = columnLabels.map((label) => cellCount(type.name, label));
      return '<tr><td>' + escapeHtml(type.name) + '</td>' + counts.map((count) =>
        '<td class="is-numeric mono' + (count ? '' : ' text-3') + '">' + count + '</td>').join('') + '</tr>';
    });
    const totals = columnLabels.map((label) => data.violationTypes.reduce((sum, type) => sum + cellCount(type.name, label), 0));
    return '<table class="table table-matrix">' + colgroupMarkup(['140px'].concat(columnLabels.map(() => null))) + headerRowMarkup(columns) +
      '<tbody>' + rows.join('') + '</tbody>' +
      '<tfoot><tr><td>Total</td>' + totals.map((total) => '<td class="is-numeric mono">' + total + '</td>').join('') + '</tr></tfoot></table>';
  }

  /* Overview page panels ----------------------------------------------- */

  function overviewShiftsMarkup(shifts) {
    return '<table class="table">' + colgroupMarkup([null, '120px', '88px']) +
      headerRowMarkup([{ label: 'Shift' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true }]) +
      '<tbody>' + shifts.map((shift) =>
        '<tr><td>' + shiftNameMarkup(shift) + '</td><td>' + scoreCellMarkup(shift.score) + '</td>' +
        '<td class="is-numeric mono">' + shift.count + '</td></tr>').join('') + '</tbody></table>';
  }

  function overviewZonesMarkup(zones) {
    return '<table class="table">' + colgroupMarkup([null, '120px', '88px']) +
      headerRowMarkup([{ label: 'Zone' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true }]) +
      '<tbody>' + zones.map((zone) =>
        '<tr><td>' + escapeHtml(zone.name) + '</td><td>' + scoreCellMarkup(zone.score) + '</td>' +
        '<td class="is-numeric mono">' + zone.count + '</td></tr>').join('') + '</tbody></table>';
  }

  function recentIncidentsMarkup(recent) {
    return '<table class="table">' + colgroupMarkup(['72px', null, '112px', null]) +
      headerRowMarkup([{ label: 'Time' }, { label: 'Violation' }, { label: 'Severity' }, { label: 'Zone' }]) +
      '<tbody>' + (recent.length ? recent.map((incident) =>
        incidentRowOpen(incident) +
        '<td class="mono">' + escapeHtml(incident.time) + '</td>' +
        '<td>' + escapeHtml(incident.type) + '</td>' +
        '<td>' + severityMarkup(incident.severity) + '</td>' +
        '<td>' + escapeHtml(incident.zone) + '</td></tr>').join('') : emptyTableMarkup(4)) +
      '</tbody></table>';
  }

  function rankingMarkup(ranking) {
    return '<ol class="rank-list">' + ranking.rows.map((row, index) => {
      const isCurrent = row.id === data.currentSiteId;
      return '<li class="rank-row' + (isCurrent ? ' is-current' : '') + '"' + (isCurrent ? ' aria-current="true"' : '') + '>' +
        '<span class="rank-number mono">' + (index + 1) + '</span>' +
        '<span class="rank-name">' + escapeHtml(row.name) + '</span>' +
        barMarkup(row.score / 100) +
        '<span class="rank-score mono">' + row.score + '</span></li>';
    }).join('') + '</ol>' +
      '<div class="rank-stats"><span>Company average<span class="mono">' + ranking.average + '</span></span></div>';
  }

  function renderOverviewPage(model) {
    document.getElementById('content').innerHTML =
      '<div class="sheet">' +
      '<section class="kpi-strip" id="kpi-strip" aria-label="Key figures"></section>' +
      '<div class="row row-2-1">' +
      panelMarkup({ title: 'Safety score', metaId: 'trend-period', meta: ' ', body: '<div class="trend-key" id="trend-key"></div><div class="chart" id="trend-chart"></div>' }) +
      panelMarkup({ title: 'Incidents by type', body: '<div id="types-body"></div>' }) +
      '</div>' +
      '<div class="row row-1-1">' +
      panelMarkup({ title: 'Shifts', action: actionLink('View shifts', 'shifts'), body: overviewShiftsMarkup(model.shifts) }) +
      panelMarkup({ title: 'Zones', action: actionLink('View zones', 'zones'), body: overviewZonesMarkup(model.zones) }) +
      '</div>' +
      '<div class="row row-2-1">' +
      panelMarkup({ title: 'Recent incidents', meta: 'Today', action: actionLink('View all incidents', 'incidents'), body: recentIncidentsMarkup(model.recent) }) +
      panelMarkup({ title: 'Site ranking', action: actionLink('Compare sites', 'reports'), body: rankingMarkup(model.ranking) }) +
      '</div></div>';
    renderKpis(model.kpis);
    renderTrendHeader(model.trend);
    renderTrendChart(model.trend);
    renderTypes(model.types);
  }

  /* Incidents page ----------------------------------------------------- */

  function filteredIncidents(incidents) {
    const filters = state.incidentFilters;
    return incidents.filter((incident) =>
      (filters.severity === 'all' || incident.severity === filters.severity) &&
      (filters.zone === 'all' || incident.zone === filters.zone) &&
      (filters.type === 'all' || incident.type === filters.type));
  }

  function selectMarkup(filterKey, allLabel, options) {
    const current = state.incidentFilters[filterKey];
    return '<select class="select" data-filter="' + filterKey + '" data-focus-key="filter-' + filterKey + '">' +
      '<option value="all">' + escapeHtml(allLabel) + '</option>' +
      options.map((option) => '<option value="' + escapeHtml(option) + '"' + (option === current ? ' selected' : '') + '>' + escapeHtml(option) + '</option>').join('') +
      '</select>';
  }

  function incidentFilterBarMarkup() {
    const filters = state.incidentFilters;
    const severityOptions = ['all'].concat(Object.keys(data.severities));
    const isFiltered = filters.severity !== 'all' || filters.zone !== 'all' || filters.type !== 'all';
    return '<div class="filter-bar">' +
      '<div class="filter"><span class="filter-label" id="severity-filter-label">Severity</span>' +
      '<div class="segmented" role="group" aria-labelledby="severity-filter-label">' + severityOptions.map((severity) =>
        '<button type="button" data-severity="' + severity + '" data-focus-key="severity-' + severity + '" aria-pressed="' + (filters.severity === severity) + '">' +
        (severity === 'all' ? 'All' : severity) + '</button>').join('') + '</div></div>' +
      '<label class="filter"><span class="filter-label">Zone</span>' + selectMarkup('zone', 'All zones', data.zones.map((zone) => zone.name)) + '</label>' +
      '<label class="filter"><span class="filter-label">Violation</span>' + selectMarkup('type', 'All violations', data.violationTypes.map((type) => type.name)) + '</label>' +
      (isFiltered ? '<button type="button" class="link link-button" data-action="clear-filters" data-focus-key="clear-filters">Clear filters</button>' : '') +
      '</div>';
  }

  function incidentsTableMarkup(incidents, showDate) {
    const columns = [
      { label: 'Time' }, { label: 'Event ID' }, { label: 'Violation' }, { label: 'Severity' }, { label: 'Zone' },
      { label: 'Camera' }, { label: 'Shift' }, { label: 'Points', numeric: true }, { label: 'Clip', numeric: true },
    ];
    return '<table class="table">' +
      colgroupMarkup([showDate ? '152px' : '72px', '156px', null, '96px', null, '76px', '64px', '60px', '48px']) +
      headerRowMarkup(columns) +
      '<tbody>' + (incidents.length ? incidents.map((incident) =>
        incidentRowOpen(incident) +
        '<td class="mono">' + escapeHtml(incidentWhen(incident, showDate)) + '</td>' +
        '<td class="mono">' + escapeHtml(incident.id) + '</td>' +
        '<td>' + escapeHtml(incident.type) + '</td>' +
        '<td>' + severityMarkup(incident.severity) + '</td>' +
        '<td>' + escapeHtml(incident.zone) + '</td>' +
        '<td class="mono">' + escapeHtml(incident.camera) + '</td>' +
        '<td>' + escapeHtml(incident.shift) + '</td>' +
        '<td class="is-numeric mono points">' + formatPoints(deductionOf(incident)) + '</td>' +
        '<td class="is-numeric"><button type="button" class="clip-button" tabindex="-1" aria-label="Play clip">' + ICONS.play + '</button></td>' +
        '</tr>').join('') : emptyTableMarkup(columns.length)) +
      '</tbody></table>';
  }

  function renderIncidentsPage(model) {
    const incidents = filteredIncidents(model.periodIncidents);
    const countLabel = incidents.length === model.periodIncidents.length
      ? String(incidents.length)
      : incidents.length + ' of ' + model.periodIncidents.length;
    document.getElementById('content').innerHTML =
      '<div class="sheet">' +
      panelMarkup({
        title: 'Incidents',
        action: '<span class="panel-count mono">' + countLabel + '</span>',
        body: incidentFilterBarMarkup() + incidentsTableMarkup(incidents, model.window.dates.length > 1),
      }) +
      '</div>';
  }

  /* Shifts page -------------------------------------------------------- */

  function shiftDetailMarkup(shifts) {
    return '<table class="table">' + colgroupMarkup(['160px', '140px', '120px', '96px', '96px', null]) +
      headerRowMarkup([{ label: 'Shift' }, { label: 'Hours' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true },
        { label: 'High risk', numeric: true }, { label: 'Leading violation' }]) +
      '<tbody>' + shifts.map((shift) =>
        '<tr><td>' + shiftNameMarkup(shift) + '</td>' +
        '<td class="mono">' + escapeHtml(shift.hours) + '</td>' +
        '<td>' + scoreCellMarkup(shift.score) + '</td>' +
        '<td class="is-numeric mono">' + shift.count + '</td>' +
        '<td class="is-numeric mono">' + shift.highRisk + '</td>' +
        '<td>' + leadingMarkup(shift.leading) + '</td></tr>').join('') + '</tbody></table>';
  }

  function dailyShiftScoresMarkup(dates) {
    const columns = [{ label: 'Day' }].concat(data.shifts.map((shift) => ({ label: shift.name, numeric: true })), [{ label: 'Site', numeric: true }]);
    const rows = dates.slice().reverse().map((dateKey) =>
      '<tr><td class="mono">' + escapeHtml(formatDay(dateKey)) + '</td>' +
      data.shifts.map((shift) => '<td class="is-numeric mono">' + dayScore(dateKey, (incident) => shiftContains(shift, incident.time)) + '</td>').join('') +
      '<td class="is-numeric mono">' + dayScore(dateKey) + '</td></tr>');
    return '<div class="table-scroll"><table class="table">' + colgroupMarkup(['128px', null, null, null, null]) + headerRowMarkup(columns) +
      '<tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function renderShiftsPage(model) {
    const shiftNames = data.shifts.map((shift) => shift.name);
    document.getElementById('content').innerHTML =
      '<div class="sheet">' +
      panelMarkup({ title: 'Shift performance', body: shiftDetailMarkup(model.shifts) }) +
      '<div class="row row-1-1">' +
      panelMarkup({
        title: 'Violations by shift',
        body: matrixMarkup(shiftNames, (typeName, shiftName) => {
          const shift = data.shifts.find((candidate) => candidate.name === shiftName);
          return model.incidents.filter((incident) => incident.type === typeName && shiftContains(shift, incident.time)).length;
        }),
      }) +
      panelMarkup({ title: 'Daily score by shift', body: dailyShiftScoresMarkup(model.window.dates) }) +
      '</div></div>';
  }

  /* Zones page --------------------------------------------------------- */

  function zoneDetailMarkup(zones) {
    return '<table class="table">' + colgroupMarkup(['180px', '120px', '96px', '96px', null, '160px']) +
      headerRowMarkup([{ label: 'Zone' }, { label: 'Score', numeric: true }, { label: 'Incidents', numeric: true },
        { label: 'High risk', numeric: true }, { label: 'Leading violation' }, { label: 'Cameras' }]) +
      '<tbody>' + zones.map((zone) =>
        '<tr><td>' + escapeHtml(zone.name) + '</td>' +
        '<td>' + scoreCellMarkup(zone.score) + '</td>' +
        '<td class="is-numeric mono">' + zone.count + '</td>' +
        '<td class="is-numeric mono">' + zone.highRisk + '</td>' +
        '<td>' + leadingMarkup(zone.leading) + '</td>' +
        '<td class="mono text-2">' + zone.cameras.map(escapeHtml).join(' ') + '</td></tr>').join('') + '</tbody></table>';
  }

  function camerasMarkup(cameras, showDate) {
    return '<table class="table">' + colgroupMarkup(['88px', null, '96px', '88px', showDate ? '140px' : '96px']) +
      headerRowMarkup([{ label: 'Camera' }, { label: 'Zone' }, { label: 'Status' }, { label: 'Incidents', numeric: true }, { label: 'Last event' }]) +
      '<tbody>' + cameras.map((camera) =>
        '<tr><td class="mono">' + escapeHtml(camera.id) + '</td>' +
        '<td>' + (camera.zone ? escapeHtml(camera.zone) : '<span class="text-3">Unassigned</span>') + '</td>' +
        '<td class="text-2">' + (camera.online ? 'Online' : 'Offline') + '</td>' +
        '<td class="is-numeric mono">' + camera.count + '</td>' +
        '<td class="mono">' + (camera.lastIncident ? escapeHtml(incidentWhen(camera.lastIncident, showDate)) : '<span class="text-3">None</span>') + '</td></tr>').join('') +
      '</tbody></table>';
  }

  function renderZonesPage(model) {
    const zoneNames = data.zones.map((zone) => zone.name);
    document.getElementById('content').innerHTML =
      '<div class="sheet">' +
      panelMarkup({ title: 'Zone performance', body: zoneDetailMarkup(model.zones) }) +
      '<div class="row row-1-1">' +
      panelMarkup({
        title: 'Violations by zone',
        body: matrixMarkup(zoneNames, (typeName, zoneName) =>
          model.incidents.filter((incident) => incident.type === typeName && incident.zone === zoneName).length),
      }) +
      panelMarkup({ title: 'Cameras', body: camerasMarkup(model.cameras, model.window.dates.length > 1) }) +
      '</div></div>';
  }

  /* Reports page ------------------------------------------------------- */

  function siteComparisonMarkup(comparison) {
    const periods = ['today', 'week', 'month'];
    const scoreCells = (scores) => periods.map((period) => '<td class="is-numeric mono">' + scores[period] + '</td>').join('');
    return '<table class="table table-ranked">' + colgroupMarkup(['64px', null, '120px', '120px', '120px']) +
      headerRowMarkup([{ label: 'Rank' }, { label: 'Site' }].concat(periods.map((period) => ({ label: PERIOD_NAMES[period], numeric: true })))) +
      '<tbody>' + comparison.rows.map((row, index) =>
        '<tr' + (row.id === data.currentSiteId ? ' class="is-current" aria-current="true"' : '') + '>' +
        '<td class="mono text-3">' + (index + 1) + '</td><td>' + escapeHtml(row.name) + '</td>' + scoreCells(row.scores) + '</tr>').join('') +
      '</tbody><tfoot>' +
      '<tr><td></td><td>Company average</td>' + scoreCells(comparison.average) + '</tr>' +
      '<tr><td></td><td>Median</td>' + scoreCells(comparison.median) + '</tr>' +
      '</tfoot></table>';
  }

  function scheduledReportsMarkup(reports) {
    return '<table class="table">' + colgroupMarkup([null, '176px', null, '140px', '96px']) +
      headerRowMarkup([{ label: 'Report' }, { label: 'Frequency' }, { label: 'Recipients' }, { label: 'Last sent' }, { label: 'File', numeric: true }]) +
      '<tbody>' + reports.map((report) => {
        const [dateKey, time] = report.lastSent.split(' ');
        return '<tr><td>' + escapeHtml(report.name) + '</td>' +
          '<td class="text-2">' + escapeHtml(report.frequency) + '</td>' +
          '<td class="text-2">' + escapeHtml(report.recipients) + '</td>' +
          '<td class="mono">' + escapeHtml(formatDay(dateKey) + ' ' + time) + '</td>' +
          '<td class="is-numeric"><a class="link" href="#">Download</a></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderReportsPage(model) {
    document.getElementById('content').innerHTML =
      '<div class="sheet">' +
      panelMarkup({ title: 'Site comparison', meta: 'Safety score', body: siteComparisonMarkup(model.siteComparison) }) +
      '<div class="row row-2-1">' +
      panelMarkup({ title: 'Scheduled reports', body: scheduledReportsMarkup(data.scheduledReports) }) +
      panelMarkup({
        title: 'NODE benchmark',
        body: '<div class="panel-note">Available once enough sites contribute data</div>',
      }) +
      '</div></div>';
  }

  /* Incident drawer ---------------------------------------------------- */

  function renderDrawer() {
    const drawer = document.getElementById('drawer');
    const incident = state.drawerIncidentId ? findIncident(state.drawerIncidentId) : null;
    const isOpen = Boolean(incident);
    drawer.classList.toggle('is-open', isOpen);
    drawer.setAttribute('aria-hidden', String(!isOpen));
    if (!isOpen) return;

    const details = [
      ['Time', '<span class="mono">' + escapeHtml(formatDay(incident.date) + ' ' + incident.time) + '</span>'],
      ['Violation', escapeHtml(incident.type)],
      ['Severity', severityMarkup(incident.severity)],
      ['Points deducted', '<span class="mono">' + formatPoints(deductionOf(incident)) + '</span>'],
      ['Zone', escapeHtml(incident.zone)],
      ['Camera', '<span class="mono">' + escapeHtml(incident.camera) + '</span>'],
      ['Shift', escapeHtml(incident.shift)],
      ['Score after event', '<span class="mono">' + incident.scoreAfter + '</span>'],
    ];
    drawer.innerHTML =
      '<div class="drawer-header"><h2 class="drawer-title" id="drawer-title">' + escapeHtml(incident.id) + '</h2>' +
      '<button type="button" class="icon-button" data-action="close-drawer" aria-label="Close">' + ICONS.close + '</button></div>' +
      '<div class="drawer-body">' +
      '<div class="clip"><button type="button" class="clip-play" aria-label="Play clip">' + ICONS.playLarge + '</button><span>Blurred clip, 15 s</span></div>' +
      '<div class="scrubber mono"><span>0 s</span><span class="scrubber-track"><span class="scrubber-handle"></span></span><span>15 s</span></div>' +
      '<dl class="details">' + details.map((pair) => '<dt>' + pair[0] + '</dt><dd>' + pair[1] + '</dd>').join('') + '</dl>' +
      '</div>';
  }

  function openDrawer(incidentId) {
    state.drawerReturnFocus = incidentId;
    state.drawerIncidentId = incidentId;
    renderAll();
    const closeButton = document.querySelector('#drawer [data-action="close-drawer"]');
    if (closeButton) closeButton.focus();
  }

  function closeDrawer() {
    const returnTo = state.drawerReturnFocus;
    state.drawerIncidentId = null;
    renderAll();
    const row = returnTo && document.querySelector('[data-incident-id="' + returnTo + '"]');
    if (row) row.focus();
  }

  /* Pages and rendering ------------------------------------------------ */

  const PAGES = {
    overview: { title: 'Overview', usesPeriod: true, render: renderOverviewPage },
    incidents: { title: 'Incidents', usesPeriod: true, render: renderIncidentsPage },
    shifts: { title: 'Shifts', usesPeriod: true, render: renderShiftsPage },
    zones: { title: 'Zones', usesPeriod: true, render: renderZonesPage },
    reports: { title: 'Reports', usesPeriod: false, render: renderReportsPage },
  };

  function currentPageKey() {
    const key = window.location.hash.replace(/^#\/?/, '');
    return PAGES[key] ? key : 'overview';
  }

  function renderNav(pageKey) {
    document.querySelectorAll('.nav-item[data-route]').forEach((link) => {
      const isActive = link.dataset.route === pageKey;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  let latestModel = null;

  function renderAll() {
    const content = document.getElementById('content');
    const active = document.activeElement;
    const focusKey = active && content.contains(active) ? active.getAttribute('data-focus-key') : null;
    const scrollTop = content.scrollTop;

    latestModel = deriveModel();
    const pageKey = currentPageKey();
    const page = PAGES[pageKey];
    document.title = 'NODE ' + page.title;
    renderNav(pageKey);
    renderScope();
    renderPeriodControl();
    document.getElementById('period-control').hidden = !page.usesPeriod;
    renderLiveStatus(latestModel.live);
    page.render(latestModel);
    renderDrawer();

    content.scrollTop = scrollTop;
    if (focusKey) {
      const target = content.querySelector('[data-focus-key="' + focusKey + '"]');
      if (target) target.focus();
    }
  }

  /* Simulated live event ----------------------------------------------- */

  function deliverLiveEventIfDue() {
    if (!state.liveEventDue || state.liveEventDelivered || state.period !== 'today') return;
    const liveIncident = data.liveEvent.incident;
    recordsByDate.get(data.clock.date).incidents.push(Object.assign({}, liveIncident));
    state.clockTime = data.liveEvent.clockTimeAfter;
    state.liveEventDelivered = true;
    state.freshIncidentId = liveIncident.id;
    renderAll();
    window.setTimeout(() => { state.freshIncidentId = null; }, 2000);
  }

  /* Events ------------------------------------------------------------- */

  function bindEvents() {
    document.getElementById('period-control').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-period]');
      if (!button || button.dataset.period === state.period) return;
      state.period = button.dataset.period;
      renderAll();
      deliverLiveEventIfDue();
    });

    document.getElementById('scope').addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-menu-trigger]');
      if (trigger) {
        const menuKey = trigger.dataset.menuTrigger;
        state.openMenu = state.openMenu === menuKey ? null : menuKey;
        renderScope();
        if (state.openMenu) focusSelectedMenuItem();
        else document.querySelector('[data-menu-trigger="' + menuKey + '"]').focus();
        return;
      }
      const item = event.target.closest('.menu-item');
      if (!item) return;
      const menuKey = item.dataset.menu;
      if (menuKey === 'organisation') state.organisationId = item.dataset.value;
      if (menuKey === 'site') state.siteId = item.dataset.value;
      if (menuKey === 'zone') state.zoneName = item.dataset.value || null;
      state.openMenu = null;
      renderScope();
      document.querySelector('[data-menu-trigger="' + menuKey + '"]').focus();
    });

    document.addEventListener('click', (event) => {
      if (state.openMenu && !event.target.closest('.scope-segment')) {
        state.openMenu = null;
        renderScope();
      }
      if (event.target.closest('a[href="#"]')) event.preventDefault();
    });

    const content = document.getElementById('content');
    content.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-incident-id]');
      if (row) {
        openDrawer(row.dataset.incidentId);
        return;
      }
      const severityButton = event.target.closest('button[data-severity]');
      if (severityButton) {
        state.incidentFilters.severity = severityButton.dataset.severity;
        renderAll();
        return;
      }
      if (event.target.closest('[data-action="clear-filters"]')) {
        state.incidentFilters = { severity: 'all', zone: 'all', type: 'all' };
        renderAll();
        const firstFilter = content.querySelector('[data-focus-key="severity-all"]');
        if (firstFilter) firstFilter.focus();
      }
    });
    content.addEventListener('change', (event) => {
      const select = event.target.closest('select[data-filter]');
      if (!select) return;
      state.incidentFilters[select.dataset.filter] = select.value;
      renderAll();
    });
    content.addEventListener('keydown', (event) => {
      const row = event.target.closest('tr[data-incident-id]');
      if (row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openDrawer(row.dataset.incidentId);
      }
    });

    document.getElementById('drawer').addEventListener('click', (event) => {
      if (event.target.closest('[data-action="close-drawer"]')) closeDrawer();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.openMenu) {
        const menuKey = state.openMenu;
        state.openMenu = null;
        renderScope();
        document.querySelector('[data-menu-trigger="' + menuKey + '"]').focus();
      } else if (state.drawerIncidentId) {
        closeDrawer();
      }
    });

    window.addEventListener('hashchange', () => {
      state.drawerIncidentId = null;
      state.openMenu = null;
      document.getElementById('content').scrollTop = 0;
      renderAll();
    });

    let resizeFrame = null;
    window.addEventListener('resize', () => {
      if (currentPageKey() !== 'overview') return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => renderTrendChart(latestModel.trend));
    });
  }

  renderSidebarUser();
  bindEvents();
  renderAll();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (currentPageKey() === 'overview') renderTrendChart(latestModel.trend);
    });
  }

  window.setTimeout(() => {
    state.liveEventDue = true;
    deliverLiveEventIfDue();
  }, data.liveEvent.delayMs);
})();

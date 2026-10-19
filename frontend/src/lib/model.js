/*
 * Every figure the dashboard shows is derived here from the loaded data.
 * createDerivations binds the helpers to one dataset; deriveModel builds
 * everything a page needs for the selected period.
 */
import {
  addDays, byTime, datesBetween, daysInMonthOf, firstOfPreviousMonth, formatDay, formatMinutes,
  mondayOf, newestFirst, parseDate, toMinutes,
} from './dates.js';
import { MINUS, mean, median } from './format.js';

const RECENT_INCIDENT_LIMIT = 5;
const PERIODS = ['today', 'week', 'month'];

export function isHighRisk(incident) {
  return incident.severity === 'Critical' || incident.severity === 'High';
}

export function shiftContains(shift, time) {
  const minute = toMinutes(time);
  const start = toMinutes(shift.start);
  const end = toMinutes(shift.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function createDerivations(data) {
  const today = data.clock.date;
  const clockTime = data.clock.time;
  const recordsByDate = new Map(data.dailyRecords.map((record) => [record.date, record]));
  const violationTypeByName = new Map(data.violationTypes.map((type) => [type.name, type]));

  function deductionOf(incident) {
    return data.severities[incident.severity].deduction;
  }

  function severityRankOfType(typeName) {
    return data.severities[violationTypeByName.get(typeName).severity].rank;
  }

  function isPpeViolation(incident) {
    return violationTypeByName.get(incident.type).isPpe;
  }

  function scoreFor(incidents) {
    return Math.max(0, 100 - incidents.reduce((total, incident) => total + deductionOf(incident), 0));
  }

  function incidentsOn(dateKey) {
    const record = recordsByDate.get(dateKey);
    if (!record) return [];
    return record.incidents.map((incident) => ({ date: dateKey, ...incident })).sort(byTime);
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
    return Array.from(groups.values()).sort((a, b) =>
      b.count - a.count ||
      severityRankOfType(b.name) - severityRankOfType(a.name) ||
      (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  }

  function leadingViolation(incidents) {
    return rankViolationTypes(incidents)[0] || null;
  }

  function shiftOf(time) {
    return data.shifts.find((shift) => shiftContains(shift, time));
  }

  function periodWindow(period) {
    if (period === 'week') {
      const monday = mondayOf(today);
      return {
        dates: datesBetween(monday, today),
        previousDates: datesBetween(addDays(monday, -7), addDays(today, -7)),
        deltaLabel: 'vs same point last week',
      };
    }
    if (period === 'month') {
      const firstOfMonth = today.slice(0, 8) + '01';
      const previousFirst = firstOfPreviousMonth(today);
      const samePointDay = Math.min(parseDate(today).getUTCDate(), daysInMonthOf(previousFirst));
      return {
        dates: datesBetween(firstOfMonth, today),
        previousDates: datesBetween(previousFirst, addDays(previousFirst, samePointDay - 1)),
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
    const sparkDates = datesBetween(addDays(today, -6), today);
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
      complianceRate: peopleObserved ? ((peopleCompliant / peopleObserved) * 100).toFixed(1) : MINUS,
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
      return {
        name: shift.name,
        hours: shift.start + ' to ' + shift.end,
        score: periodScore(window.dates, inShift),
        inProgress: shiftContains(shift, clockTime),
        ...summarise(incidents.filter(inShift)),
      };
    });
  }

  function deriveZones(window, incidents) {
    return data.zones
      .map((zone) => {
        const inZone = (incident) => incident.zone === zone.name;
        return {
          name: zone.name,
          cameras: zone.cameras,
          score: periodScore(window.dates, inZone),
          ...summarise(incidents.filter(inZone)),
        };
      })
      .sort((a, b) => a.score - b.score || b.count - a.count);
  }

  function deriveRanking(period, siteScore) {
    const rows = data.sites
      .map((site) => ({
        id: site.id,
        name: site.name,
        score: site.id === data.currentSiteId ? siteScore : site.scores[period],
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
      const shift = shiftOf(incident.time);
      return { scoreAfter: runningScore, shift: shift ? shift.name : MINUS, ...incident };
    });
  }

  function findIncident(incidentId) {
    for (const dateKey of recordsByDate.keys()) {
      const match = incidentsWithContext(dateKey).find((incident) => incident.id === incidentId);
      if (match) return match;
    }
    return null;
  }

  function deriveTrend(period) {
    if (period === 'today') {
      const nowMinute = toMinutes(clockTime);
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
        periodLabel: formatDay(today) + ' 00:00 to ' + clockTime,
      };
    }

    let slotDates;
    let previousSlotDates;
    let xTickIndexes;
    let periodLabel;
    if (period === 'week') {
      const monday = mondayOf(today);
      slotDates = datesBetween(monday, addDays(monday, 6));
      previousSlotDates = slotDates.map((dateKey) => addDays(dateKey, -7));
      xTickIndexes = [0, 1, 2, 3, 4, 5, 6];
      periodLabel = formatDay(slotDates[0], { month: false }) + ' to ' + formatDay(slotDates[6]);
    } else {
      const firstOfMonth = today.slice(0, 8) + '01';
      slotDates = datesBetween(firstOfMonth, addDays(firstOfMonth, daysInMonthOf(today) - 1));
      const previousFirst = firstOfPreviousMonth(today);
      previousSlotDates = datesBetween(previousFirst, addDays(previousFirst, daysInMonthOf(previousFirst) - 1));
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
    const rows = data.sites.map((site) => {
      const scores = {};
      PERIODS.forEach((period) => {
        scores[period] = site.id === data.currentSiteId ? periodScore(periodWindow(period).dates) : site.scores[period];
      });
      return { id: site.id, name: site.name, scores };
    }).sort((a, b) => b.scores.today - a.scores.today);
    const summary = (reduce) => {
      const values = {};
      PERIODS.forEach((period) => { values[period] = Math.round(reduce(rows.map((row) => row.scores[period]))); });
      return values;
    };
    return { rows, average: summary(mean), median: summary(median) };
  }

  function deriveModel(period) {
    const window = periodWindow(period);
    const incidents = window.dates.flatMap(incidentsOn);
    const kpis = deriveKpis(window, incidents);
    const todaysIncidents = incidentsOn(today);
    return {
      window,
      incidents,
      periodIncidents: window.dates.flatMap(incidentsWithContext).sort(newestFirst),
      cameras: deriveCameras(incidents),
      siteComparison: deriveSiteComparison(),
      kpis,
      trend: deriveTrend(period),
      types: deriveTypes(incidents),
      shifts: deriveShifts(window, incidents),
      zones: deriveZones(window, incidents),
      ranking: deriveRanking(period, kpis.score),
      recent: incidentsWithContext(today).reverse().slice(0, RECENT_INCIDENT_LIMIT),
      live: {
        camerasOnline: data.cameras.filter((camera) => camera.online).length,
        cameraCount: data.cameras.length,
        lastEventTime: todaysIncidents.length ? todaysIncidents[todaysIncidents.length - 1].time : null,
      },
    };
  }

  return { deriveModel, dayScore, deductionOf, findIncident };
}

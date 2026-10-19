import { useLayoutEffect, useRef, useState } from 'react';
import { formatDay, formatMinutes } from '../lib/dates.js';

const HEIGHT = 220;
const MARGIN = { top: 8, right: 36, bottom: 24, left: 0 };

// Builds the SVG marks and a hover lookup for a chart of the given width.
function layout(trend, width) {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const plotRight = MARGIN.left + plotWidth;
  const plotBottom = MARGIN.top + plotHeight;
  const y = (score) => MARGIN.top + (1 - score / 100) * plotHeight;
  const xAt = (position) => MARGIN.left + position * plotWidth;

  const marks = [];
  [0, 25, 50, 75, 100].forEach((value) => {
    if (value > 0 && value < 100) {
      marks.push(<line key={'grid-' + value} x1={MARGIN.left} x2={plotRight} y1={y(value)} y2={y(value)} stroke="var(--border)" shapeRendering="crispEdges" />);
    }
    marks.push(<text key={'y-' + value} className="chart-axis-label" x={width} y={y(value) + 4} textAnchor="end">{value}</text>);
  });
  marks.push(<line key="baseline" x1={MARGIN.left} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke="var(--border-strong)" shapeRendering="crispEdges" />);

  trend.xTicks.forEach((tick, index) => {
    const anchor = index === 0 ? 'start' : index === trend.xTicks.length - 1 && tick.position === 1 ? 'end' : 'middle';
    marks.push(<text key={'x-' + index} className="chart-axis-label" x={xAt(tick.position)} y={HEIGHT - 4} textAnchor={anchor}>{tick.label}</text>);
  });

  let pointAt;
  if (trend.kind === 'step') {
    const xMinute = (minute) => xAt(minute / 1440);
    const stepPath = (steps, endMinute) => {
      let path = 'M' + xMinute(steps[0].minute) + ',' + y(steps[0].score);
      steps.slice(1).forEach((step) => { path += 'H' + xMinute(step.minute) + 'V' + y(step.score); });
      return path + 'H' + xMinute(endMinute);
    };
    marks.push(<path key="previous" d={stepPath(trend.previous, 1440)} fill="none" stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" />);
    marks.push(<path key="current" d={stepPath(trend.current, trend.endMinute)} fill="none" stroke="var(--accent)" strokeWidth="1.5" />);
    trend.current.slice(1).forEach((step, index) => {
      const colour = step.severity === 'Critical' ? 'var(--critical)' : step.severity === 'High' ? 'var(--high)' : 'var(--text-3)';
      const tickX = xMinute(step.minute);
      marks.push(<line key={'tick-' + index} x1={tickX} x2={tickX} y1={y(step.score) + 4} y2={y(step.score) + 11} stroke={colour} strokeWidth="2" />);
    });
    const lastStep = trend.current[trend.current.length - 1];
    marks.push(<circle key="last" cx={xMinute(trend.endMinute)} cy={y(lastStep.score)} r="3" fill="var(--accent)" />);

    pointAt = (offsetX) => {
      const minute = Math.round(Math.max(0, Math.min(trend.endMinute, ((offsetX - MARGIN.left) / plotWidth) * 1440)));
      const step = trend.current.filter((candidate) => candidate.minute <= minute).pop();
      return { x: xMinute(minute), title: formatMinutes(minute), score: step.score, count: step.count };
    };
  } else {
    const xIndex = (index) => xAt(index / (trend.slotCount - 1));
    const linePath = (points) => points.map((point, index) => (index ? 'L' : 'M') + xIndex(point.index) + ',' + y(point.score)).join('');
    marks.push(<path key="previous" d={linePath(trend.previous)} fill="none" stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" />);
    marks.push(<path key="current" d={linePath(trend.current)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />);
    if (trend.slotCount <= 7) {
      trend.current.forEach((point) => {
        marks.push(<circle key={'point-' + point.index} cx={xIndex(point.index)} cy={y(point.score)} r="2" fill="var(--accent)" />);
      });
    }
    const lastPoint = trend.current[trend.current.length - 1];
    marks.push(<circle key="last" cx={xIndex(lastPoint.index)} cy={y(lastPoint.score)} r="3" fill="var(--accent)" />);

    pointAt = (offsetX) => {
      const rawIndex = Math.round(((offsetX - MARGIN.left) / plotWidth) * (trend.slotCount - 1));
      const point = trend.current[Math.max(0, Math.min(lastPoint.index, rawIndex))];
      return { x: xIndex(point.index), title: formatDay(point.dateKey), score: point.score, count: point.count };
    };
  }

  return { marks, pointAt, plotWidth, plotHeight, plotBottom };
}

export default function TrendChart({ trend }) {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);

  // Track the content width so the chart redraws on resize.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Place the tooltip to the right of the crosshair, or to the left when it would overflow.
  useLayoutEffect(() => {
    if (!hover) return;
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    const paddingLeft = parseFloat(getComputedStyle(container).paddingLeft);
    const preferredLeft = paddingLeft + hover.x + 12;
    const left = preferredLeft + tooltip.offsetWidth > container.clientWidth - 8 ? paddingLeft + hover.x - tooltip.offsetWidth - 12 : preferredLeft;
    tooltip.style.left = left + 'px';
  }, [hover]);

  const chart = width > 0 ? layout(trend, width) : null;

  return (
    <div className="chart" ref={containerRef}>
      {chart && (
        <svg width={width} height={HEIGHT} role="img" aria-label="Safety score trend">
          {chart.marks}
          <line
            className="chart-crosshair"
            x1={hover ? hover.x : 0} x2={hover ? hover.x : 0} y1={MARGIN.top} y2={chart.plotBottom}
            stroke="var(--border-strong)" visibility={hover ? 'visible' : 'hidden'} shapeRendering="crispEdges"
          />
          <rect
            className="chart-hit-area"
            x={MARGIN.left} y={MARGIN.top} width={chart.plotWidth} height={chart.plotHeight} fill="transparent"
            onMouseMove={(event) => {
              const svgBox = event.currentTarget.ownerSVGElement.getBoundingClientRect();
              setHover(chart.pointAt(event.clientX - svgBox.left));
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      <div className={'chart-tooltip' + (hover ? ' is-visible' : '')} aria-hidden="true" ref={tooltipRef}>
        {hover && (
          <>
            <div className="chart-tooltip-title mono">{hover.title}</div>
            <div className="chart-tooltip-row"><span>Score</span><span className="mono">{hover.score}</span></div>
            <div className="chart-tooltip-row"><span>Incidents</span><span className="mono">{hover.count}</span></div>
          </>
        )}
      </div>
    </div>
  );
}

import React, { useMemo, useRef, useState } from 'react';
import { DynoRunData, VisibleSeriesConfig } from '../core/types';

interface DynoChartProps {
  runs: DynoRunData[];
  visibleSeries: VisibleSeriesConfig;
  userInfo: string;
  watermarkDataUrl: string;
  exportTriggerRef: React.MutableRefObject<(() => void) | null>;
}

interface SeriesDescriptor {
  key: string;
  label: string;
  unit: string;
  axis: 'power' | 'torque';
  color: string;
  dash: string;
  strokeWidth: number;
  points: Array<{ x: number; y: number }>;
}

const SERIES_COLORS = {
  powerTotal: '#dc2626',   // Red (matches QColorConstants::Red)
  torque: '#2563eb',       // Blue (matches QColorConstants::Blue)
  losses: '#16a34a',       // Green (matches QColorConstants::Green)
  powerWheel: '#15803d',   // DarkGreen (matches QColorConstants::DarkGreen)
  powerRaw: '#ca8a04',     // DarkYellow (matches QColorConstants::DarkYellow)
  lossesRaw: '#c026d3',    // Magenta (matches QColorConstants::Magenta)
};

function getRunPenStyle(colorIndex: number): { dash: string; strokeWidth: number } {
  if (colorIndex === 0) return { dash: '', strokeWidth: 2.5 };
  if (colorIndex === 1) return { dash: '', strokeWidth: 1.5 };
  return { dash: '6 4', strokeWidth: 1.6 };
}

/**
 * Linearly interpolates Y at target X from a sorted or monotonic list of points.
 */
export function interpolateAtX(points: Array<{ x: number; y: number }>, targetX: number): number | null {
  if (points.length === 0) return null;
  // Sort a copy by X ascending to guarantee reliable lookup even if GPS jittered slightly
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (targetX < sorted[0].x || targetX > sorted[sorted.length - 1].x) {
    return null;
  }
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i].x - targetX) < 1e-4) {
      return sorted[i].y;
    }
    if (i > 0 && sorted[i - 1].x <= targetX && sorted[i].x >= targetX) {
      const dx = sorted[i].x - sorted[i - 1].x;
      if (Math.abs(dx) < 1e-6) return sorted[i].y;
      return sorted[i - 1].y + ((sorted[i].y - sorted[i - 1].y) / dx) * (targetX - sorted[i - 1].x);
    }
  }
  return null;
}

/**
 * Builds a smooth Catmull-Rom / cubic Bezier SVG path through the given pixel points.
 */
function buildSmoothSvgPath(pts: Array<{ px: number; py: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].px.toFixed(1)} ${pts[0].py.toFixed(1)}`;
  if (pts.length === 2) {
    return `M ${pts[0].px.toFixed(1)} ${pts[0].py.toFixed(1)} L ${pts[1].px.toFixed(1)} ${pts[1].py.toFixed(1)}`;
  }

  let d = `M ${pts[0].px.toFixed(1)} ${pts[0].py.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const cp1x = p1.px + (p2.px - p0.px) / 6;
    const cp1y = p1.py + (p2.py - p0.py) / 6;
    const cp2x = p2.px - (p3.px - p1.px) / 6;
    const cp2y = p2.py - (p3.py - p1.py) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.px.toFixed(1)} ${p2.py.toFixed(1)}`;
  }
  return d;
}

export const DynoChart: React.FC<DynoChartProps> = ({
  runs,
  visibleSeries,
  userInfo,
  watermarkDataUrl,
  exportTriggerRef,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverRpm, setHoverRpm] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const viewWidth = 1200;
  const viewHeight = 560;
  const padLeft = 72;
  const padRight = 72;
  const padTop = 76;
  const padBottom = 54;
  const plotW = viewWidth - padLeft - padRight;
  const plotH = viewHeight - padTop - padBottom;

  const { minRpm, maxRpm, maxPower, maxTorque, allSeries } = useMemo(() => {
    let highestRpm = 3500;
    let lowestRpm = 1500;
    let highestPwr = 100;
    let highestTrq = 100;

    const seriesList: SeriesDescriptor[] = [];

    for (const run of runs) {
      const pen = getRunPenStyle(run.colorIndex);
      if (run.rpmMax > highestRpm) highestRpm = run.rpmMax;
      if (run.curvePoints.length > 0) {
        const firstRpm = run.curvePoints[0].rpm;
        if (firstRpm < lowestRpm) {
          lowestRpm = Math.max(500, Math.floor(firstRpm / 500) * 500);
        }
      }
      if (run.powerMaxKm > highestPwr) highestPwr = run.powerMaxKm;
      if (run.torqueMaxNm > highestTrq) highestTrq = run.torqueMaxNm;

      for (const pt of run.curvePoints) {
        if (visibleSeries.powerWheelRaw && pt.powerRawKm > highestPwr) {
          highestPwr = pt.powerRawKm;
        }
      }

      if (visibleSeries.power && run.curvePoints.length > 0) {
        seriesList.push({
          key: `${run.id}-power`,
          label: `${run.name} power`,
          unit: 'KM',
          axis: 'power',
          color: SERIES_COLORS.powerTotal,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.curvePoints.map((p) => ({ x: p.rpm, y: p.powerTotalKm })),
        });
      }

      if (visibleSeries.torque && run.curvePoints.length > 0) {
        seriesList.push({
          key: `${run.id}-torque`,
          label: `${run.name} torque`,
          unit: 'Nm',
          axis: 'torque',
          color: SERIES_COLORS.torque,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.curvePoints.map((p) => ({ x: p.rpm, y: p.torqueNm })),
        });
      }

      if (visibleSeries.losses && run.curvePoints.length > 0) {
        seriesList.push({
          key: `${run.id}-losses`,
          label: `${run.name} losses`,
          unit: 'KM',
          axis: 'power',
          color: SERIES_COLORS.losses,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.curvePoints.map((p) => ({ x: p.rpm, y: p.lossKm })),
        });
      }

      if (visibleSeries.powerWheel && run.curvePoints.length > 0) {
        seriesList.push({
          key: `${run.id}-powerWheel`,
          label: `${run.name} power (wheel)`,
          unit: 'KM',
          axis: 'power',
          color: SERIES_COLORS.powerWheel,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.curvePoints.map((p) => ({ x: p.rpm, y: p.powerWheelKm })),
        });
      }

      if (visibleSeries.powerWheelRaw && run.curvePoints.length > 0) {
        seriesList.push({
          key: `${run.id}-powerRaw`,
          label: `${run.name} power (raw)`,
          unit: 'KM',
          axis: 'power',
          color: SERIES_COLORS.powerRaw,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.curvePoints.map((p) => ({ x: p.rpm, y: p.powerRawKm })),
        });
      }

      if (visibleSeries.lossesRaw && run.lossRawPoints.length > 0) {
        seriesList.push({
          key: `${run.id}-lossesRaw`,
          label: `${run.name} losses (raw)`,
          unit: 'KM',
          axis: 'power',
          color: SERIES_COLORS.lossesRaw,
          dash: pen.dash,
          strokeWidth: pen.strokeWidth,
          points: run.lossRawPoints.map((p) => ({ x: p.rpm, y: p.lossRawKm })),
        });
      }
    }

    const computedMaxRpm = Math.floor(highestRpm / 500) * 500 + 500;
    const computedMaxPower = Math.ceil((highestPwr + 40) / 20) * 20;
    const computedMaxTorque = Math.ceil((highestTrq + 40) / 20) * 20;

    return {
      minRpm: lowestRpm,
      maxRpm: Math.max(4000, computedMaxRpm),
      maxPower: Math.max(100, computedMaxPower),
      maxTorque: Math.max(100, computedMaxTorque),
      allSeries: seriesList,
    };
  }, [runs, visibleSeries]);

  const rpmToX = (rpm: number) =>
    padLeft + ((rpm - minRpm) / Math.max(1, maxRpm - minRpm)) * plotW;
  const powerToY = (pwr: number) =>
    padTop + plotH - (pwr / Math.max(1, maxPower)) * plotH;
  const torqueToY = (trq: number) =>
    padTop + plotH - (trq / Math.max(1, maxTorque)) * plotH;

  // Export 1280x720 PNG image with optional watermark (matches WndMain::_exportImage)
  exportTriggerRef.current = () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgRef.current);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);

      const triggerDownload = () => {
        const now = new Date();
        const stamp = now
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\..+/, '')
          .replace('T', '_');
        const link = document.createElement('a');
        link.download = `export_${stamp}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      };

      if (watermarkDataUrl) {
        const wm = new Image();
        wm.onload = () => {
          ctx.save();
          ctx.globalAlpha = 0.15;
          ctx.drawImage(
            wm,
            canvas.width / 2 - wm.width / 2,
            canvas.height / 2 - wm.height / 2
          );
          ctx.restore();
          triggerDownload();
        };
        wm.onerror = () => triggerDownload();
        wm.src = watermarkDataUrl;
      } else {
        triggerDownload();
      }
    };
    img.src = url;
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = viewWidth / rect.width;
    const scaleY = viewHeight / rect.height;
    const svgX = (e.clientX - rect.left) * scaleX;
    const svgY = (e.clientY - rect.top) * scaleY;

    if (
      svgX >= padLeft &&
      svgX <= padLeft + plotW &&
      svgY >= padTop &&
      svgY <= padTop + plotH
    ) {
      const rpm = minRpm + ((svgX - padLeft) / plotW) * (maxRpm - minRpm);
      setHoverRpm(rpm);
      setHoverPos({ x: svgX, y: svgY });
    } else {
      setHoverRpm(null);
      setHoverPos(null);
    }
  };

  const xTicks = Array.from({ length: 11 }, (_, i) =>
    Math.round(minRpm + (i * (maxRpm - minRpm)) / 10)
  );
  const yPowerTicks = Array.from({ length: 11 }, (_, i) =>
    Math.round((i * maxPower) / 10)
  );
  const yTorqueTicks = Array.from({ length: 11 }, (_, i) =>
    Math.round((i * maxTorque) / 10)
  );

  // Strip basic HTML tags for clean SVG header rendering while preserving line breaks
  const userInfoLines = userInfo
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="chart-wrapper">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        className="dyno-svg"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHoverRpm(null);
          setHoverPos(null);
        }}
      >
        <rect x={0} y={0} width={viewWidth} height={viewHeight} fill="#ffffff" rx={8} />

        {/* Run Summary Legend (Top Left — matches DynoChartViewRunInfo) */}
        {runs.map((run, idx) => {
          const pen = getRunPenStyle(run.colorIndex);
          const y = 20 + idx * 20;
          return (
            <g key={run.id} transform={`translate(${padLeft}, ${y})`}>
              <line
                x1={0}
                y1={-4}
                x2={24}
                y2={-4}
                stroke="#1e293b"
                strokeWidth={pen.strokeWidth}
                strokeDasharray={pen.dash || undefined}
              />
              <text x={32} y={0} fontSize={12.5} fontFamily="Inter, system-ui, sans-serif">
                <tspan fontWeight="700" fill="#0f172a">
                  {run.name.toUpperCase()}
                </tspan>
                <tspan dx={10} fontWeight="700" fill={SERIES_COLORS.powerTotal}>
                  Pwr {run.powerMaxKm.toFixed(1)} KM @ {run.powerMaxRpm} RPM
                </tspan>
                <tspan dx={12} fontWeight="700" fill={SERIES_COLORS.torque}>
                  Trq {run.torqueMaxNm.toFixed(1)} Nm @ {run.torqueMaxRpm} RPM
                </tspan>
              </text>
            </g>
          );
        })}

        {/* User Info Header (Top Right — matches _userInfoLabel) */}
        {userInfoLines.map((line, idx) => (
          <text
            key={idx}
            x={viewWidth - padRight}
            y={22 + idx * 17}
            textAnchor="end"
            fontSize={idx === 0 ? 13 : 11.5}
            fontWeight={idx === 0 ? '700' : '500'}
            fontStyle={idx > 0 ? 'italic' : 'normal'}
            fill={idx === 0 ? '#1d4ed8' : '#475569'}
            fontFamily="Inter, system-ui, sans-serif"
          >
            {line}
          </text>
        ))}

        {/* Plot Area Background */}
        <rect
          x={padLeft}
          y={padTop}
          width={plotW}
          height={plotH}
          fill="#f8fafc"
          stroke="#cbd5e1"
          strokeWidth={1}
        />

        {/* Horizontal Grid Lines & Left/Right Axis Labels */}
        {yPowerTicks.map((pwrVal, i) => {
          const y = powerToY(pwrVal);
          const trqVal = yTorqueTicks[i];
          return (
            <g key={`y-${i}`}>
              <line
                x1={padLeft}
                y1={y}
                x2={padLeft + plotW}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth={1}
              />
              {i < 10 && (
                <line
                  x1={padLeft}
                  y1={y - plotH / 20}
                  x2={padLeft + plotW}
                  y2={y - plotH / 20}
                  stroke="#f1f5f9"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              )}
              <text
                x={padLeft - 10}
                y={y + 4}
                textAnchor="end"
                fontSize={11.5}
                fill="#334155"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {pwrVal}
              </text>
              <text
                x={padLeft + plotW + 10}
                y={y + 4}
                textAnchor="start"
                fontSize={11.5}
                fill="#334155"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {trqVal}
              </text>
            </g>
          );
        })}

        {/* Vertical Grid Lines & RPM Axis Labels */}
        {xTicks.map((rpmVal, i) => {
          const x = rpmToX(rpmVal);
          return (
            <g key={`x-${i}`}>
              <line
                x1={x}
                y1={padTop}
                x2={x}
                y2={padTop + plotH}
                stroke="#e2e8f0"
                strokeWidth={1}
              />
              {i < 10 && (
                <line
                  x1={x + plotW / 20}
                  y1={padTop}
                  x2={x + plotW / 20}
                  y2={padTop + plotH}
                  stroke="#f1f5f9"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              )}
              <text
                x={x}
                y={padTop + plotH + 20}
                textAnchor="middle"
                fontSize={11.5}
                fill="#334155"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {rpmVal}
              </text>
            </g>
          );
        })}

        {/* Axis Titles */}
        <text
          x={padLeft + plotW / 2}
          y={viewHeight - 10}
          textAnchor="middle"
          fontSize={13}
          fontWeight="600"
          fill="#0f172a"
          fontFamily="Inter, system-ui, sans-serif"
        >
          Engine Speed [RPM]
        </text>
        <text
          transform={`translate(20, ${padTop + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={13}
          fontWeight="600"
          fill={SERIES_COLORS.powerTotal}
          fontFamily="Inter, system-ui, sans-serif"
        >
          Power [KM]
        </text>
        <text
          transform={`translate(${viewWidth - 18}, ${padTop + plotH / 2}) rotate(90)`}
          textAnchor="middle"
          fontSize={13}
          fontWeight="600"
          fill={SERIES_COLORS.torque}
          fontFamily="Inter, system-ui, sans-serif"
        >
          Torque [Nm]
        </text>

        {/* Clip Path so curves stay strictly inside the chart frame */}
        <defs>
          <clipPath id="dyno-plot-clip">
            <rect x={padLeft} y={padTop} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Data Series Curves */}
        <g clipPath="url(#dyno-plot-clip)">
          {allSeries.map((s) => {
            const pixelPts = s.points.map((pt) => ({
              px: rpmToX(pt.x),
              py: s.axis === 'power' ? powerToY(pt.y) : torqueToY(pt.y),
            }));
            const pathData = buildSmoothSvgPath(pixelPts);
            return (
              <path
                key={s.key}
                d={pathData}
                fill="none"
                stroke={s.color}
                strokeWidth={s.strokeWidth}
                strokeDasharray={s.dash || undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </g>

        {/* Empty State Overlay */}
        {runs.length === 0 && (
          <g>
            <text
              x={padLeft + plotW / 2}
              y={padTop + plotH / 2 - 10}
              textAnchor="middle"
              fontSize={16}
              fontWeight="600"
              fill="#64748b"
              fontFamily="Inter, system-ui, sans-serif"
            >
              No dyno run loaded yet
            </text>
            <text
              x={padLeft + plotW / 2}
              y={padTop + plotH / 2 + 16}
              textAnchor="middle"
              fontSize={13}
              fill="#94a3b8"
              fontFamily="Inter, system-ui, sans-serif"
            >
              Click &quot;Load Preset Demo&quot;, &quot;Start Simulated Pull&quot;, or &quot;Load .dyno File&quot; in the toolbar above.
            </text>
          </g>
        )}

        {/* Interactive Crosshair & Highlight Dots */}
        {hoverRpm !== null && hoverPos !== null && allSeries.length > 0 && (
          <g>
            <line
              x1={hoverPos.x}
              y1={padTop}
              x2={hoverPos.x}
              y2={padTop + plotH}
              stroke="#64748b"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            {allSeries.map((s) => {
              const val = interpolateAtX(s.points, hoverRpm);
              if (val === null) return null;
              const cy = s.axis === 'power' ? powerToY(val) : torqueToY(val);
              return (
                <circle
                  key={`dot-${s.key}`}
                  cx={hoverPos.x}
                  cy={cy}
                  r={4.5}
                  fill={s.color}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        )}
      </svg>

      {/* Auto-Sizing HTML Hover Tooltip Overlay (prevents text collision) */}
      {hoverRpm !== null && hoverPos !== null && allSeries.length > 0 && (
        <div
          className="dyno-hover-tooltip"
          style={{
            left:
              hoverPos.x > viewWidth * 0.58
                ? undefined
                : `${((hoverPos.x + 18) / viewWidth) * 100}%`,
            right:
              hoverPos.x > viewWidth * 0.58
                ? `${((viewWidth - hoverPos.x + 18) / viewWidth) * 100}%`
                : undefined,
            top: `${Math.min(78, Math.max(12, (hoverPos.y / viewHeight) * 100))}%`,
          }}
        >
          <div className="dyno-tooltip-header">RPM: {Math.round(hoverRpm)}</div>
          <div className="dyno-tooltip-grid">
            {allSeries.map((s) => {
              const val = interpolateAtX(s.points, hoverRpm);
              const valueText = val !== null ? `${val.toFixed(1)} ${s.unit}` : '—';
              return (
                <React.Fragment key={`tip-${s.key}`}>
                  <span
                    className="dyno-tooltip-swatch"
                    style={{
                      borderTopColor: s.color,
                      borderTopWidth: `${Math.max(2, s.strokeWidth)}px`,
                      borderTopStyle: s.dash ? 'dashed' : 'solid',
                    }}
                  />
                  <span className="dyno-tooltip-label">{s.label}</span>
                  <span className="dyno-tooltip-value">{valueText}</span>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

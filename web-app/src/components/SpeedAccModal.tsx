import React from 'react';
import { X } from 'lucide-react';
import { DynoRunData } from '../core/types';

interface SpeedAccModalProps {
  isOpen: boolean;
  onClose: () => void;
  runs: DynoRunData[];
}

export const SpeedAccModal: React.FC<SpeedAccModalProps> = ({
  isOpen,
  onClose,
  runs,
}) => {
  if (!isOpen) return null;

  const viewW = 920;
  const viewH = 440;
  const padL = 64;
  const padR = 64;
  const padT = 36;
  const padB = 48;
  const plotW = viewW - padL - padR;
  const plotH = viewH - padT - padB;

  let maxTime = 40;
  let maxSpeed = 150;
  const minAcc = -5;
  const maxAcc = 7;

  for (const r of runs) {
    for (const pt of r.timePoints) {
      if (pt.time > maxTime) maxTime = Math.ceil(pt.time / 10) * 10;
      if (pt.speedKmh > maxSpeed) maxSpeed = Math.ceil((pt.speedKmh + 10) / 20) * 20;
    }
  }

  const timeToX = (t: number) => padL + (t / Math.max(1, maxTime)) * plotW;
  const speedToY = (v: number) => padT + plotH - (v / Math.max(1, maxSpeed)) * plotH;
  const accToY = (a: number) =>
    padT + plotH - ((a - minAcc) / (maxAcc - minAcc)) * plotH;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Speed &amp; Acceleration vs. Time</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <svg viewBox={`0 0 ${viewW} ${viewH}`} className="speed-acc-svg">
            <rect x={0} y={0} width={viewW} height={viewH} fill="#ffffff" rx={6} />
            <rect
              x={padL}
              y={padT}
              width={plotW}
              height={plotH}
              fill="#f8fafc"
              stroke="#cbd5e1"
            />

            {/* Zero acceleration line */}
            <line
              x1={padL}
              y1={accToY(0)}
              x2={padL + plotW}
              y2={accToY(0)}
              stroke="#94a3b8"
              strokeDasharray="4 4"
            />

            {/* Y ticks */}
            {Array.from({ length: 11 }, (_, i) => {
              const spd = Math.round((i * maxSpeed) / 10);
              const acc = minAcc + (i * (maxAcc - minAcc)) / 10;
              const y = speedToY(spd);
              return (
                <g key={i}>
                  <line
                    x1={padL}
                    y1={y}
                    x2={padL + plotW}
                    y2={y}
                    stroke="#e2e8f0"
                  />
                  <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#334155">
                    {spd}
                  </text>
                  <text
                    x={padL + plotW + 8}
                    y={y + 4}
                    textAnchor="start"
                    fontSize={11}
                    fill="#334155"
                  >
                    {acc.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* X ticks */}
            {Array.from({ length: 11 }, (_, i) => {
              const t = (i * maxTime) / 10;
              const x = timeToX(t);
              return (
                <g key={i}>
                  <line
                    x1={x}
                    y1={padT}
                    x2={x}
                    y2={padT + plotH}
                    stroke="#e2e8f0"
                  />
                  <text
                    x={x}
                    y={padT + plotH + 18}
                    textAnchor="middle"
                    fontSize={11}
                    fill="#334155"
                  >
                    {t.toFixed(0)}s
                  </text>
                </g>
              );
            })}

            {/* Curves */}
            {runs.map((run) => {
              if (run.timePoints.length < 2) return null;
              const dash = run.colorIndex === 2 ? '6 4' : undefined;
              const width = run.colorIndex === 0 ? 2.2 : 1.4;

              const speedPath = run.timePoints
                .map(
                  (pt, idx) =>
                    `${idx === 0 ? 'M' : 'L'} ${timeToX(pt.time).toFixed(1)} ${speedToY(
                      pt.speedKmh
                    ).toFixed(1)}`
                )
                .join(' ');

              const accPath = run.timePoints
                .map(
                  (pt, idx) =>
                    `${idx === 0 ? 'M' : 'L'} ${timeToX(pt.time).toFixed(1)} ${accToY(
                      pt.accFiltered
                    ).toFixed(1)}`
                )
                .join(' ');

              return (
                <g key={run.id}>
                  <path
                    d={speedPath}
                    fill="none"
                    stroke="#0284c7"
                    strokeWidth={width}
                    strokeDasharray={dash}
                  />
                  <path
                    d={accPath}
                    fill="none"
                    stroke="#ea580c"
                    strokeWidth={width}
                    strokeDasharray={dash}
                  />
                </g>
              );
            })}

            <text
              x={padL + plotW / 2}
              y={viewH - 10}
              textAnchor="middle"
              fontSize={12.5}
              fontWeight="600"
              fill="#0f172a"
            >
              Time [s]
            </text>
            <text
              transform={`translate(18, ${padT + plotH / 2}) rotate(-90)`}
              textAnchor="middle"
              fontSize={12.5}
              fontWeight="600"
              fill="#0284c7"
            >
              Speed [km/h]
            </text>
            <text
              transform={`translate(${viewW - 14}, ${padT + plotH / 2}) rotate(90)`}
              textAnchor="middle"
              fontSize={12.5}
              fontWeight="600"
              fill="#ea580c"
            >
              Acceleration [m/s²]
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
};

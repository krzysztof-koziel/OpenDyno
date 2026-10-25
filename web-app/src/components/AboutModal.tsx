import React from 'react';
import { CheckCircle2, Cpu, X } from 'lucide-react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>About OpenDyno (Modern Web Edition)</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body about-content">
          <div className="about-hero">
            <Cpu size={28} className="text-primary" />
            <div>
              <h4>OpenDyno — Mobile GPS Car Road Dynamometer</h4>
              <p className="text-muted">
                MIT Licensed • Hardware: STM32F103C8 + u-blox M10N GNSS (4 Hz) • Web App: React + TypeScript + Web Serial API
              </p>
            </div>
          </div>

          <h5>Bug Fixes &amp; Improvements over Original Qt6 C++ App</h5>
          <ul className="fix-list">
            <li>
              <CheckCircle2 size={15} />
              <span>
                <strong>Kalman Filter Initialization:</strong> Fixed uninitialized state variables in{' '}
                <code>_accFilter</code> and corrected the state-covariance update equation.
              </span>
            </li>
            <li>
              <CheckCircle2 size={15} />
              <span>
                <strong>Lossless Save &amp; Recalculation:</strong> Preserves raw GPS speed separately from Kalman-filtered speed so saving/loading <code>.dyno</code> files or updating vehicle weight/RPM ratio never double-filters the signal.
              </span>
            </li>
            <li>
              <CheckCircle2 size={15} />
              <span>
                <strong>Safe Coast-Down Exponential Regression:</strong> Filters out positive noise spikes before <code>Math.log(lossKw)</code> to prevent <code>NaN</code> poisoning of total power and torque curves.
              </span>
            </li>
            <li>
              <CheckCircle2 size={15} />
              <span>
                <strong>30 km/h Start Threshold &amp; Per-Run State:</strong> Fixed <code>speed &gt;= 0.0f</code> bug that triggered runs while stationary and removed cross-run <code>static</code> state bugs.
              </span>
            </li>
            <li>
              <CheckCircle2 size={15} />
              <span>
                <strong>DIN 70020 Atmospheric Correction:</strong> Uses ambient temperature (°C) and pressure (hPa) to compute standard atmospheric power correction.
              </span>
            </li>
          </ul>

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

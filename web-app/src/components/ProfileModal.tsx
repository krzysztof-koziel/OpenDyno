import React, { useEffect, useState } from 'react';
import { Gauge, X } from 'lucide-react';
import {
  calculateDin70020Correction,
  calculateRpmRatio,
} from '../core/dynoRunResult';
import { VehicleProfile } from '../core/types';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: VehicleProfile;
  currentGpsSpeedKmh: number;
  onSave: (profile: VehicleProfile) => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  profile,
  currentGpsSpeedKmh,
  onSave,
}) => {
  const [weight, setWeight] = useState(profile.weight);
  const [rpmRatio, setRpmRatio] = useState(profile.rpmRatio);
  const [airTemp, setAirTemp] = useState(profile.airTemp);
  const [airPress, setAirPress] = useState(profile.airPress);

  // Calibration sub-panel state (fixes division-by-zero when speed is 0)
  const [showCalibrate, setShowCalibrate] = useState(false);
  const [calRpm, setCalRpm] = useState(3000);
  const [calSpeed, setCalSpeed] = useState(currentGpsSpeedKmh > 1 ? currentGpsSpeedKmh : 69.0);
  const [useLiveGpsSpeed, setUseLiveGpsSpeed] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setWeight(profile.weight);
      setRpmRatio(profile.rpmRatio);
      setAirTemp(profile.airTemp);
      setAirPress(profile.airPress);
      setShowCalibrate(false);
    }
  }, [isOpen, profile]);

  useEffect(() => {
    if (useLiveGpsSpeed && currentGpsSpeedKmh > 0) {
      setCalSpeed(Number(currentGpsSpeedKmh.toFixed(1)));
    }
  }, [useLiveGpsSpeed, currentGpsSpeedKmh]);

  if (!isOpen) return null;

  const dinFactor = calculateDin70020Correction(airTemp, airPress);
  const previewRatio = calculateRpmRatio(calRpm, calSpeed);

  const handleApplyCalibration = () => {
    if (previewRatio > 0) {
      setRpmRatio(Number(previewRatio.toFixed(6)));
      setShowCalibrate(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      weight: Math.max(1, Math.min(9999, Math.round(weight))),
      rpmRatio: Math.max(0.1, Math.min(3000, Number(rpmRatio))),
      airTemp: Math.max(-30, Math.min(60, Number(airTemp))),
      airPress: Math.max(800, Math.min(1150, Math.round(airPress))),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Vehicle Profile &amp; Calibration</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body form-grid">
          <label className="form-row">
            <span>Vehicle Weight [kg]</span>
            <input
              type="number"
              min={1}
              max={9999}
              step={1}
              value={weight}
              onChange={(e) => setWeight(Number(e.target.value))}
              required
            />
          </label>

          <div className="form-row">
            <span>RPM / Speed Ratio [RPM per km/h]</span>
            <div className="input-with-btn">
              <input
                type="number"
                min={0.1}
                max={3000}
                step="0.000001"
                value={rpmRatio}
                onChange={(e) => setRpmRatio(Number(e.target.value))}
                required
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowCalibrate((s) => !s)}
              >
                <Gauge size={15} />
                Calibrate
              </button>
            </div>
          </div>

          {showCalibrate && (
            <div className="calibrate-box">
              <div className="calibrate-title">
                RPM Ratio Calibration (Drive at steady RPM in your test gear)
              </div>
              <div className="calibrate-grid">
                <label>
                  <span>Engine RPM</span>
                  <input
                    type="number"
                    min={500}
                    max={9000}
                    step={100}
                    value={calRpm}
                    onChange={(e) => setCalRpm(Number(e.target.value))}
                  />
                </label>
                <label>
                  <span>Vehicle Speed [km/h]</span>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    step={0.1}
                    value={calSpeed}
                    disabled={useLiveGpsSpeed}
                    onChange={(e) => setCalSpeed(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={useLiveGpsSpeed}
                  onChange={(e) => setUseLiveGpsSpeed(e.target.checked)}
                />
                <span>Use live GPS speed ({currentGpsSpeedKmh.toFixed(1)} km/h)</span>
              </label>
              <div className="calibrate-footer">
                <span>
                  Calculated Ratio:{' '}
                  <strong>
                    {previewRatio > 0 ? previewRatio.toFixed(4) : 'Invalid (Speed must be > 0)'}
                  </strong>
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={previewRatio <= 0}
                  onClick={handleApplyCalibration}
                >
                  Apply Ratio
                </button>
              </div>
            </div>
          )}

          <label className="form-row">
            <span>Air Temperature [°C]</span>
            <input
              type="number"
              min={-30}
              max={60}
              step={0.5}
              value={airTemp}
              onChange={(e) => setAirTemp(Number(e.target.value))}
              required
            />
          </label>

          <label className="form-row">
            <span>Atmospheric Pressure [hPa]</span>
            <input
              type="number"
              min={850}
              max={1100}
              step={1}
              value={airPress}
              onChange={(e) => setAirPress(Number(e.target.value))}
              required
            />
          </label>

          <div className="info-banner">
            DIN 70020 Atmospheric Correction Factor:{' '}
            <strong>{dinFactor.toFixed(4)}x</strong> (Reference: 20.0 °C, 1013 hPa)
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Save &amp; Recalculate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

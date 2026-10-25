import React, { useEffect, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { DynoSettingsConfig } from '../core/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: DynoSettingsConfig;
  onSave: (settings: DynoSettingsConfig) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
}) => {
  const [lossTime, setLossTime] = useState(settings.lossTime);
  const [startSpeedKmh, setStartSpeedKmh] = useState(settings.startSpeedKmh);
  const [correctionFactor, setCorrectionFactor] = useState(settings.correctionFactor);
  const [useAtmosphericCorrection, setUseAtmosphericCorrection] = useState(
    settings.useAtmosphericCorrection
  );
  const [filterPower, setFilterPower] = useState(settings.filterPower);
  const [userInfo, setUserInfo] = useState(settings.userInfo);
  const [watermarkDataUrl, setWatermarkDataUrl] = useState(settings.watermarkDataUrl);

  useEffect(() => {
    if (isOpen) {
      setLossTime(settings.lossTime);
      setStartSpeedKmh(settings.startSpeedKmh);
      setCorrectionFactor(settings.correctionFactor);
      setUseAtmosphericCorrection(settings.useAtmosphericCorrection);
      setFilterPower(settings.filterPower);
      setUserInfo(settings.userInfo);
      setWatermarkDataUrl(settings.watermarkDataUrl);
    }
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleWatermarkFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setWatermarkDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      lossTime: Math.max(5, Math.min(45, Math.round(lossTime))),
      startSpeedKmh: Math.max(0, Math.min(120, Number(startSpeedKmh))),
      correctionFactor: Math.max(0.5, Math.min(1.5, Number(correctionFactor))),
      useAtmosphericCorrection,
      filterPower: Math.max(0.5, Math.min(15, Number(filterPower))),
      userInfo,
      watermarkDataUrl,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Dyno Settings</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body form-grid">
          <label className="form-row">
            <span>Coast-down loss measurement time [s]</span>
            <input
              type="number"
              min={5}
              max={45}
              step={1}
              value={lossTime}
              onChange={(e) => setLossTime(Number(e.target.value))}
            />
          </label>

          <label className="form-row">
            <span>Run start trigger speed [km/h] (Fixes 0 km/h bug)</span>
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              value={startSpeedKmh}
              onChange={(e) => setStartSpeedKmh(Number(e.target.value))}
            />
          </label>

          <label className="form-row">
            <span>Manual Correction Factor (0.50 – 1.50)</span>
            <input
              type="number"
              min={0.5}
              max={1.5}
              step={0.01}
              value={correctionFactor}
              onChange={(e) => setCorrectionFactor(Number(e.target.value))}
            />
          </label>

          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={useAtmosphericCorrection}
              onChange={(e) => setUseAtmosphericCorrection(e.target.checked)}
            />
            <span>
              Apply DIN 70020 Atmospheric Correction from Vehicle Profile Temperature &amp; Pressure
            </span>
          </label>

          <label className="form-row">
            <span>Kalman Filter Power (Acceleration process noise: 0.5 – 10.0)</span>
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.1}
              value={filterPower}
              onChange={(e) => setFilterPower(Number(e.target.value))}
            />
          </label>

          <label className="form-row">
            <span>Chart Header / User Info (HTML or plain text)</span>
            <textarea
              rows={3}
              value={userInfo}
              onChange={(e) => setUserInfo(e.target.value)}
            />
          </label>

          <div className="form-row">
            <span>PNG Export Watermark Image (optional)</span>
            <div className="input-with-btn">
              <label className="btn btn-secondary file-label">
                <Upload size={15} />
                Choose PNG...
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleWatermarkFile}
                  hidden
                />
              </label>
              {watermarkDataUrl && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setWatermarkDataUrl('')}
                >
                  Clear Watermark
                </button>
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Apply Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

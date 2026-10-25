import { describe, expect, it } from 'vitest';
import {
  calculateDin70020Correction,
  calculateRpmRatio,
  calculateTorqueNm,
  DynoRunProcessor,
  parseDynoFile,
  serializeDynoFile,
} from '../dynoRunResult';
import { KalmanFilter } from '../kalmanFilter';
import { parseBoardLine, SerialLineBuffer } from '../serialProtocol';
import { DEMO_PRESETS, generateSyntheticRunSamples } from '../simulator';
import { DynoSettingsConfig, GpsFixType, VehicleProfile } from '../types';

const TEST_PROFILE: VehicleProfile = {
  weight: 1420,
  rpmRatio: 43.5,
  airTemp: 20,
  airPress: 1013,
};

const TEST_SETTINGS: DynoSettingsConfig = {
  lossTime: 20,
  startSpeedKmh: 30,
  correctionFactor: 1.0,
  useAtmosphericCorrection: true,
  filterPower: 4.0,
  userInfo: 'OpenDyno Test',
  watermarkDataUrl: '',
};

describe('OpenDyno Core Logic & Bug Fixes', () => {
  it('initializes KalmanFilter state safely even without explicit reset()', () => {
    const kf = new KalmanFilter(4, 1, 1, 4, 0.25);
    const first = kf.getFiltered(10);
    const second = kf.getFiltered(12);
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeCloseTo(10, 5);
    expect(second).toBeGreaterThan(10);
    expect(second).toBeLessThan(12);
  });

  it('computes DIN 70020 atmospheric correction factor accurately', () => {
    // At standard conditions (20 °C, 1013 hPa), factor must be 1.0
    expect(calculateDin70020Correction(20, 1013)).toBeCloseTo(1.0, 5);
    // Higher temperature or lower pressure increases correction factor (> 1.0)
    expect(calculateDin70020Correction(35, 990)).toBeGreaterThan(1.04);
    // Cold dense air (< 20 °C, > 1013 hPa) decreases correction factor (< 1.0)
    expect(calculateDin70020Correction(5, 1030)).toBeLessThan(0.96);
  });

  it('guards against division-by-zero in torque and calibration ratio', () => {
    expect(calculateTorqueNm(0, 100)).toBe(0);
    expect(calculateTorqueNm(-500, 100)).toBe(0);
    expect(calculateTorqueNm(3000, 100)).toBeCloseTo(318.31, 1);

    expect(calculateRpmRatio(3000, 0)).toBe(0);
    expect(calculateRpmRatio(3000, -10)).toBe(0);
    expect(calculateRpmRatio(3000, 75)).toBeCloseTo(40, 4);
  });

  it('parses STM32 board telemetry lines and multi-line serial chunks safely', () => {
    // Valid line from board/src/src/gps.cpp: "+%u;%u;%u;%u\r\n"
    const pkt = parseBoardLine('+12500;25000;16;3\r\n');
    expect(pkt).not.toBeNull();
    expect(pkt!.timeSec).toBeCloseTo(12.5, 3);
    expect(pkt!.speedKmh).toBeCloseTo(90.0, 3); // 25000 mm/s = 25 m/s = 90 km/h
    expect(pkt!.siv).toBe(16);
    expect(pkt!.fix).toBe(GpsFixType.Fix3D);

    // Malformed lines should return null instead of crashing
    expect(parseBoardLine('GPS: Ready\r\n')).toBeNull();
    expect(parseBoardLine('+12500;25000\r\n')).toBeNull();
    expect(parseBoardLine('+abc;def;1;2\r\n')).toBeNull();

    // Multi-line chunk buffering across partial reads
    const buf = new SerialLineBuffer();
    expect(buf.pushChunk('+1000;10000;12;')).toHaveLength(0);
    const out = buf.pushChunk('3\r\n+1250;11000;14;3\r\nGPS: debug\r\n');
    expect(out).toHaveLength(2);
    expect(out[0].timeSec).toBeCloseTo(1.0, 3);
    expect(out[1].timeSec).toBeCloseTo(1.25, 3);
  });

  it('processes full dyno run, fits exponential coast-down losses without NaN, and preserves raw speed on save/load', () => {
    const preset = DEMO_PRESETS[0];
    const samples = generateSyntheticRunSamples(preset, 20);

    const proc = new DynoRunProcessor(preset.profile, TEST_SETTINGS);
    proc.loadRawSamples(samples);
    const runData = proc.buildRunData('run-1', 'Test Run', 0);

    expect(runData.powerMaxKm).toBeGreaterThan(150);
    expect(runData.powerMaxKm).toBeLessThan(260);
    expect(runData.torqueMaxNm).toBeGreaterThan(200);
    expect(runData.curvePoints.length).toBeGreaterThan(20);
    expect(runData.lossRawPoints.length).toBeGreaterThan(10);

    // Verify no NaNs in any curve point
    for (const pt of runData.curvePoints) {
      expect(Number.isFinite(pt.powerTotalKm)).toBe(true);
      expect(Number.isFinite(pt.torqueNm)).toBe(true);
      expect(Number.isFinite(pt.lossKm)).toBe(true);
    }

    // Verify lossless round-trip serialization (.dyno format)
    const serialized = serializeDynoFile(runData);
    const parsed = parseDynoFile(serialized, TEST_PROFILE);
    expect(parsed.profile.weight).toBe(preset.profile.weight);
    expect(parsed.samples.length).toBe(samples.length);
    expect(parsed.samples[5].speed).toBeCloseTo(samples[5].speed, 4);

    // Verify changing vehicle weight scales power proportionally without double-filtering
    const heavierProfile = { ...preset.profile, weight: preset.profile.weight * 2 };
    proc.setParameters(heavierProfile, TEST_SETTINGS);
    const heavierRun = proc.buildRunData('run-1', 'Heavier Run', 0);
    expect(heavierRun.powerMaxKm).toBeCloseTo(runData.powerMaxKm * 2, 0);
  });
});

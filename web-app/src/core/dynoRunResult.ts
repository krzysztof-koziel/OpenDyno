import { KalmanFilter } from './kalmanFilter';
import {
  DynoCurvePoint,
  DynoLossRawPoint,
  DynoRunData,
  DynoRunSample,
  DynoSettingsConfig,
  DynoTimePoint,
  VehicleProfile,
} from './types';

export const KW_TO_KM = 1.359621617; // Metric horsepower (KM / PS) per kW (original app used 1.36)
export const KW_TO_KM_COMPAT = 1.36; // Matches original OpenDyno constant

/**
 * Calculates the DIN 70020 atmospheric correction factor:
 *   k_a = (1013 / P_hPa) * sqrt((T_C + 273.15) / 293.15)
 * Standard reference conditions: 1013 hPa, 20 °C (293.15 K).
 */
export function calculateDin70020Correction(airTempC: number, airPressHpa: number): number {
  const safePress = airPressHpa > 100 ? airPressHpa : 1013;
  const safeTempK = Math.max(200, airTempC + 273.15);
  return (1013 / safePress) * Math.sqrt(safeTempK / 293.15);
}

/**
 * Calculates engine torque [Nm] from engine power [kW] and RPM.
 * Fixes division-by-zero bug when rpm <= 0.
 */
export function calculateTorqueNm(rpm: number, powerKw: number): number {
  if (!Number.isFinite(rpm) || rpm <= 0 || !Number.isFinite(powerKw)) {
    return 0;
  }
  return (powerKw * 9549.3) / rpm;
}

/**
 * Safely calculates RPM/Speed ratio during calibration.
 * Fixes division-by-zero bug when vehicle speed is 0.
 */
export function calculateRpmRatio(rpm: number, speedKmh: number): number {
  if (!Number.isFinite(rpm) || !Number.isFinite(speedKmh) || speedKmh <= 0.1 || rpm <= 0) {
    return 0;
  }
  return rpm / speedKmh;
}

/**
 * Core calculation engine for a Dyno Run.
 *
 * Fixes over original C++ implementation (app/dynorunresult.cpp):
 * 1. Preserves raw input speed (`rawSpeed`) separately from Kalman-filtered `speed` so that:
 *    - Saving a `.dyno` file writes the original measurements instead of re-filtered data.
 *    - Updating vehicle profile (weight, rpmRatio, airTemp, airPress) or filter settings
 *      re-runs the entire pipeline cleanly from raw samples without state corruption.
 * 2. Properly resets all three Kalman filters (`_speedFilter`, `_accFilter`, `_pwrFilter`)
 *    before processing.
 * 3. Properly computes the final sample in the series (which was left with uninitialized
 *    `accFiltered` in the original C++ `setParameters()`).
 * 4. Fixes exponential regression (`y = C * e^(A * rpm)`) in `_recalculateLosses`:
 *    - Replaces non-standard C++ VLAs with safe arrays.
 *    - Filters out any non-negative wheel power noise spikes during coast-down so `Math.log(y)`
 *      never receives `<= 0` and never produces `NaN` or `-Infinity`.
 *    - Guards against singular regression denominator (`cnt * x2sum - xsum * xsum === 0`).
 * 5. Integrates DIN 70020 atmospheric correction using `airTemp` and `airPress`.
 */
export class DynoRunProcessor {
  private _rawSamples: Array<{ time: number; speed: number }> = [];
  private _samples: DynoRunSample[] = [];
  private _lossesStartIndex = -1;
  private _lossesCnt = 0;
  private _lossesSkipNum = 8;

  private _lossA = 0;
  private _lossB = 0;
  private _lossC = 0;

  private _profile: VehicleProfile;
  private _settings: DynoSettingsConfig;

  private _speedFilter = new KalmanFilter();
  private _accFilter = new KalmanFilter();
  private _pwrFilter = new KalmanFilter();

  constructor(
    profile: VehicleProfile,
    settings: DynoSettingsConfig,
    lossesSkipNum = 8
  ) {
    this._profile = { ...profile };
    this._settings = { ...settings };
    this._lossesSkipNum = lossesSkipNum;
    this._initFilters();
  }

  private _initFilters(): void {
    this._speedFilter.init(0.2, 1, 1, 1, 0.25);
    this._accFilter.init(4, 1, 1, this._settings.filterPower, 0.25);
    this._pwrFilter.init(10, 1, 1, 15, 0.25);
  }

  public getEffectiveCorrectionFactor(): { dinFactor: number; effectiveFactor: number } {
    const dinFactor = calculateDin70020Correction(
      this._profile.airTemp,
      this._profile.airPress
    );
    const effectiveFactor = this._settings.useAtmosphericCorrection
      ? this._settings.correctionFactor * dinFactor
      : this._settings.correctionFactor;
    return { dinFactor, effectiveFactor };
  }

  public clear(): void {
    this._rawSamples = [];
    this._samples = [];
    this._lossesStartIndex = -1;
    this._lossesCnt = 0;
    this._lossA = 0;
    this._lossB = 0;
    this._lossC = 0;
    this._initFilters();
  }

  public setParameters(
    profile: VehicleProfile,
    settings: DynoSettingsConfig,
    lossesSkipNum = this._lossesSkipNum
  ): void {
    this._profile = { ...profile };
    this._settings = { ...settings };
    this._lossesSkipNum = lossesSkipNum;
    this.reprocessAll();
  }

  public addSample(time: number, rawSpeed: number, isAlreadyFiltered = false): void {
    if (!Number.isFinite(time) || !Number.isFinite(rawSpeed)) {
      return;
    }
    // Enforce strictly increasing or non-negative time steps
    if (this._rawSamples.length > 0) {
      const prevTime = this._rawSamples[this._rawSamples.length - 1].time;
      if (time <= prevTime) {
        time = prevTime + 0.001;
      }
    }
    this._rawSamples.push({ time, speed: Math.max(0, rawSpeed) });
    this._appendAndCalculate(time, Math.max(0, rawSpeed), isAlreadyFiltered);
  }

  public loadRawSamples(
    samples: Array<{ time: number; speed: number }>,
    isAlreadyFiltered = false
  ): void {
    this.clear();
    for (const s of samples) {
      if (Number.isFinite(s.time) && Number.isFinite(s.speed)) {
        this.addSample(s.time, s.speed, isAlreadyFiltered);
      }
    }
  }

  public reprocessAll(): void {
    const saved = [...this._rawSamples];
    this.clear();
    for (const s of saved) {
      this._rawSamples.push(s);
      this._appendAndCalculate(s.time, s.speed, false);
    }
  }

  private _appendAndCalculate(
    time: number,
    rawSpeed: number,
    isAlreadyFiltered: boolean
  ): void {
    const prevItem =
      this._samples.length > 0 ? this._samples[this._samples.length - 1] : null;
    const prevIdx = this._samples.length - 1;

    if (this._samples.length === 0) {
      this._speedFilter.reset(rawSpeed);
      this._accFilter.reset(0);
      this._pwrFilter.reset(0);
    }

    const filteredSpeed = isAlreadyFiltered
      ? rawSpeed
      : this._speedFilter.getFiltered(rawSpeed);
    const speedMs = (filteredSpeed * 1000) / 3600;
    const rpm = Math.round(filteredSpeed * this._profile.rpmRatio);

    let acc = 0;
    if (prevItem) {
      const dt = time - prevItem.time;
      acc = dt > 1e-6 ? (speedMs - prevItem.speedMs) / dt : 0;
    }

    const item: DynoRunSample = {
      time,
      rawSpeed,
      speed: filteredSpeed,
      speedMs,
      rpm,
      acc,
      accMean: acc,
      accFiltered: acc,
      force: 0,
      powerKw: 0,
      powerKwFiltered: 0,
    };

    this._samples.push(item);

    // Recalculate previous item now that it has both left and right neighbors for 3-point mean
    if (prevIdx >= 0) {
      this._recalculateItem(prevIdx);
    }
  }

  private _calculateForceAndPower(item: DynoRunSample): void {
    const { effectiveFactor } = this.getEffectiveCorrectionFactor();
    item.force = item.accFiltered * this._profile.weight;
    item.powerKw = ((item.force * item.speedMs) / 1000) * effectiveFactor;
    item.powerKwFiltered = this._pwrFilter.getFiltered(item.powerKw);
  }

  private _recalculateItem(idx: number): void {
    if (idx < 0 || idx >= this._samples.length) {
      return;
    }

    const item = this._samples[idx];
    if (idx === 0 || idx === this._samples.length - 1) {
      item.accMean = item.acc;
      if (idx === 0) {
        this._accFilter.reset(item.accMean);
      }
      item.accFiltered = item.acc;
    } else {
      const prevItem = this._samples[idx - 1];
      const nextItem = this._samples[idx + 1];
      item.accMean = (prevItem.acc + item.acc + nextItem.acc) / 3;
      item.accFiltered = this._accFilter.getFiltered(item.accMean);
    }

    this._calculateForceAndPower(item);

    if (item.powerKw < 0) {
      this._lossesCnt++;
      if (this._lossesCnt > 3 && this._lossesStartIndex < 0) {
        // Fix: use `idx - this._lossesCnt + 1` instead of `_items.size() - _lossesCnt`
        this._lossesStartIndex = Math.max(0, idx - this._lossesCnt + 1);
      }
      this._recalculateLosses();
    } else if (this._lossesStartIndex < 0) {
      this._lossesCnt = 0;
    }
  }

  private _recalculateLosses(): void {
    if (this._lossesStartIndex < 0 || this._lossesCnt <= 10) {
      return;
    }

    const base = this._lossesStartIndex + this._lossesSkipNum;
    const end = this._samples.length - 1; // Last evaluated item index
    if (base >= end) {
      return;
    }

    // Collect valid coast-down points where wheel power is strictly negative (-powerKw > 0.01)
    const validPoints: Array<{ x: number; lny: number }> = [];
    for (let i = base; i < end; i++) {
      const s = this._samples[i];
      const lossKw = -s.powerKw;
      if (s.rpm > 0 && Number.isFinite(lossKw) && lossKw > 0.01) {
        validPoints.push({ x: s.rpm, lny: Math.log(lossKw) });
      }
    }

    const cnt = validPoints.length;
    if (cnt < 3) {
      return;
    }

    let xsum = 0;
    let x2sum = 0;
    let ysum = 0;
    let xysum = 0;

    for (let i = 0; i < cnt; i++) {
      const { x, lny } = validPoints[i];
      xsum += x;
      ysum += lny;
      x2sum += x * x;
      xysum += x * lny;
    }

    const denom = cnt * x2sum - xsum * xsum;
    if (Math.abs(denom) < 1e-9) {
      return;
    }

    this._lossA = (cnt * xysum - xsum * ysum) / denom;
    this._lossB = (x2sum * ysum - xsum * xysum) / denom;
    this._lossC = Math.exp(this._lossB);
  }

  public lossAtKw(rpm: number): number {
    if (this._lossesCnt <= 0 || this._lossC <= 0 || !Number.isFinite(rpm)) {
      return 0;
    }
    const val = this._lossC * Math.exp(this._lossA * rpm);
    return Number.isFinite(val) ? Math.max(0, val) : 0;
  }

  public get lossesCount(): number {
    return this._lossesStartIndex >= 0
      ? Math.max(0, this._samples.length - this._lossesStartIndex - 1)
      : 0;
  }

  public get resultsCount(): number {
    return this._lossesStartIndex >= 0
      ? this._lossesStartIndex
      : Math.max(0, this._samples.length - 1);
  }

  public get rawSamples(): Array<{ time: number; speed: number }> {
    return this._rawSamples;
  }

  public get samples(): DynoRunSample[] {
    return this._samples;
  }

  public buildRunData(id: string, name: string, colorIndex: number): DynoRunData {
    const curvePoints: DynoCurvePoint[] = [];
    const lossRawPoints: DynoLossRawPoint[] = [];
    const timePoints: DynoTimePoint[] = [];

    let powerMaxKm = 0;
    let powerMaxRpm = 0;
    let torqueMaxNm = 0;
    let torqueMaxRpm = 0;
    let rpmMax = 0;
    let speedMaxKmh = 0;

    const accelEnd = Math.max(0, this.resultsCount - 3);

    for (let i = 2; i < accelEnd; i++) {
      const item = this._samples[i];
      const powerWheelKm = item.powerKwFiltered * KW_TO_KM_COMPAT;
      const powerRawKm = item.powerKw * KW_TO_KM_COMPAT;
      const lossKm = this.lossAtKw(item.rpm) * KW_TO_KM_COMPAT;
      const powerTotalKm = powerWheelKm + lossKm;
      const torqueNm = calculateTorqueNm(item.rpm, powerTotalKm / KW_TO_KM_COMPAT);

      if (item.rpm >= rpmMax) {
        rpmMax = item.rpm;
      }
      if (item.speed >= speedMaxKmh) {
        speedMaxKmh = item.speed;
      }
      if (powerTotalKm >= powerMaxKm) {
        powerMaxKm = powerTotalKm;
        powerMaxRpm = item.rpm;
      }
      if (torqueNm >= torqueMaxNm) {
        torqueMaxNm = torqueNm;
        torqueMaxRpm = item.rpm;
      }

      curvePoints.push({
        rpm: item.rpm,
        powerTotalKm,
        powerWheelKm,
        powerRawKm,
        lossKm,
        torqueNm,
      });

      timePoints.push({
        time: item.time,
        speedKmh: item.speed,
        accFiltered: item.accFiltered,
        accRaw: item.acc,
      });
    }

    if (this.lossesCount > 10) {
      for (let i = Math.max(2, accelEnd); i < this._samples.length - 1; i++) {
        const item = this._samples[i];
        const lossRawKm = -item.powerKwFiltered * KW_TO_KM_COMPAT;
        lossRawPoints.push({
          rpm: item.rpm,
          lossRawKm,
        });
        timePoints.push({
          time: item.time,
          speedKmh: item.speed,
          accFiltered: item.accFiltered,
          accRaw: item.acc,
        });
      }
    }

    const { dinFactor, effectiveFactor } = this.getEffectiveCorrectionFactor();

    return {
      id,
      name,
      colorIndex,
      profile: { ...this._profile },
      rawSamples: [...this._rawSamples],
      samples: [...this._samples],
      curvePoints,
      lossRawPoints,
      timePoints,
      powerMaxKm,
      powerMaxRpm,
      torqueMaxNm,
      torqueMaxRpm,
      rpmMax,
      speedMaxKmh,
      dinCorrectionFactor: dinFactor,
      effectiveCorrectionFactor: effectiveFactor,
    };
  }
}

/**
 * Parses a `.dyno` file (backward-compatible with original OpenDyno format and extended v2 header).
 * Original format:
 *   opendynofile;<rpmRatio>;<weight>[;<airTemp>;<airPress>]
 *   <time>;<speed>
 *   ...
 */
export function parseDynoFile(
  content: string,
  fallbackProfile: VehicleProfile
): {
  profile: VehicleProfile;
  samples: Array<{ time: number; speed: number }>;
} {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new Error('The .dyno file is empty.');
  }

  const headerParts = lines[0].split(';');
  if (headerParts[0] !== 'opendynofile' || headerParts.length < 3) {
    throw new Error('Invalid .dyno file header (expected "opendynofile;<rpmRatio>;<weight>").');
  }

  const rpmRatio = parseFloat(headerParts[1]);
  const weight = parseInt(headerParts[2], 10);
  const airTemp =
    headerParts.length >= 4 && Number.isFinite(parseFloat(headerParts[3]))
      ? parseFloat(headerParts[3])
      : fallbackProfile.airTemp;
  const airPress =
    headerParts.length >= 5 && Number.isFinite(parseFloat(headerParts[4]))
      ? parseFloat(headerParts[4])
      : fallbackProfile.airPress;

  if (!Number.isFinite(rpmRatio) || rpmRatio <= 0 || !Number.isFinite(weight) || weight <= 0) {
    throw new Error('Invalid vehicle parameters in .dyno file header.');
  }

  const samples: Array<{ time: number; speed: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(';');
    if (parts.length < 2) {
      continue; // Safely skip malformed or trailing lines instead of crashing
    }
    const time = parseFloat(parts[0]);
    const speed = parseFloat(parts[1]);
    if (Number.isFinite(time) && Number.isFinite(speed)) {
      samples.push({ time, speed });
    }
  }

  if (samples.length < 5) {
    throw new Error('The .dyno file contains too few valid data samples.');
  }

  return {
    profile: {
      rpmRatio,
      weight,
      airTemp,
      airPress,
    },
    samples,
  };
}

/**
 * Serializes a DynoRunData object back to the `.dyno` text format.
 * Compatible with the original C++ OpenDyno loader (`opendynofile;<rpmRatio>;<weight>`).
 */
export function serializeDynoFile(run: DynoRunData): string {
  const header = `opendynofile;${run.profile.rpmRatio.toFixed(6)};${Math.round(
    run.profile.weight
  )}`;
  const rows = run.rawSamples.map((s) => `${s.time};${s.speed}`);
  return [header, ...rows, ''].join('\n');
}

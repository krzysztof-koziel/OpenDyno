export interface VehicleProfile {
  weight: number;     // Vehicle mass in kg (e.g., 1400)
  rpmRatio: number;   // Engine RPM per 1 km/h of vehicle speed in test gear (e.g., 28.5)
  airTemp: number;    // Ambient air temperature in °C (e.g., 20.0)
  airPress: number;   // Ambient atmospheric pressure in hPa (e.g., 1013)
}

export interface DynoSettingsConfig {
  lossTime: number;                 // Coast-down measurement duration in seconds (10 - 30s)
  startSpeedKmh: number;            // Minimum speed threshold to trigger run countdown (default 30 km/h)
  correctionFactor: number;         // Manual correction multiplier (0.5 - 1.5, default 1.0)
  useAtmosphericCorrection: boolean;// Apply DIN 70020 atmospheric correction factor from airTemp & airPress
  filterPower: number;              // Kalman filter Q-power parameter for acceleration (0.5 - 10.0, default 4.0)
  userInfo: string;                 // Custom header note/HTML displayed on chart
  watermarkDataUrl: string;         // Optional PNG watermark (base64 data URL) for image exports
}

export enum GpsFixType {
  UnknownFix = 0,
  NoFix = 1,
  Fix2D = 2,
  Fix3D = 3,
}

export enum DynoRunState {
  RunInitial = 'RunInitial',
  RunWaitForSpeed = 'RunWaitForSpeed',
  RunCountdown = 'RunCountdown',
  RunAccelerating = 'RunAccelerating',
  RunLosses = 'RunLosses',
  RunFinished = 'RunFinished',
  RunCanceled = 'RunCanceled',
}

export interface VisibleSeriesConfig {
  power: boolean;          // Engine power (wheel power + coast-down losses) [KM]
  torque: boolean;         // Engine torque [Nm]
  losses: boolean;         // Fitted exponential coast-down losses curve [KM]
  powerWheel: boolean;     // Filtered wheel power [KM]
  powerWheelRaw: boolean;  // Unfiltered wheel power [KM]
  lossesRaw: boolean;      // Raw negative wheel power during coast-down [KM]
}

export interface DynoRunSample {
  time: number;            // Relative run time in seconds
  rawSpeed: number;        // Raw input speed in km/h (preserved for lossless save & recalculation)
  speed: number;           // Kalman-filtered speed in km/h
  speedMs: number;         // Kalman-filtered speed in m/s
  rpm: number;             // Engine RPM
  acc: number;             // Raw finite-difference acceleration in m/s^2
  accMean: number;         // 3-point moving average acceleration in m/s^2
  accFiltered: number;     // Kalman-filtered acceleration in m/s^2
  force: number;           // Tractive force at wheels in N
  powerKw: number;         // Raw wheel power in kW (with correction factor)
  powerKwFiltered: number; // Kalman-filtered wheel power in kW
}

export interface DynoCurvePoint {
  rpm: number;
  powerTotalKm: number;    // Engine power [KM]
  powerWheelKm: number;    // Filtered wheel power [KM]
  powerRawKm: number;      // Raw wheel power [KM]
  lossKm: number;          // Fitted drivetrain/aero loss at this RPM [KM]
  torqueNm: number;        // Engine torque [Nm]
}

export interface DynoLossRawPoint {
  rpm: number;
  lossRawKm: number;
}

export interface DynoTimePoint {
  time: number;
  speedKmh: number;
  accFiltered: number;
  accRaw: number;
}

export interface DynoRunData {
  id: string;
  name: string;
  colorIndex: number; // 0 = Primary (solid thick), 1 = Run 2 (solid thin), 2 = Run 3 (dashed)
  profile: VehicleProfile;
  rawSamples: Array<{ time: number; speed: number }>;
  samples: DynoRunSample[];
  curvePoints: DynoCurvePoint[];
  lossRawPoints: DynoLossRawPoint[];
  timePoints: DynoTimePoint[];
  powerMaxKm: number;
  powerMaxRpm: number;
  torqueMaxNm: number;
  torqueMaxRpm: number;
  rpmMax: number;
  speedMaxKmh: number;
  dinCorrectionFactor: number;
  effectiveCorrectionFactor: number;
}

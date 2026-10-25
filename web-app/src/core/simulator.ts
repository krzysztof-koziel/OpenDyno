import { VehicleProfile } from './types';

export interface SimulatedEnginePreset {
  id: string;
  name: string;
  description: string;
  profile: VehicleProfile;
  peakWheelKw: number;
  peakPowerRpm: number;
  redlineRpm: number;
  idleRpm: number;
  dragCoeff: number;
  rollingResistanceN: number;
}

export const DEMO_PRESETS: SimulatedEnginePreset[] = [
  {
    id: '20t-stock',
    name: '2.0 TSI / TFSI (Stock ~200 KM)',
    description: 'Turbocharged 2.0L petrol in 3rd gear (1420 kg, flat mid-range torque)',
    profile: {
      weight: 1420,
      rpmRatio: 43.5, // ~6000 RPM at 138 km/h in 3rd gear
      airTemp: 20.0,
      airPress: 1013,
    },
    peakWheelKw: 122, // ~166 KM at wheels + ~34 KM losses = ~200 KM crank
    peakPowerRpm: 5400,
    redlineRpm: 6400,
    idleRpm: 1300,
    dragCoeff: 0.42,
    rollingResistanceN: 240,
  },
  {
    id: '20t-stage1',
    name: '2.0 TSI / TFSI (Stage 1 ~255 KM)',
    description: 'Remapped 2.0L turbo petrol in 3rd gear (1420 kg, higher boost & top-end)',
    profile: {
      weight: 1420,
      rpmRatio: 43.5,
      airTemp: 20.0,
      airPress: 1013,
    },
    peakWheelKw: 158, // ~215 KM at wheels + ~40 KM losses = ~255 KM crank
    peakPowerRpm: 5600,
    redlineRpm: 6500,
    idleRpm: 1300,
    dragCoeff: 0.42,
    rollingResistanceN: 240,
  },
  {
    id: '19tdi',
    name: '1.9 TDI PD (Tuned ~165 KM)',
    description: 'Turbodiesel 1.9L in 3rd gear (1350 kg, high low-RPM torque surge)',
    profile: {
      weight: 1350,
      rpmRatio: 38.0,
      airTemp: 18.0,
      airPress: 1015,
    },
    peakWheelKw: 98,
    peakPowerRpm: 3950,
    redlineRpm: 4700,
    idleRpm: 1250,
    dragCoeff: 0.40,
    rollingResistanceN: 220,
  },
];

/**
 * Generates a realistic synthetic `.dyno` run dataset (4 Hz sampling = 0.25s steps)
 * including full-throttle acceleration from low RPM to redline followed by a 20s coast-down.
 */
export function generateSyntheticRunSamples(
  preset: SimulatedEnginePreset,
  lossDurationSec = 20
): Array<{ time: number; speed: number }> {
  const dt = 0.25; // 4 Hz UBLOX M10N rate
  const samples: Array<{ time: number; speed: number }> = [];

  const { weight, rpmRatio } = preset.profile;
  let speedKmh = Math.max(32, preset.idleRpm / rpmRatio);
  let speedMs = speedKmh / 3.6;
  let time = 0;

  // Phase 1: Full-throttle acceleration up to redlineRpm
  while (speedKmh * rpmRatio < preset.redlineRpm && time < 35) {
    samples.push({
      time: Number(time.toFixed(2)),
      speed: Number(speedKmh.toFixed(3)),
    });

    const rpm = speedKmh * rpmRatio;
    const normRpm = (rpm - preset.idleRpm) / (preset.redlineRpm - preset.idleRpm);

    // Realistic torque/power envelope across RPM band
    let powerFactor: number;
    if (preset.id === '19tdi') {
      // Diesel torque surge around 2000-3800 RPM, tapering after 4000 RPM
      const x = (rpm - 1200) / (preset.peakPowerRpm - 1200);
      powerFactor = Math.max(0.25, Math.sin(Math.min(1.35, Math.max(0.1, x)) * (Math.PI / 2)) * (rpm > preset.peakPowerRpm ? Math.max(0.55, 1 - 0.65 * Math.pow((rpm - preset.peakPowerRpm) / 1000, 2)) : 1));
    } else {
      // Turbo petrol curve: builds boost by 2400 RPM, peaks at peakPowerRpm, holds near redline
      const spool = 1 / (1 + Math.exp(-(rpm - 2200) / 350));
      const topEnd = rpm <= preset.peakPowerRpm
        ? 0.42 + 0.58 * Math.pow(Math.max(0, (rpm - 1300) / (preset.peakPowerRpm - 1300)), 0.85)
        : 1.0 - 0.18 * Math.pow((rpm - preset.peakPowerRpm) / (preset.redlineRpm - preset.peakPowerRpm + 200), 1.6);
      powerFactor = Math.max(0.2, spool * topEnd);
    }

    const engineTotalKw = preset.peakWheelKw * 1.24 * powerFactor;
    // Exponential parasitic + aerodynamic loss in kW
    const lossKw = 2.8 * Math.exp(0.00038 * rpm);
    const wheelKw = Math.max(2, engineTotalKw - lossKw);

    const tractiveForceN = (wheelKw * 1000) / Math.max(4, speedMs);
    const accMs2 = tractiveForceN / weight;

    speedMs += accMs2 * dt;
    speedKmh = speedMs * 3.6;
    time += dt;
    void normRpm;
  }

  // Phase 2: Clutch pressed — coast-down for `lossDurationSec` seconds
  const coastStart = time;
  let coastStep = 0;
  while (time - coastStart <= lossDurationSec && speedKmh > 15) {
    samples.push({
      time: Number(time.toFixed(2)),
      speed: Number(speedKmh.toFixed(3)),
    });

    const rpm = speedKmh * rpmRatio;
    // Smooth transition in the first 3 samples as clutch disengages
    const clutchTransition = coastStep < 2 ? 0.45 * (coastStep + 1) : 1.0;
    const lossKw = 2.8 * Math.exp(0.00038 * rpm) * clutchTransition;

    const decelForceN = (lossKw * 1000) / Math.max(3, speedMs);
    const decelMs2 = decelForceN / weight;

    speedMs = Math.max(3, speedMs - decelMs2 * dt);
    speedKmh = speedMs * 3.6;
    time += dt;
    coastStep++;
  }

  return samples;
}

# OpenDyno Web Application (React + TypeScript + Web Serial API)

Modern rewrite of the OpenDyno desktop application in **React 18 + TypeScript + Vite**, communicating directly with the STM32F103C8 + u-blox M10N GNSS hardware via the browser's **Web Serial API** (`115200` baud) while fixing the physics, filtering, and state-machine bugs of the original Qt6 C++ application.

## Quick Start

```powershell
cd web-app
npm.cmd install
npm.cmd run dev
```

Run unit tests and production build:
```powershell
npm.cmd test
npm.cmd run build
```

## Key Features & Fixes Included

1. **Direct Hardware Connection via Web Serial API**:
   - Connects directly from Chrome/Edge to the STM32 board (`115200` baud) with a stateful multi-line buffer ([`serialProtocol.ts`](src/core/serialProtocol.ts)).
2. **Built-in Dyno Simulator & Comparison Presets**:
   - **Simulate Pull**: Runs a live 4 Hz simulated road pull (`2.0 TSI Stock`, `2.0 TSI Stage 1`, or `1.9 TDI`) through the full state machine (`Wait for >= 30 km/h` -> `Countdown` -> `Full-Throttle Acceleration` -> `20s Coast-Down Losses`).
   - **Stock vs Stage 1**: One-click comparison of two dyno runs on the same chart.
3. **Physics, Math & Filtering Fixes ([`dynoRunResult.ts`](src/core/dynoRunResult.ts), [`kalmanFilter.ts`](src/core/kalmanFilter.ts))**:
   - **Kalman Filter initialization**: Properly initializes and resets `_speedFilter`, `_accFilter`, and `_pwrFilter` and fixes the state-transition covariance formula.
   - **Lossless `.dyno` Save/Load & Recalculation**: Preserves raw GPS speed separately from Kalman-filtered speed so saving `.dyno` files or updating vehicle weight/RPM ratio never double-filters the signal.
   - **Safe Coast-Down Exponential Regression**: Filters out positive noise spikes before `Math.log(lossKw)` so `NaN` or `-Infinity` can never poison the power/torque curves.
   - **DIN 70020 Atmospheric Correction**: Uses ambient air temperature (`°C`) and atmospheric pressure (`hPa`) from the Vehicle Profile to compute standard DIN 70020 power correction.
   - **30 km/h Start Threshold & Per-Run State**: Fixes the `speed >= 0.0f` bug that triggered runs at 0 km/h and replaces C++ `static` local variables with per-run state.
   - **Zero-Division Guards**: Protects RPM/Speed ratio calibration and low-RPM torque calculations against division by zero.

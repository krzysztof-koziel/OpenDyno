import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Download,
  FileUp,
  Gauge,
  HelpCircle,
  Image as ImageIcon,
  Play,
  Plus,
  Radio,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Usb,
} from 'lucide-react';
import { AboutModal } from './components/AboutModal';
import { DynoChart } from './components/DynoChart';
import { ProfileModal } from './components/ProfileModal';
import { SettingsModal } from './components/SettingsModal';
import { SpeedAccModal } from './components/SpeedAccModal';
import {
  calculateDin70020Correction,
  DynoRunProcessor,
  parseDynoFile,
  serializeDynoFile,
} from './core/dynoRunResult';
import { SerialLineBuffer } from './core/serialProtocol';
import { DEMO_PRESETS, generateSyntheticRunSamples } from './core/simulator';
import {
  DynoRunData,
  DynoRunState,
  DynoSettingsConfig,
  GpsFixType,
  VehicleProfile,
  VisibleSeriesConfig,
} from './core/types';

const STORAGE_PROFILE_KEY = 'opendyno_vehicle_profile_v2';
const STORAGE_SETTINGS_KEY = 'opendyno_settings_v2';

const DEFAULT_PROFILE: VehicleProfile = {
  weight: 1420,
  rpmRatio: 43.5,
  airTemp: 20.0,
  airPress: 1013,
};

const DEFAULT_SETTINGS: DynoSettingsConfig = {
  lossTime: 20,
  startSpeedKmh: 30,
  correctionFactor: 1.0,
  useAtmosphericCorrection: true,
  filterPower: 4.0,
  userInfo:
    '<b style="color: blue;">OpenDyno Road Test</b><br><i>https://github.com/milyges/OpenDyno/</i>',
  watermarkDataUrl: '',
};

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export const App: React.FC = () => {
  const [profile, setProfile] = useState<VehicleProfile>(() =>
    loadStored(STORAGE_PROFILE_KEY, DEFAULT_PROFILE)
  );
  const [settings, setSettings] = useState<DynoSettingsConfig>(() =>
    loadStored(STORAGE_SETTINGS_KEY, DEFAULT_SETTINGS)
  );

  const [visibleSeries, setVisibleSeries] = useState<VisibleSeriesConfig>({
    power: true,
    torque: true,
    losses: true,
    powerWheel: false,
    powerWheelRaw: false,
    lossesRaw: false,
  });

  // Runs state: currentRun (Run 1) + up to 2 comparison runs (Run 2, Run 3)
  const [currentRun, setCurrentRun] = useState<DynoRunData | null>(null);
  const [comparisonRuns, setComparisonRuns] = useState<DynoRunData[]>([]);

  // Live run state machine
  const [runState, setRunState] = useState<DynoRunState>(DynoRunState.RunInitial);
  const [lossesRemainingSec, setLossesRemainingSec] = useState<number | null>(null);

  // Hardware / GPS telemetry state
  const [portName, setPortName] = useState<string>('Not connected');
  const [portStatus, setPortStatus] = useState<string>('Disconnected');
  const [gpsFix, setGpsFix] = useState<GpsFixType>(GpsFixType.NoFix);
  const [gpsSiv, setGpsSiv] = useState<number>(0);
  const [liveSpeedKmh, setLiveSpeedKmh] = useState<number>(0);

  // Simulator controls
  const [selectedPresetId, setSelectedPresetId] = useState<string>(DEMO_PRESETS[0].id);
  const [simSpeedMultiplier, setSimSpeedMultiplier] = useState<number>(4); // 4x speed for quick live demo

  // Modals
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSpeedAccModal, setShowSpeedAccModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);

  // Refs for active run processing & serial / simulator loops
  const activeProcessorRef = useRef<DynoRunProcessor | null>(null);
  const runStateRef = useRef<DynoRunState>(DynoRunState.RunInitial);
  const runMetaRef = useRef<{
    ticks: number;
    startTimeSec: number;
    lossesStartSec: number;
  }>({
    ticks: 0,
    startTimeSec: 0,
    lossesStartSec: 0,
  });

  const serialPortRef = useRef<any>(null);
  const serialReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const simTimerRef = useRef<number | null>(null);
  const exportChartPngRef = useRef<(() => void) | null>(null);
  const loadCurrentInputRef = useRef<HTMLInputElement | null>(null);
  const loadComparisonInputRef = useRef<HTMLInputElement | null>(null);

  const setRunStateSync = (nextState: DynoRunState) => {
    runStateRef.current = nextState;
    setRunState(nextState);
  };

  // Load initial demo run on first mount so user immediately sees a realistic dyno graph
  useEffect(() => {
    const preset = DEMO_PRESETS[0];
    const samples = generateSyntheticRunSamples(preset, DEFAULT_SETTINGS.lossTime);
    const proc = new DynoRunProcessor(preset.profile, settings);
    proc.loadRawSamples(samples);
    setCurrentRun(proc.buildRunData('run-1', 'Run 1 (2.0 TSI Stock)', 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopSimulatorTimer = useCallback(() => {
    if (simTimerRef.current !== null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
  }, []);

  // Process incoming GPS telemetry packet (from Web Serial or Live Simulator)
  const handleTelemetrySample = useCallback(
    (gpsTimeSec: number, speedKmh: number, siv?: number, fix?: GpsFixType) => {
      setLiveSpeedKmh(speedKmh);
      if (siv !== undefined) setGpsSiv(siv);
      if (fix !== undefined) setGpsFix(fix);

      const state = runStateRef.current;
      const meta = runMetaRef.current;
      const proc = activeProcessorRef.current;

      if (
        state === DynoRunState.RunInitial ||
        state === DynoRunState.RunFinished ||
        state === DynoRunState.RunCanceled ||
        !proc
      ) {
        return;
      }

      // Fix for C++ bug (`speed >= 0.0f`): properly wait for configured start threshold (default 30 km/h)
      if (state === DynoRunState.RunWaitForSpeed && speedKmh >= settings.startSpeedKmh) {
        meta.ticks = -8; // 2 seconds countdown at 4 Hz
        setRunStateSync(DynoRunState.RunCountdown);
      }

      if (runStateRef.current === DynoRunState.RunCountdown && meta.ticks >= 0) {
        meta.startTimeSec = gpsTimeSec;
        meta.ticks = 0;
        setRunStateSync(DynoRunState.RunAccelerating);
      }

      if (runStateRef.current === DynoRunState.RunAccelerating) {
        if (proc.lossesCount > 0) {
          meta.lossesStartSec = gpsTimeSec;
          setRunStateSync(DynoRunState.RunLosses);
        }
        proc.addSample(gpsTimeSec - meta.startTimeSec, speedKmh);
      } else if (runStateRef.current === DynoRunState.RunLosses) {
        const elapsedLosses = gpsTimeSec - meta.lossesStartSec;
        const remaining = Math.max(0, settings.lossTime - elapsedLosses);
        setLossesRemainingSec(remaining);
        proc.addSample(gpsTimeSec - meta.startTimeSec, speedKmh);

        if (elapsedLosses >= settings.lossTime) {
          setLossesRemainingSec(null);
          setRunStateSync(DynoRunState.RunFinished);
          setCurrentRun(proc.buildRunData('run-1', 'Run 1', 0));
          stopSimulatorTimer();
          return;
        }
      }

      meta.ticks++;
      if (meta.ticks % 2 === 0) {
        setCurrentRun(proc.buildRunData('run-1', 'Run 1', 0));
      }
    },
    [settings.lossTime, settings.startSpeedKmh, stopSimulatorTimer]
  );

  // Start or Cancel hardware/live run
  const handleStartStopRun = useCallback(() => {
    const isRunning =
      runStateRef.current === DynoRunState.RunWaitForSpeed ||
      runStateRef.current === DynoRunState.RunCountdown ||
      runStateRef.current === DynoRunState.RunAccelerating ||
      runStateRef.current === DynoRunState.RunLosses;

    if (isRunning) {
      stopSimulatorTimer();
      setLossesRemainingSec(null);
      setRunStateSync(DynoRunState.RunCanceled);
      if (activeProcessorRef.current) {
        setCurrentRun(activeProcessorRef.current.buildRunData('run-1', 'Run 1', 0));
      }
      return;
    }

    const proc = new DynoRunProcessor(profile, settings);
    activeProcessorRef.current = proc;
    runMetaRef.current = { ticks: 0, startTimeSec: 0, lossesStartSec: 0 };
    setLossesRemainingSec(null);
    setCurrentRun(proc.buildRunData('run-1', 'Run 1', 0));
    setRunStateSync(DynoRunState.RunWaitForSpeed);
  }, [profile, settings, stopSimulatorTimer]);

  // Run a live animated simulated pull through the state machine
  const handleStartSimulatedPull = () => {
    stopSimulatorTimer();
    const preset =
      DEMO_PRESETS.find((p) => p.id === selectedPresetId) || DEMO_PRESETS[0];

    setProfile(preset.profile);
    localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(preset.profile));

    const proc = new DynoRunProcessor(preset.profile, settings);
    activeProcessorRef.current = proc;
    runMetaRef.current = { ticks: 0, startTimeSec: 0, lossesStartSec: 0 };
    setLossesRemainingSec(null);
    setCurrentRun(proc.buildRunData('run-1', `Run 1 (${preset.name})`, 0));
    setRunStateSync(DynoRunState.RunWaitForSpeed);

    setPortName('SIMULATOR (4 Hz Virtual GNSS)');
    setPortStatus('Simulating Pull...');
    setGpsFix(GpsFixType.Fix3D);
    setGpsSiv(18);

    // Build pre-roll (25 -> 33 km/h) + countdown + full synthetic pull + coast-down
    const pullSamples = generateSyntheticRunSamples(preset, settings.lossTime);
    const fullStream: Array<{ time: number; speed: number }> = [];
    let t = 0;
    // Pre-roll from 22 km/h to 32 km/h to trigger 30 km/h threshold
    for (let spd = 22; spd < 32; spd += 2.5) {
      fullStream.push({ time: t, speed: spd });
      t += 0.25;
    }
    // 2 seconds of steady speed during 3-2-1 countdown
    for (let c = 0; c < 8; c++) {
      fullStream.push({ time: t, speed: pullSamples[0].speed });
      t += 0.25;
    }
    const offsetTime = t;
    for (const s of pullSamples) {
      fullStream.push({ time: offsetTime + s.time, speed: s.speed });
    }

    let idx = 0;
    const intervalMs = Math.max(20, Math.round(250 / simSpeedMultiplier));
    simTimerRef.current = window.setInterval(() => {
      if (idx >= fullStream.length) {
        stopSimulatorTimer();
        setPortStatus('Simulation Complete');
        setRunStateSync(DynoRunState.RunFinished);
        if (activeProcessorRef.current) {
          setCurrentRun(
            activeProcessorRef.current.buildRunData('run-1', `Run 1 (${preset.name})`, 0)
          );
        }
        return;
      }
      const pt = fullStream[idx++];
      handleTelemetrySample(pt.time, pt.speed, 18, GpsFixType.Fix3D);
    }, intervalMs);
  };

  // Load instant Stock vs. Stage 1 comparison demo
  const handleLoadComparisonDemo = () => {
    stopSimulatorTimer();
    const stockPreset = DEMO_PRESETS[0];
    const stage1Preset = DEMO_PRESETS[1];

    setProfile(stockPreset.profile);
    localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(stockPreset.profile));

    const proc1 = new DynoRunProcessor(stockPreset.profile, settings);
    proc1.loadRawSamples(generateSyntheticRunSamples(stockPreset, settings.lossTime));

    const proc2 = new DynoRunProcessor(stage1Preset.profile, settings);
    proc2.loadRawSamples(generateSyntheticRunSamples(stage1Preset, settings.lossTime));

    setCurrentRun(proc1.buildRunData('run-1', 'Run 1 (Stock 2.0 TSI)', 0));
    setComparisonRuns([proc2.buildRunData('run-2', 'Run 2 (Stage 1 Tune)', 1)]);
    setRunStateSync(DynoRunState.RunFinished);
  };

  // Connect to physical STM32 OpenDyno board via Web Serial API
  const handleConnectWebSerial = async () => {
    const nav = navigator as any;
    if (!nav.serial) {
      alert(
        'Web Serial API is not supported in this browser. Please use Google Chrome or Microsoft Edge, or use the built-in Simulator mode.'
      );
      return;
    }

    try {
      if (serialPortRef.current) {
        await serialReaderRef.current?.cancel();
        await serialPortRef.current.close();
        serialPortRef.current = null;
        setPortName('Not connected');
        setPortStatus('Disconnected');
        setGpsFix(GpsFixType.NoFix);
        setGpsSiv(0);
        return;
      }

      const port = await nav.serial.requestPort();
      await port.open({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
      serialPortRef.current = port;
      setPortName('USB Serial (115200)');
      setPortStatus('Ready');

      const decoder = new TextDecoder();
      const lineBuffer = new SerialLineBuffer();
      const reader = port.readable.getReader();
      serialReaderRef.current = reader;

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const text = decoder.decode(value, { stream: true });
              const packets = lineBuffer.pushChunk(text);
              for (const pkt of packets) {
                handleTelemetrySample(pkt.timeSec, pkt.speedKmh, pkt.siv, pkt.fix);
              }
            }
          }
        } catch (err) {
          console.error('Serial read error:', err);
          setPortStatus('Read error');
        }
      })();
    } catch (err: any) {
      if (err?.name !== 'NotFoundError') {
        alert(`Unable to open serial port: ${err?.message || err}`);
      }
    }
  };

  // Update Vehicle Profile & recalculate current run cleanly from raw samples
  const handleSaveProfile = (newProfile: VehicleProfile) => {
    setProfile(newProfile);
    localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(newProfile));

    if (currentRun) {
      const proc = new DynoRunProcessor(newProfile, settings);
      proc.loadRawSamples(currentRun.rawSamples);
      setCurrentRun(proc.buildRunData(currentRun.id, currentRun.name, 0));
    }
  };

  // Update Dyno Settings & recalculate all loaded runs
  const handleSaveSettings = (newSettings: DynoSettingsConfig) => {
    setSettings(newSettings);
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(newSettings));

    if (currentRun) {
      const proc = new DynoRunProcessor(currentRun.profile, newSettings);
      proc.loadRawSamples(currentRun.rawSamples);
      setCurrentRun(proc.buildRunData(currentRun.id, currentRun.name, 0));
    }
    setComparisonRuns((prev) =>
      prev.map((r, i) => {
        const proc = new DynoRunProcessor(r.profile, newSettings);
        proc.loadRawSamples(r.rawSamples);
        return proc.buildRunData(r.id, r.name, i + 1);
      })
    );
  };

  // Load .dyno file into Run 1
  const handleLoadCurrentFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseDynoFile(String(reader.result || ''), profile);
        const proc = new DynoRunProcessor(parsed.profile, settings);
        proc.loadRawSamples(parsed.samples);
        setProfile(parsed.profile);
        setCurrentRun(proc.buildRunData('run-1', `Run 1 (${file.name.replace(/\.dyno$/i, '')})`, 0));
        setRunStateSync(DynoRunState.RunFinished);
      } catch (err: any) {
        alert(`Failed to load .dyno file: ${err?.message || err}`);
      }
    };
    reader.readAsText(file);
  };

  // Load .dyno file into Comparison Runs (Run 2 or Run 3)
  const handleLoadComparisonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (comparisonRuns.length >= 2) {
      alert('Maximum supported runs is 3 (Current Run + 2 comparison runs). Remove a run first.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseDynoFile(String(reader.result || ''), profile);
        const nextIdx = comparisonRuns.length + 1;
        const proc = new DynoRunProcessor(parsed.profile, settings);
        proc.loadRawSamples(parsed.samples);
        const runData = proc.buildRunData(
          `run-${nextIdx + 1}-${Date.now()}`,
          `Run ${nextIdx + 1} (${file.name.replace(/\.dyno$/i, '')})`,
          nextIdx
        );
        setComparisonRuns((prev) => [...prev, runData]);
      } catch (err: any) {
        alert(`Failed to load comparison .dyno file: ${err?.message || err}`);
      }
    };
    reader.readAsText(file);
  };

  // Save current run to .dyno file
  const handleSaveCurrentFile = useCallback(() => {
    if (!currentRun) return;
    const text = serializeDynoFile(currentRun);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `run_${stamp}.dyno`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentRun]);

  // Keyboard shortcuts matching original Qt app (F2, F3, F4, F10, Ctrl+E)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        setShowProfileModal(true);
      } else if (e.key === 'F3') {
        e.preventDefault();
        handleSaveCurrentFile();
      } else if (e.key === 'F4') {
        e.preventDefault();
        loadCurrentInputRef.current?.click();
      } else if (e.key === 'F10') {
        e.preventDefault();
        setShowSettingsModal(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportChartPngRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSaveCurrentFile]);

  const allRuns = useMemo(() => {
    const list: DynoRunData[] = [];
    if (currentRun) list.push(currentRun);
    list.push(...comparisonRuns);
    return list;
  }, [currentRun, comparisonRuns]);

  const isRunActive =
    runState === DynoRunState.RunWaitForSpeed ||
    runState === DynoRunState.RunCountdown ||
    runState === DynoRunState.RunAccelerating ||
    runState === DynoRunState.RunLosses;

  const statusText = useMemo(() => {
    switch (runState) {
      case DynoRunState.RunInitial:
        return 'Ready. Start a simulated pull, connect your STM32 GPS module, or load a .dyno file.';
      case DynoRunState.RunWaitForSpeed:
        return `Waiting for vehicle speed >= ${settings.startSpeedKmh} km/h to trigger countdown...`;
      case DynoRunState.RunCountdown:
        return 'Get ready! Full throttle acceleration starting in 3, 2, 1...';
      case DynoRunState.RunAccelerating:
        return 'ACCELERATING — Hold full throttle to redline, then press clutch to measure coast-down losses!';
      case DynoRunState.RunLosses:
        return `COAST-DOWN LOSSES — Keep clutch depressed and coast without braking [${(
          lossesRemainingSec ?? settings.lossTime
        ).toFixed(1)}s left]...`;
      case DynoRunState.RunFinished:
        return 'Run finished. Hover over the chart to inspect interpolated RPM, Power, and Torque.';
      case DynoRunState.RunCanceled:
        return 'Run canceled.';
    }
  }, [runState, settings.startSpeedKmh, settings.lossTime, lossesRemainingSec]);

  const gpsFixLabel = useMemo(() => {
    switch (gpsFix) {
      case GpsFixType.NoFix:
        return 'No fix';
      case GpsFixType.Fix2D:
        return '2D fix';
      case GpsFixType.Fix3D:
        return '3D fix';
      default:
        return 'Unknown';
    }
  }, [gpsFix]);

  const dinFactor = calculateDin70020Correction(profile.airTemp, profile.airPress);

  return (
    <div className="app-shell">
      {/* Hidden File Inputs */}
      <input
        ref={loadCurrentInputRef}
        type="file"
        accept=".dyno,.txt,.csv"
        onChange={handleLoadCurrentFile}
        hidden
      />
      <input
        ref={loadComparisonInputRef}
        type="file"
        accept=".dyno,.txt,.csv"
        onChange={handleLoadComparisonFile}
        hidden
      />

      {/* Top Navigation & Action Bar */}
      <header className="top-bar">
        <div className="brand">
          <div className="brand-badge">
            <Gauge size={20} />
          </div>
          <div>
            <h1>OpenDyno</h1>
            <span className="brand-sub">GPS Road Dynamometer</span>
          </div>
        </div>

        {/* Run & File Controls */}
        <div className="toolbar-group">
          <button
            className={`btn ${isRunActive ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleStartStopRun}
            title="Start or cancel hardware GPS dyno run"
          >
            {isRunActive ? <Square size={15} /> : <Play size={15} />}
            {isRunActive ? 'Cancel Run' : 'Start GPS Run'}
          </button>

          <button
            className="btn btn-secondary"
            disabled={isRunActive}
            onClick={() => loadCurrentInputRef.current?.click()}
            title="Load .dyno file into Run 1 [F4]"
          >
            <FileUp size={15} />
            Load .dyno
          </button>

          <button
            className="btn btn-secondary"
            disabled={isRunActive || !currentRun}
            onClick={handleSaveCurrentFile}
            title="Save Run 1 to .dyno file [F3]"
          >
            <Download size={15} />
            Save .dyno
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => exportChartPngRef.current?.()}
            title="Export 1280x720 PNG chart [Ctrl+E]"
          >
            <ImageIcon size={15} />
            Export PNG
          </button>
        </div>

        {/* Built-in Demo / Simulator Controls */}
        <div className="toolbar-group sim-toolbar">
          <select
            className="preset-select"
            value={selectedPresetId}
            disabled={isRunActive}
            onChange={(e) => setSelectedPresetId(e.target.value)}
            title="Select simulated engine preset"
          >
            {DEMO_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            className="speed-select"
            value={simSpeedMultiplier}
            disabled={isRunActive}
            onChange={(e) => setSimSpeedMultiplier(Number(e.target.value))}
            title="Simulation playback speed"
          >
            <option value={1}>1x (Real-time)</option>
            <option value={4}>4x Fast</option>
            <option value={10}>10x Instant</option>
          </select>

          <button
            className="btn btn-accent"
            disabled={isRunActive}
            onClick={handleStartSimulatedPull}
            title="Simulate a live dyno pull through the state machine"
          >
            <Radio size={15} />
            Simulate Pull
          </button>

          <button
            className="btn btn-secondary"
            disabled={isRunActive}
            onClick={handleLoadComparisonDemo}
            title="Load Stock vs. Stage 1 comparison runs"
          >
            <Sparkles size={15} />
            Stock vs Stage 1
          </button>
        </div>

        {/* Settings & Dialog Triggers */}
        <div className="toolbar-group">
          <button
            className="btn btn-secondary"
            disabled={isRunActive}
            onClick={() => setShowSpeedAccModal(true)}
            title="View Speed & Acceleration vs Time chart"
          >
            <Activity size={15} />
            Speed &amp; Acc
          </button>
          <button
            className="btn btn-secondary"
            disabled={isRunActive}
            onClick={() => setShowProfileModal(true)}
            title="Vehicle Profile & Calibration [F2]"
          >
            <Gauge size={15} />
            Vehicle [F2]
          </button>
          <button
            className="btn btn-secondary"
            disabled={isRunActive}
            onClick={() => setShowSettingsModal(true)}
            title="Dyno Settings [F10]"
          >
            <Settings size={15} />
            Settings
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowAboutModal(true)}
            title="About OpenDyno"
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </header>

      {/* Live Status Banner + Series Visibility Toggles */}
      <div className="status-strip">
        <div className={`status-banner state-${runState}`}>
          <span className="status-dot" />
          <span className="status-text">{statusText}</span>
        </div>

        <div className="series-toggles">
          <span className="toggles-label">Visible Series:</span>
          <label className="series-pill pill-power">
            <input
              type="checkbox"
              checked={visibleSeries.power}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, power: e.target.checked }))
              }
            />
            <span>Power (Engine)</span>
          </label>
          <label className="series-pill pill-torque">
            <input
              type="checkbox"
              checked={visibleSeries.torque}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, torque: e.target.checked }))
              }
            />
            <span>Torque</span>
          </label>
          <label className="series-pill pill-losses">
            <input
              type="checkbox"
              checked={visibleSeries.losses}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, losses: e.target.checked }))
              }
            />
            <span>Losses (Fitted)</span>
          </label>
          <label className="series-pill pill-wheel">
            <input
              type="checkbox"
              checked={visibleSeries.powerWheel}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, powerWheel: e.target.checked }))
              }
            />
            <span>Wheel Power</span>
          </label>
          <label className="series-pill pill-raw">
            <input
              type="checkbox"
              checked={visibleSeries.powerWheelRaw}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, powerWheelRaw: e.target.checked }))
              }
            />
            <span>Wheel (Raw)</span>
          </label>
          <label className="series-pill pill-lossraw">
            <input
              type="checkbox"
              checked={visibleSeries.lossesRaw}
              onChange={(e) =>
                setVisibleSeries((s) => ({ ...s, lossesRaw: e.target.checked }))
              }
            />
            <span>Losses (Raw)</span>
          </label>
        </div>
      </div>

      {/* Main Chart Area */}
      <main className="chart-section">
        <DynoChart
          runs={allRuns}
          visibleSeries={visibleSeries}
          userInfo={settings.userInfo}
          watermarkDataUrl={settings.watermarkDataUrl}
          exportTriggerRef={exportChartPngRef}
        />
      </main>

      {/* Bottom Dashboard Panels (GPS Status, Vehicle Profile, Loaded Runs Table) */}
      <section className="bottom-dashboard">
        {/* Panel 1: GPS / Hardware Status */}
        <div className="dash-card">
          <div className="dash-card-header">
            <h4>GPS &amp; Serial Status</h4>
            <button
              className="btn btn-sm btn-secondary"
              onClick={handleConnectWebSerial}
              disabled={isRunActive}
            >
              <Usb size={14} />
              {serialPortRef.current ? 'Disconnect' : 'Connect USB'}
            </button>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <span>Port:</span>
              <strong>{portName}</strong>
            </div>
            <div className="kv-row">
              <span>Status:</span>
              <strong>{portStatus}</strong>
            </div>
            <div className="kv-row">
              <span>Fix Type:</span>
              <strong className={gpsFix === GpsFixType.Fix3D ? 'text-success' : ''}>
                {gpsFixLabel}
              </strong>
            </div>
            <div className="kv-row">
              <span>Satellites (SIV):</span>
              <strong>{gpsSiv}</strong>
            </div>
            <div className="kv-row">
              <span>Live Speed:</span>
              <strong className="speed-readout">{liveSpeedKmh.toFixed(1)} km/h</strong>
            </div>
          </div>
        </div>

        {/* Panel 2: Vehicle Profile */}
        <div className="dash-card">
          <div className="dash-card-header">
            <h4>Vehicle Profile</h4>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowProfileModal(true)}
              disabled={isRunActive}
            >
              Edit Profile
            </button>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <span>Weight:</span>
              <strong>{profile.weight} kg</strong>
            </div>
            <div className="kv-row">
              <span>RPM Ratio:</span>
              <strong>{profile.rpmRatio.toFixed(4)} RPM/(km/h)</strong>
            </div>
            <div className="kv-row">
              <span>Temperature:</span>
              <strong>{profile.airTemp.toFixed(1)} °C</strong>
            </div>
            <div className="kv-row">
              <span>Pressure:</span>
              <strong>{profile.airPress} hPa</strong>
            </div>
            <div className="kv-row">
              <span>DIN 70020 Factor:</span>
              <strong>
                {settings.useAtmosphericCorrection
                  ? `${dinFactor.toFixed(3)}x (Active)`
                  : `${dinFactor.toFixed(3)}x (Off)`}
              </strong>
            </div>
          </div>
        </div>

        {/* Panel 3: Runs Comparison Table */}
        <div className="dash-card runs-card">
          <div className="dash-card-header">
            <h4>Loaded Dyno Runs ({allRuns.length} / 3)</h4>
            <div className="runs-actions">
              <button
                className="btn btn-sm btn-secondary"
                disabled={isRunActive || comparisonRuns.length >= 2}
                onClick={() => loadComparisonInputRef.current?.click()}
                title="Add comparison .dyno run"
              >
                <Plus size={14} />
                Add Comparison Run
              </button>
              <button
                className="btn btn-sm btn-ghost"
                disabled={isRunActive || comparisonRuns.length === 0}
                onClick={() => setComparisonRuns((prev) => prev.slice(0, -1))}
                title="Remove last comparison run"
              >
                <Trash2 size={14} />
                Remove Last
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Peak Power [KM]</th>
                  <th>Peak Torque [Nm]</th>
                  <th>Max RPM</th>
                  <th>V Max [km/h]</th>
                </tr>
              </thead>
              <tbody>
                {allRuns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-row">
                      No runs loaded
                    </td>
                  </tr>
                ) : (
                  allRuns.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                      </td>
                      <td className="text-power">
                        <strong>{r.powerMaxKm.toFixed(1)} KM</strong> @ {r.powerMaxRpm} RPM
                      </td>
                      <td className="text-torque">
                        <strong>{r.torqueMaxNm.toFixed(1)} Nm</strong> @ {r.torqueMaxRpm} RPM
                      </td>
                      <td>{r.rpmMax} RPM</td>
                      <td>{r.speedMaxKmh.toFixed(1)} km/h</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Modals */}
      <ProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        profile={profile}
        currentGpsSpeedKmh={liveSpeedKmh}
        onSave={handleSaveProfile}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />

      <SpeedAccModal
        isOpen={showSpeedAccModal}
        onClose={() => setShowSpeedAccModal(false)}
        runs={allRuns}
      />

      <AboutModal
        isOpen={showAboutModal}
        onClose={() => setShowAboutModal(false)}
      />
    </div>
  );
};

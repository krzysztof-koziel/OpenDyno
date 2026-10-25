import { GpsFixType } from './types';

export interface ParsedBoardPacket {
  timeSec: number;
  speedKmh: number;
  siv: number;
  fix: GpsFixType;
}

/**
 * Parses a single telemetry line from the OpenDyno STM32 board:
 * Format sent by `board/src/src/gps.cpp`:
 *   `+%u;%u;%u;%u\r\n` -> `+<time_of_week_ms>;<ground_speed_mm_s>;<siv>;<fix_type>`
 *
 * Fixes over original C++ implementation (`DynoDevice::_serialportDataReady`):
 * 1. Explicitly strips the leading `+` before parsing `time_of_week_ms`.
 * 2. Validates field count (`parts.length === 4`) and checks `Number.isFinite` on all fields
 *    so truncated serial frames never cause out-of-bounds crashes.
 */
export function parseBoardLine(rawLine: string): ParsedBoardPacket | null {
  const line = rawLine.trim();
  if (!line.startsWith('+')) {
    return null;
  }

  const payload = line.slice(1);
  const parts = payload.split(';');
  if (parts.length < 4) {
    return null;
  }

  const timeMs = Number(parts[0]);
  const speedMmPerSec = Number(parts[1]);
  const siv = Number(parts[2]);
  const fixRaw = Number(parts[3]);

  if (
    !Number.isFinite(timeMs) ||
    !Number.isFinite(speedMmPerSec) ||
    !Number.isFinite(siv) ||
    !Number.isFinite(fixRaw) ||
    timeMs < 0 ||
    speedMmPerSec < 0
  ) {
    return null;
  }

  const timeSec = timeMs / 1000.0;
  const speedKmh = (speedMmPerSec / 1000.0) * 3.6;

  let fix = GpsFixType.UnknownFix;
  if (fixRaw === GpsFixType.NoFix) fix = GpsFixType.NoFix;
  else if (fixRaw === GpsFixType.Fix2D) fix = GpsFixType.Fix2D;
  else if (fixRaw === GpsFixType.Fix3D) fix = GpsFixType.Fix3D;

  return {
    timeSec,
    speedKmh,
    siv: Math.max(0, Math.round(siv)),
    fix,
  };
}

/**
 * Stateful line buffer for streaming Web Serial chunks.
 * Fixes the original C++ bug where only a single `readLine()` was processed per `readyRead()` event.
 */
export class SerialLineBuffer {
  private _buffer = '';

  public pushChunk(chunk: string): ParsedBoardPacket[] {
    this._buffer += chunk;
    const packets: ParsedBoardPacket[] = [];

    let newlineIdx = this._buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = this._buffer.slice(0, newlineIdx);
      this._buffer = this._buffer.slice(newlineIdx + 1);

      const parsed = parseBoardLine(rawLine);
      if (parsed) {
        packets.push(parsed);
      }

      newlineIdx = this._buffer.indexOf('\n');
    }

    // Prevent unbounded buffer growth if noise without newlines is received
    if (this._buffer.length > 4096) {
      this._buffer = '';
    }

    return packets;
  }

  public clear(): void {
    this._buffer = '';
  }
}

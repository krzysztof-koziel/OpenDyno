/**
 * 1D Kalman Filter implementation for OpenDyno signal smoothing
 * (Speed, Acceleration, and Wheel Power).
 *
 * Fixes over original C++ implementation (app/kalmanfilter.cpp):
 * 1. Properly initializes state variables (_xpri, _Ppri, _xpost, _Ppost) in constructor & init()
 *    so that calling getFiltered() without an explicit reset() never reads uninitialized memory.
 * 2. Uses the full state-transition covariance formula: P_pri = A * P_post * A + V (instead of A * P_post + V).
 * 3. Guards against division by zero if innovation covariance `s` is 0.
 */
export class KalmanFilter {
  private _A = 1;
  private _C = 1;
  private _V = 0;
  private _W = 1;
  private _P0 = 1;
  private _xpri = 0;
  private _Ppri = 1;
  private _xpost = 0;
  private _Ppost = 1;
  private _initialized = false;

  constructor(stdDev = 1, A = 1, C = 1, power = 1, dt = 0.25) {
    this.init(stdDev, A, C, power, dt);
  }

  public init(stdDev: number, A: number, C: number, power: number, dt: number): void {
    this._A = A;
    this._C = C;
    this._V = power * stdDev * dt;
    this._W = stdDev * stdDev;
    this.reset(0);
    this._initialized = false;
  }

  public reset(initialVal: number): void {
    this._P0 = 1;
    this._xpri = initialVal;
    this._Ppri = this._P0;
    this._xpost = initialVal;
    this._Ppost = this._P0;
    this._initialized = true;
  }

  public getFiltered(value: number): number {
    if (!Number.isFinite(value)) {
      return this._xpost;
    }

    if (!this._initialized) {
      this.reset(value);
    }

    this._xpri = this._A * this._xpost;
    this._Ppri = this._A * this._Ppost * this._A + this._V;

    const eps = value - this._C * this._xpri;
    const s = this._C * this._Ppri * this._C + this._W;
    const k = s !== 0 ? (this._Ppri * this._C) / s : 0;

    this._xpost = this._xpri + k * eps;
    this._Ppost = this._Ppri - k * s * k;

    return this._xpost;
  }
}

import * as net from 'net';
import * as Modbus from 'jsmodbus';
import Homey from 'homey';
import {
  Measurement, RegisterMap, describeError, readModbus, requestFailure,
} from './modbus';
import {
  EXVENT_COILS, EXVENT_HOLDING_REGISTERS, UNIT_BOOST_BITS, controllerOutputs, exventStatus, exventStatusMode,
} from './exvent';
import { alarmOn, alarmText } from './alarms';
import { DriverCards, FlowCardIds, withTimeout } from './flowCards';
import {
  inRange, isValidHost, isValidPort, toNumber,
} from './settings';

const POLL_INTERVAL = 60 * 1000;
const CONNECTION_RETRY_MIN = 5000;
const CONNECTION_RETRY_MAX = 30000;
/** How long a connection attempt may take before it is given up. */
const CONNECT_TIMEOUT_MS = 10000;
const WRITE_SPACING_MS = 1000;
/** How many times a write is sent again after a timeout or a lost connection. */
const WRITE_RETRIES = 2;
const MODBUS_TIMEOUT = 5000;
const MODBUS_UNIT_ID = 255;
const CONFIRM_POLL_DELAY_MS = 3000;
/** Failed polls in a row before the device shows that the unit does not answer. */
const NO_CONNECTION_WARNING_AFTER = 3;
/** How long the settings dialog waits for the writes to the unit. */
const SETTINGS_WRITE_TIMEOUT_MS = 25 * 1000;
/**
 * How long after a mode write a reading of the previous mode counts as stale
 * rather than as a change. The unit needs a poll or two before it reports
 * the new mode, and its own boost flags can linger for a cycle.
 */
const MODE_WRITE_SETTLE_MS = 2 * POLL_INTERVAL;

/** Writes that belong together; once a critical step fails, the rest is skipped. */
interface WriteSequence {
  aborted: boolean;
}

interface WriteOptions {
  /** What is written, for the log, e.g. 'coil 10=1'. */
  label: string;
  sequence?: WriteSequence;
  /** A step the sequence cannot do without, such as the stop coil or the mode's own coil. */
  critical?: boolean;
  /** The device setting the write belongs to, so the poll does not mirror it back meanwhile. */
  setting?: string;
}

interface QueuedWrite extends WriteOptions {
  op: () => Promise<unknown>;
  attempts: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** A mode written from Homey that the unit has not confirmed yet. */
interface PendingMode {
  value: string;
  prior: unknown;
  until: number;
}

/** One step of a mode sequence: a coil or holding register write. */
type ModeStep = { coil: number; value: boolean; critical?: boolean } | { hreg: number; value: number; critical?: boolean };

export type { FlowCardIds };

/**
 * Shared implementation for all drivers. eWind and eAir only provide
 * capability names, flow card ids and register maps; EDA also overrides
 * the write function codes, mode coils and status decoding through the
 * protected hooks. Connection, polling and the write queue are shared.
 */
export abstract class ExventModbusDevice extends Homey.Device {
    /** e.g. 'eWindstatus' */
    protected abstract readonly statusCapability: string;
    /** e.g. 'eWindstatus_mode' */
    protected abstract readonly statusModeCapability: string;
    /** The writable capability that allows or blocks heating (coil 54). */
    protected readonly heatingCoilCapability: string = 'heating_coil_state';
    protected abstract readonly driverCards: DriverCards;

    /**
     * Whether writes use "write multiple coils/registers" (function codes 15
     * and 16) instead of "write single" (5 and 6). Some gateways acknowledge
     * a single write without passing it on to the unit.
     */
    protected readonly useMultipleWrites: boolean = false;

    /**
     * The Modbus unit ID to address, given the device's unit_id setting.
     * Called without it at startup; drivers with the setting read it then.
     */
    protected modbusUnitId(setting?: unknown): number {
      return MODBUS_UNIT_ID;
    }

    /** Whether the unit has the Enhanced ventilation mode (panel fan speed level 3 in HREG 50). */
    protected readonly enhancedVentilation: boolean = true;

    /** The target temperatures the unit accepts, in °C, and the step they are rounded to. */
    protected readonly setpointRange: [number, number] = [15, 22];
    protected readonly setpointStep: number = 1;

    /**
     * Holding registers the overpressure duration setting is written to. On
     * eWind and eAir HREG 56 is the active duration, but the unit overwrites
     * it at startup with the default in HREG 57, so both are written. EDA
     * units run overpressure for the minutes in HREG 56 too.
     */
    protected readonly overpressureDurationRegisters: number[] = [56, 57];

    /** The range of the boost duration setting (HREG 66), on drivers that have it. */
    protected readonly boostDurationRange: [number, number] = [1, 500];

    /**
     * Mode coils of which only one may be on, and the coil of each mode.
     * When set, Home, Away, Overpressure and Boost start the unit, turn their
     * own coil on and then all the others off; Off only sets the stop coil.
     * Empty on eWind and eAir, which keep their sequences in modeSteps.
     */
    protected readonly exclusiveModeCoils: number[] = [];
    protected readonly modeCoils: Record<string, number | null> = {};

    /** The long away coil, turned off by Home and Enhanced ventilation, on units that have one. */
    protected readonly longAwayCoil: number | null = null;

    /** Whether the alarm texts use the EDA names. */
    protected readonly edaAlarmNames: boolean = false;

    registers: RegisterMap = { ...EXVENT_HOLDING_REGISTERS };
    coilRegisters: RegisterMap = { ...EXVENT_COILS };

    socket: net.Socket | null = null;
    client: any = null;

    modbusOptions = {
      host: String(this.getSetting('address') ?? '').trim(),
      port: this.getSetting('port'),
      unitId: this.modbusUnitId(),
    };

    /** Whether the unit is boosting the fans on its own (HREG 44 bits 64, 128 and 256). */
    unitBoosting: boolean | undefined;

    private intervalId: any = null;
    private connectionRetryId: any = null;
    private confirmPollTimeout: any = null;
    private capabilityListenersRegistered: boolean = false;
    private pollingInProgress: boolean = false;
    private pollAgain: boolean = false;
    private isActive: boolean = true;
    private isConnected: boolean = false;
    private connectingPromise: Promise<void> | null = null;
    private connectAttempt: { reject: (err: Error) => void; timer: any } | null = null;
    private socketHandlers: Array<[string, (...args: any[]) => void]> = [];
    private connectionRetryDelay: number = CONNECTION_RETRY_MIN;
    private writeQueue: QueuedWrite[] = [];
    private drainingWriteQueue: boolean = false;
    private failedPolls: number = 0;
    private warningShown: boolean = false;
    /** Mode sequences queued or on their way to the unit. */
    private modeWritesPending: number = 0;
    private pendingMode: PendingMode | null = null;
    /** Setting writes queued or on their way, per setting. */
    private readonly settingWritesPending = new Map<string, number>();
    /** Counts finished setting writes, so a poll that started before one does not mirror it back. */
    private settingWriteSeq: number = 0;
    private settingsSaving: boolean = false;
    private loggedSetpoint: number | undefined;
    private loggedDurationMismatch: string | undefined;
    private modeLog: any = null;

    // ---------------------------------------------------------------- lifecycle

    async onInit() {
      this.isActive = true;
      await this.syncCapabilities();
      this.registerCapabilityListeners();
      this.connectSocket();
      this.modeLog = await this.openModeLog();
      this.intervalId = this.homey.setInterval(() => {
        if (this.isActive) this.pollDevice().catch(this.error);
      }, POLL_INTERVAL);
      // Not awaited: a unit that does not answer must not hold up the start.
      this.pollDevice().catch(this.error);
    }

    async onAdded() {
      this.homey.setTimeout(() => {
        if (this.isActive) this.pollDevice().catch(this.error);
      }, 10000);
    }

    async onUninit() {
      this.cleanup();
    }

    async onDeleted() {
      this.cleanup();
      if (this.modeLog) await this.homey.insights.deleteLog(this.modeLog).catch(this.error);
      this.modeLog = null;
    }

    /** Stops polling and reconnecting and closes the socket. Safe to call more than once. */
    cleanup() {
      this.isActive = false;
      if (this.intervalId) {
        this.homey.clearInterval(this.intervalId);
        this.intervalId = null;
      }
      if (this.confirmPollTimeout) {
        this.homey.clearTimeout(this.confirmPollTimeout);
        this.confirmPollTimeout = null;
      }
      this.clearRetryConnection();
      for (const item of this.writeQueue.splice(0)) item.reject(new Error('Device removed'));
      this.capabilityListenersRegistered = false;
      this.teardownSocket();
    }

    delay(ms: number) {
      return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
    }

    /**
     * Guard against acting on stale/deleted devices; Homey returns 404 when a
     * flow or capability change targets a missing device entry.
     */
    isUsable(): boolean {
      return this.isActive && this.getAvailable();
    }

    get flowCardIds(): FlowCardIds {
      return this.driverCards.ids;
    }

    get statusModeCapabilityId(): string {
      return this.statusModeCapability;
    }

    get heatingCoilCapabilityId(): string {
      return this.heatingCoilCapability;
    }

    // --------------------------------------------------------------- connection

    private attachSocketListeners(socket: net.Socket) {
      socket.setKeepAlive(true, 30 * 1000);
      socket.setTimeout(0);
      // Only this socket's own events count; a socket that has been replaced
      // may still report its end after the new one is up.
      const onGone = (err?: any) => {
        if (!this.isActive || socket !== this.socket) return;
        const wasConnected = this.isConnected;
        this.teardownSocket();
        if (wasConnected) this.log(`Connection to ${this.modbusOptions.host} lost${err ? `: ${describeError(err)}` : ''}`);
        this.retryConnection();
      };
      const onConnect = () => {
        if (!this.isActive || socket !== this.socket) return;
        this.isConnected = true;
        this.connectionRetryDelay = CONNECTION_RETRY_MIN;
        this.clearRetryConnection();
        this.log(`Connected to ${this.modbusOptions.host}:${this.modbusOptions.port}`);
      };
      this.socketHandlers = [['end', () => onGone()], ['error', onGone], ['close', () => onGone()], ['connect', onConnect]];
      for (const [event, handler] of this.socketHandlers) socket.on(event, handler);
    }

    /**
     * Starts a connection attempt unless one is under way. The attempt ends
     * with the connect event, an error, a close, or CONNECT_TIMEOUT_MS.
     */
    connectSocket() {
      if (!this.isActive || this.connectingPromise) return;
      this.teardownSocket();
      const socket = new net.Socket();
      this.socket = socket;

      // The attempt's own listeners go first, so a failed attempt rejects
      // with its own error before the socket listeners tear it down.
      const promise = new Promise<void>((resolve, reject) => {
        const timer = this.homey.setTimeout(() => socket.destroy(new Error('Connect timeout')), CONNECT_TIMEOUT_MS);
        const done = (err?: Error) => {
          this.homey.clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        this.connectAttempt = { reject: done, timer };
        socket.once('connect', () => done());
        socket.once('error', (err: Error) => done(err));
        socket.once('close', () => done(new Error('Socket closed')));
        socket.connect({ host: this.modbusOptions.host, port: this.modbusOptions.port });
      });
      this.attachSocketListeners(socket);
      this.client = new Modbus.client.TCP(socket, this.modbusOptions.unitId, MODBUS_TIMEOUT);
      const settled = promise.finally(() => {
        // A newer attempt may have replaced this one; leave its state alone.
        if (this.connectingPromise === settled) {
          this.connectingPromise = null;
          this.connectAttempt = null;
        }
      });
      // Callers awaiting via ensureConnected() see the rejection; this guard
      // only prevents an unhandled rejection when nobody is waiting.
      settled.catch(() => {});
      this.connectingPromise = settled;
    }

    retryConnection() {
      if (!this.isActive) return; // Do not retry if device has been deleted
      if (this.connectionRetryId || this.connectingPromise) return;
      this.connectionRetryId = this.homey.setTimeout(() => {
        this.connectionRetryId = null;
        if (!this.isActive) return;
        this.connectSocket();
        this.connectionRetryDelay = Math.min(CONNECTION_RETRY_MAX, this.connectionRetryDelay * 2);
      }, this.connectionRetryDelay);
    }

    clearRetryConnection() {
      if (this.connectionRetryId) {
        this.homey.clearTimeout(this.connectionRetryId);
        this.connectionRetryId = null;
      }
    }

    /**
     * Closes the socket. Only this app's own listeners are removed, so
     * jsmodbus still sees the close and rejects its pending requests at once
     * instead of letting each of them time out. An attempt still under way
     * is rejected, so nothing waits on it forever.
     */
    teardownSocket() {
      const socket = this.socket;
      const attempt = this.connectAttempt;
      this.socket = null;
      this.client = null;
      this.isConnected = false;
      this.connectingPromise = null;
      this.connectAttempt = null;
      if (socket) {
        for (const [event, handler] of this.socketHandlers) socket.off(event, handler);
        this.socketHandlers = [];
        // A late error from the closed socket must not become an unhandled event.
        socket.on('error', () => {});
        socket.destroy();
      }
      if (attempt) attempt.reject(new Error('Socket torn down'));
    }

    ensureConnected(): Promise<void> {
      if (this.isConnected) return Promise.resolve();
      if (!this.connectingPromise) this.connectSocket();
      return this.connectingPromise ?? Promise.reject(new Error(this.homey.__('noConnection')));
    }

    // ------------------------------------------------------------------ polling

    /**
     * Reads the unit. A poll asked for while one is running (such as the
     * confirmation poll after a write) runs again as soon as it is done.
     */
    async pollDevice() {
      if (!this.isActive) return;
      if (this.pollingInProgress) {
        this.pollAgain = true;
        return;
      }
      this.pollingInProgress = true;
      try {
        do {
          this.pollAgain = false;
          await this.pollOnce();
        } while (this.pollAgain && this.isActive);
      } finally {
        this.pollingInProgress = false;
      }
    }

    private async pollOnce() {
      try {
        await this.ensureConnected();
      } catch (err) {
        await this.pollFailed(err);
        return;
      }
      const { client } = this;
      const seq = this.settingWriteSeq;
      let result: Record<string, Measurement>;
      try {
        const holding = await readModbus(client, this.registers, 'holding');
        const coils = await readModbus(client, this.coilRegisters, 'coil');
        result = { ...holding, ...coils };
      } catch (err) {
        // Only the connection this poll used is torn down: a newer one may
        // already have replaced it while the poll was timing out.
        if (this.client === client) {
          this.teardownSocket();
          this.retryConnection();
        }
        await this.pollFailed(err);
        return;
      }
      if (!this.isActive) return;
      await this.pollSucceeded();
      try {
        await this.processResult(result, seq);
      } catch (err) {
        this.error('Could not process the values read from the unit:', err);
      }
      try {
        await this.setCapabilityValue(
          'lastPollTime',
          new Date().toLocaleString(this.homey.i18n.getLanguage(), { timeZone: this.homey.clock.getTimezone(), hour12: false }),
        );
      } catch (err) {
        // Ignore errors if device is deleted
      }
    }

    private async pollFailed(err: unknown) {
      if (!this.isActive) return;
      this.failedPolls++;
      if (this.failedPolls === 1) this.log(`Poll failed: ${describeError(err)}`);
      if (this.failedPolls >= NO_CONNECTION_WARNING_AFTER) await this.showWarning('noConnectionWarning');
    }

    private async pollSucceeded() {
      if (this.failedPolls > 0) this.log(`Unit answers again after ${this.failedPolls} failed poll(s)`);
      this.failedPolls = 0;
      if (this.warningShown) {
        this.warningShown = false;
        await this.unsetWarning().catch(this.error);
      }
    }

    private async showWarning(key: string) {
      if (!this.isActive || this.warningShown) return;
      this.warningShown = true;
      await this.setWarning(this.homey.__(key)).catch(this.error);
    }

    /**
     * Re-read the device shortly after commands have been sent, so Homey
     * reflects the unit's actual state without waiting for the next
     * 60-second poll.
     */
    private scheduleConfirmationPoll() {
      if (!this.isActive) return;
      if (this.confirmPollTimeout) this.homey.clearTimeout(this.confirmPollTimeout);
      this.confirmPollTimeout = this.homey.setTimeout(() => {
        this.confirmPollTimeout = null;
        if (this.isActive) this.pollDevice().catch(this.error);
      }, CONFIRM_POLL_DELAY_MS);
    }

    // -------------------------------------------------------------- write queue

    /**
     * Writes are serialized through a FIFO queue with a pause between each
     * command, so concurrent flows/capability changes cannot cancel each
     * other's writes and the Modbus module is never flooded. The promise
     * settles when the write has been sent or has finally failed.
     */
    protected enqueueWrite(op: () => Promise<unknown>, options: WriteOptions): Promise<void> {
      if (!this.isActive) return Promise.reject(new Error('Device removed'));
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Callers that do not wait for the write must not cause an unhandled rejection.
      promise.catch(() => {});
      if (options.setting) this.settingWritesPending.set(options.setting, (this.settingWritesPending.get(options.setting) ?? 0) + 1);
      const settle = () => {
        if (!options.setting) return;
        const left = (this.settingWritesPending.get(options.setting) ?? 1) - 1;
        if (left > 0) this.settingWritesPending.set(options.setting, left);
        else this.settingWritesPending.delete(options.setting);
        this.settingWriteSeq++;
      };
      this.writeQueue.push({
        ...options,
        op,
        attempts: 0,
        resolve: () => {
          settle();
          resolve();
        },
        reject: (err) => {
          settle();
          reject(err);
        },
      });
      this.drainWriteQueue().catch(this.error);
      return promise;
    }

    private async drainWriteQueue() {
      if (this.drainingWriteQueue) return;
      this.drainingWriteQueue = true;
      let didWrite = false;
      let failed = false;
      try {
        while (this.isActive && this.writeQueue.length > 0) {
          const item = this.writeQueue[0];
          if (item.sequence && item.sequence.aborted) {
            this.writeQueue.shift();
            item.reject(new Error(this.homey.__('writeFailed')));
            continue;
          }
          const { client } = this;
          try {
            await this.ensureConnected();
            await item.op();
            this.writeQueue.shift();
            item.resolve();
            didWrite = true;
          } catch (err) {
            item.attempts++;
            const failure = requestFailure(err);
            if (failure === 'exception' || item.attempts > WRITE_RETRIES) {
              this.writeQueue.shift();
              failed = true;
              if (item.sequence && item.critical) item.sequence.aborted = true;
              this.error(`Write ${item.label} failed${failure === 'exception' ? '' : ` after ${item.attempts} attempts`}: ${describeError(err)}`);
              item.reject(new Error(this.homey.__('writeFailed')));
            } else {
              // An answer that came too late or a dead connection leaves the
              // transaction stream out of step: start over on a new connection.
              // An out-of-sync write most likely reached the unit already; all
              // writes are absolute values, so sending it again is harmless.
              if ((failure === 'timeout' || failure === 'outOfSync') && this.client === client) this.teardownSocket();
              this.log(`Write ${item.label} ${failure === 'outOfSync' ? 'unconfirmed' : 'failed'} (${describeError(err)}), trying again`);
            }
          }
          if (this.writeQueue.length > 0) await this.delay(WRITE_SPACING_MS);
        }
      } finally {
        this.drainingWriteQueue = false;
        if (failed) await this.showWarning('writeFailedWarning');
        if (didWrite || failed) this.scheduleConfirmationPoll();
      }
    }

    sendHoldingRequest(register: number, value: number, options: Partial<WriteOptions> = {}): Promise<void> {
      return this.enqueueWrite(() => (this.useMultipleWrites
        ? this.client.writeMultipleRegisters(register, [value & 0xffff])
        : this.client.writeSingleRegister(register, value)), { label: `hreg ${register}=${value}`, ...options });
    }

    sendCoilRequest(register: number, value: boolean, options: Partial<WriteOptions> = {}): Promise<void> {
      return this.enqueueWrite(() => (this.useMultipleWrites
        ? this.client.writeMultipleCoils(register, [value])
        : this.client.writeSingleCoil(register, value)), { label: `coil ${register}=${value ? 1 : 0}`, ...options });
    }

    // -------------------------------------------------------------------- modes

    /**
     * The writes that put the unit in a mode. The stop coil and the mode's
     * own coil are critical: if one of them does not get through, the rest is
     * skipped and the unit stays in the mode it had. The mode's coil goes on
     * before the others go off, so a running unit does not pass through Home
     * between two modes.
     */
    protected modeSteps(value: string): ModeStep[] {
      const off = (coil: number): ModeStep => ({ coil, value: false });
      if (this.exclusiveModeCoils.length > 0 && value in this.modeCoils) {
        const modeCoil = this.modeCoils[value];
        return [
          { coil: 0, value: false, critical: true },
          ...(modeCoil !== null ? [{ coil: modeCoil, value: true, critical: true }] : []),
          ...this.exclusiveModeCoils.filter((coil) => coil !== modeCoil).map(off),
        ];
      }
      const longAway = this.longAwayCoil !== null ? [off(this.longAwayCoil)] : [];
      switch (value) {
        case '0':
          // Leave enhanced ventilation by returning the panel fan speed to
          // level 2 (Home); harmless when already at level 2.
          return [{ coil: 0, value: false, critical: true }, off(1), off(3), off(10), ...longAway,
            ...(this.enhancedVentilation ? [{ hreg: 50, value: 2, critical: true }] : [])];
        case '1':
          return [{ coil: 0, value: false, critical: true }, { coil: 1, value: true, critical: true }, off(3), off(10)];
        case '2':
          return [{ coil: 0, value: false, critical: true }, { coil: 3, value: true, critical: true }, off(1), off(10)];
        case '3':
          return [{ coil: 0, value: false, critical: true }, { coil: 10, value: true, critical: true }, off(1), off(3)];
        case '4':
          return [{ coil: 0, value: true, critical: true }];
        case '5':
          // Enhanced ventilation: normal operation at panel fan speed
          // level 3 ("Home-mode with high fan speeds", HREG 50).
          return [{ coil: 0, value: false, critical: true }, off(1), off(3), off(10), ...longAway,
            { hreg: 50, value: 3, critical: true }];
        default:
          return [];
      }
    }

    /**
     * Writes the coil sequence of a status mode. Resolves once every write
     * has gone out and the capability shows the mode; rejects when a
     * critical step failed, after putting the capability back to `prior`.
     * While the sequence is under way the poll leaves the mode alone, and
     * for a while afterwards a reading of the previous mode counts as stale.
     */
    async setStatusModeValue(value: string, prior: unknown = this.getCapabilityValue(this.statusModeCapability)): Promise<void> {
      if (value === '5' && !this.enhancedVentilation) throw new Error(this.homey.__('modeNotSupported'));
      const steps = this.modeSteps(value);
      if (steps.length === 0) throw new Error(this.homey.__('modeNotSupported'));
      const sequence: WriteSequence = { aborted: false };
      this.modeWritesPending++;
      try {
        const writes = steps.map((step) => ('coil' in step
          ? this.sendCoilRequest(step.coil, step.value, { sequence, critical: step.critical })
          : this.sendHoldingRequest(step.hreg, step.value, { sequence, critical: step.critical })));
        writes.push(this.enqueueWrite(async () => {
          if (this.isActive) await this.setCapabilityValue(this.statusModeCapability, value);
          await this.recordMode(value);
        }, { label: `mode ${value}`, sequence }));
        const results = await Promise.allSettled(writes);
        if (sequence.aborted) {
          if (this.isActive && this.getCapabilityValue(this.statusModeCapability) !== prior && typeof prior === 'string') {
            await this.setCapabilityValue(this.statusModeCapability, prior).catch(this.error);
          }
          throw new Error(this.homey.__('writeFailed'));
        }
        if (results.some((result) => result.status === 'rejected')) {
          this.log(`Mode ${value} is set, but a step turning another mode off failed`);
        }
        this.pendingMode = { value, prior, until: Date.now() + MODE_WRITE_SETTLE_MS };
      } finally {
        this.modeWritesPending--;
      }
    }

    /**
     * Changes the mode from Homey, as the Set mode card and the mode picker
     * do, and fires the mode trigger once the unit has been told, so flows
     * see the change whoever made it.
     */
    async changeMode(value: string, previous: unknown = this.getCapabilityValue(this.statusModeCapability)) {
      await this.setStatusModeValue(value, previous);
      if (previous !== value) await this.fireModeChanged(this.driverCards.ids.statusModeChanged, value, this.statusModeCapability);
    }

    /**
     * Ends the pending mode of the last mode write once every write queued
     * so far has gone out, so the poll after that fires the mode trigger
     * again when the unit changes mode.
     */
    protected endModeWriteSettleAfterQueue() {
      this.enqueueWrite(async () => {
        this.pendingMode = null;
      }, { label: 'end of mode write' }).catch(this.error);
    }

    /**
     * Starts boost ('3') or fireplace mode ('2') for a number of minutes. The
     * duration is a setting stored on the unit, so it is written only when
     * it differs from what the unit has, before the mode itself.
     */
    async startModeFor(mode: '2' | '3', minutes: unknown) {
      const setting = mode === '3' ? 'boost_duration_minutes' : 'fireplace_duration_minutes';
      const range: [number, number] = mode === '3' ? this.boostDurationRange : [1, 60];
      const value = inRange(minutes, range);
      if (value === undefined || !Number.isInteger(value)) throw new Error(this.homey.__('invalidDuration'));
      if (this.getSetting(setting) !== value) {
        await Promise.all(this.durationWrites(setting, value));
        await this.setSettings({ [setting]: value }).catch(this.error);
      }
      await this.changeMode(mode);
    }

    private durationWrites(setting: string, minutes: number): Array<Promise<void>> {
      const registers = setting === 'boost_duration_minutes' ? [66] : this.overpressureDurationRegisters;
      return registers.map((register) => this.sendHoldingRequest(register, minutes, { setting }));
    }

    // -------------------------------------------------------- simple commands

    async setEcoMode(value: string) {
      await this.sendCoilRequest(40, value === '1');
      await this.setIfChanged('ecomode_mode', value === '1' ? '1' : '0');
    }

    async setHeatingCoil(value: string) {
      await this.sendCoilRequest(54, value === '1');
      await this.setIfChanged(this.heatingCoilCapability, value === '1' ? '1' : '0');
    }

    /** Writes the target temperature, rounded to the unit's step and kept within its range. */
    async setTargetTemperature(value: unknown) {
      const number = toNumber(value);
      const temperature = number === undefined ? undefined : Math.round(number / this.setpointStep) * this.setpointStep;
      if (temperature === undefined || inRange(temperature, this.setpointRange) === undefined) {
        throw new Error(this.homey.__('invalidTemperature'));
      }
      await this.sendHoldingRequest(135, Math.round(temperature * 10));
      await this.setIfChanged('target_temperature.step', temperature);
    }

    /** HREG 710 counts days since the service reminder was acknowledged; 0 restarts the filter countdown. */
    async resetFilterReminder() {
      await this.sendHoldingRequest(710, 0);
    }

    // ------------------------------------------------------------ capabilities

    /** Capabilities every device of this driver should have. */
    protected capabilityIds(): string[] {
      return [
        'efficiency.supplyEff',
        'efficiency.extractEff',
        'measure_temperature.outsideAir',
        'measure_temperature.step',
        'measure_temperature.exhaustAir',
        'measure_temperature.extractAir',
        'measure_temperature.supplyAirHRC',
        'ecomode_mode',
        'heater_mode',
        this.heatingCoilCapability,
        'heat_exchanger_mode',
        'target_temperature.step',
        'alarm_a',
        'alarm_b.desc',
        'active_alarm',
        'filter_days_remaining',
        'measure_humidity.extractAir',
        'fanspeed_level',
        this.statusCapability,
        this.statusModeCapability,
        'boost',
        'heat_recovery_output',
        'after_heating_output',
        'season',
        'button.reset_filter',
        'lastPollTime',
      ];
    }

    private async syncCapabilities() {
      for (const capability of this.capabilityIds()) {
        if (!this.hasCapability(capability)) {
          await this.addCapability(capability).catch(this.error);
        }
      }
    }

    registerCapabilityListeners() {
      if (this.capabilityListenersRegistered) return;

      // The picker is not held up by the writes; the mode trigger fires once
      // they have gone out, and a failure puts the picker back.
      this.registerCapabilityListener(this.statusModeCapability, async (value) => {
        if (!this.isUsable()) return;
        const previous = this.getCapabilityValue(this.statusModeCapability);
        this.changeMode(value, previous).catch((err) => this.error(`Mode ${value}:`, describeError(err)));
      });

      this.registerCapabilityListener('target_temperature.step', async (value) => {
        if (!this.isUsable()) return;
        this.sendHoldingRequest(135, Math.round(Number(value) * 10)).catch(this.error);
      });

      if (this.hasCapability('ecomode_mode')) {
        this.registerCapabilityListener('ecomode_mode', async (value) => {
          if (!this.isUsable()) return;
          this.sendCoilRequest(40, value === '1').catch(this.error);
        });
      }

      this.registerCapabilityListener(this.heatingCoilCapability, async (value) => {
        if (!this.isUsable()) return;
        let coilValue: boolean | null = null;
        if (value === true || value === '1' || value === 'true') {
          coilValue = true;
        } else if (value === false || value === '0' || value === 'false') {
          coilValue = false;
        }
        if (coilValue !== null) {
          this.sendCoilRequest(54, coilValue).catch(this.error);
        }
      });

      if (this.hasCapability('boost')) {
        // The quick action: on starts boost like the mode picker; off only
        // ends boost, and the poll then reports the mode the unit went back to.
        this.registerCapabilityListener('boost', async (value) => {
          if (!this.isUsable()) return;
          if (value) {
            this.changeMode('3').catch((err) => this.error('Boost:', describeError(err)));
          } else {
            this.sendCoilRequest(10, false).catch(this.error);
            this.endModeWriteSettleAfterQueue();
          }
        });
      }

      if (this.hasCapability('button.reset_filter')) {
        this.registerCapabilityListener('button.reset_filter', async () => {
          if (!this.isUsable()) throw new Error(this.homey.__('noConnection'));
          await this.resetFilterReminder();
        });
      }

      this.capabilityListenersRegistered = true;
    }

    /**
     * Fires one of the *_changed trigger cards. The new value is passed as
     * trigger state so the card's dropdown argument can be compared against
     * it, and its name as the mode token.
     */
    protected async fireModeChanged(cardId: string, mode: string, capabilityId: string) {
      await this.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(this, { mode: this.valueTitle(capabilityId, mode) }, { mode })
        .catch(this.error);
    }

    /** The title of an enum capability value in the Homey's language, e.g. 'Hjemme'. */
    private valueTitle(capabilityId: string, value: string): string {
      const definition = this.homey.manifest?.capabilities?.[capabilityId];
      const entry = definition?.values?.find((item: any) => item.id === value);
      const title = entry?.title;
      if (!title) return value;
      if (typeof title === 'string') return title;
      return title[this.homey.i18n.getLanguage()] ?? title.en ?? value;
    }

    protected async setIfChanged(capabilityId: string, value: any) {
      try {
        if (!this.hasCapability(capabilityId)) return;
        const current = this.getCapabilityValue(capabilityId);
        if (current === value) return;
        await this.setCapabilityValue(capabilityId, value);
      } catch (_) {
        // Ignore capability errors (e.g., device deleted)
      }
    }

    // ------------------------------------------------------------ mode insights

    /** A number log of the mode, since Insights does not log enum capabilities. */
    private async openModeLog(): Promise<any> {
      const data = this.getData();
      const id = `mode${String(data && data.id ? data.id : '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (id === 'mode' || !this.homey.insights) return null;
      try {
        return await this.homey.insights.getLog(id);
      } catch (_) {
        try {
          return await this.homey.insights.createLog(id, {
            title: `${this.getName()}: ${this.homey.__('modeLogTitle')}`,
            type: 'number',
            decimals: 0,
          });
        } catch (err) {
          this.error('Could not create the mode log:', err);
          return null;
        }
      }
    }

    private async recordMode(value: string) {
      if (this.modeLog) await this.modeLog.createEntry(Number(value)).catch(this.error);
    }

    // ----------------------------------------------------------------- settings

    async onSettings({ newSettings, changedKeys }: { oldSettings?: Record<string, any>; newSettings: Record<string, any>; changedKeys: string[] }): Promise<string | void> {
      const connectionChanged = ['address', 'port', 'unit_id'].some((key) => changedKeys.includes(key));
      this.validateSettings(newSettings, changedKeys);

      this.settingsSaving = true;
      try {
        // A new address goes first, so the writes below reach the new unit.
        if (connectionChanged) {
          this.modbusOptions.host = String(newSettings.address).trim();
          this.modbusOptions.port = Number(newSettings.port);
          this.modbusOptions.unitId = this.modbusUnitId(newSettings.unit_id);
          this.clearRetryConnection();
          this.teardownSocket();
          this.connectionRetryDelay = CONNECTION_RETRY_MIN;
          this.failedPolls = 0;
          this.connectSocket();
        }

        const writes = this.unitSettingWrites(newSettings, changedKeys);
        if (writes.length > 0) {
          if (!connectionChanged && !this.isConnected && this.failedPolls > 0) {
            throw new Error(this.homey.__('settingsWriteFailed'));
          }
          try {
            await withTimeout(Promise.all(writes), SETTINGS_WRITE_TIMEOUT_MS, () => new Error(this.homey.__('settingsWriteFailed')));
          } catch (err) {
            // A new address is saved even when the unit's settings could not
            // be written; the poll then shows what the unit has.
            if (connectionChanged) return this.homey.__('settingsWriteFailedAddressSaved');
            throw new Error(this.homey.__('settingsWriteFailed'));
          }
        }
      } finally {
        this.settingsSaving = false;
      }
      if (connectionChanged) this.pollDevice().catch(this.error);
      return undefined;
    }

    /** Throws a message naming the first changed setting that is not valid. */
    protected validateSettings(settings: Record<string, any>, changedKeys: string[]) {
      if (changedKeys.includes('address') && !isValidHost(settings.address)) {
        throw new Error(this.homey.__('settings.invalidAddress'));
      }
      if (changedKeys.includes('port') && !isValidPort(settings.port)) {
        throw new Error(this.homey.__('settings.invalidPort'));
      }
      const whole = (id: string, range: [number, number]) => {
        if (!changedKeys.includes(id)) return;
        const value = inRange(settings[id], range);
        if (value === undefined || !Number.isInteger(value)) {
          throw new Error(this.homey.__('settings.invalidNumber', { range: `${range[0]}–${range[1]}` }));
        }
      };
      whole('filter_interval_days', [1, 365]);
      whole('fireplace_duration_minutes', [1, 60]);
      whole('boost_duration_minutes', this.boostDurationRange);
    }

    /** Queues the writes of the changed settings that live on the unit. */
    protected unitSettingWrites(settings: Record<string, any>, changedKeys: string[]): Array<Promise<unknown>> {
      const writes: Array<Promise<unknown>> = [];
      // HREG 538: number of days after a reset before the filter change
      // reminder is raised. The confirmation poll refreshes the countdown.
      if (changedKeys.includes('filter_interval_days')) {
        writes.push(this.sendHoldingRequest(538, Number(settings.filter_interval_days), { setting: 'filter_interval_days' }));
      }
      for (const id of ['fireplace_duration_minutes', 'boost_duration_minutes']) {
        if (changedKeys.includes(id)) writes.push(...this.durationWrites(id, Number(settings[id])));
      }
      return writes;
    }

    /**
     * Whether the poll may copy a value read from the unit into a device
     * setting. Not while the settings dialog is saving, while a write of the
     * setting is queued, or when a setting write finished after the poll
     * started reading: the unit's value may be from before the write.
     */
    protected mayMirrorSetting(id: string, value: number | boolean, pollSeq?: number): boolean {
      if (this.settingsSaving || this.settingWritesPending.has(id)) return false;
      return pollSeq === undefined || pollSeq === this.settingWriteSeq;
    }

    private async mirrorSetting(id: string, value: number | boolean, pollSeq?: number) {
      if (this.isActive && this.getSetting(id) !== value && this.mayMirrorSetting(id, value, pollSeq)) {
        await this.setSettings({ [id]: value }).catch(this.error);
      }
    }

    // --------------------------------------------------------------- decoding

    /** The status capability value for a HREG 45 reading, or undefined when it has none. */
    protected statusFromRegister(value: string): string | undefined {
      return exventStatus(Number(value));
    }

    /**
     * The status mode capability value for a HREG 44 reading, or undefined
     * when the reading has no mode. `result` holds the rest of the same poll.
     */
    protected statusModeFromRegister(value: string, result: Record<string, Measurement>): string | undefined {
      const state = Number(value);
      if (!Number.isFinite(state)) return undefined;
      const level = result['fan_speed_level'] && result['fan_speed_level'].value !== 'xxx'
        ? Number(result['fan_speed_level'].value) : undefined;
      return exventStatusMode(state, level);
    }

    /**
     * Applies a mode read from the unit. Our own writes are left alone while
     * they are under way. After a write, the mode written confirms it, a
     * reading of the previous mode counts as stale until MODE_WRITE_SETTLE_MS
     * is up, and any other mode is a real change. Changes the unit makes on
     * its own (panel, its own CO2/RH boost, the boost timer running out)
     * fire the mode trigger here, since no capability listener sees them.
     */
    private async applyModeReading(mapped: string) {
      if (this.modeWritesPending > 0) return;
      const pending = this.pendingMode;
      if (pending && Date.now() < pending.until) {
        if (mapped === pending.value) {
          this.pendingMode = null;
          await this.setIfChanged(this.statusModeCapability, mapped);
          return;
        }
        if (mapped === pending.prior) return;
      }
      this.pendingMode = null;
      const previous = this.getCapabilityValue(this.statusModeCapability);
      await this.setIfChanged(this.statusModeCapability, mapped);
      if (typeof previous === 'string' && previous !== mapped) {
        await this.recordMode(mapped);
        await this.fireModeChanged(this.driverCards.ids.statusModeChanged, mapped, this.statusModeCapability);
      }
    }

    /** The value of a reading, or undefined when the register did not answer. */
    protected reading(result: Record<string, Measurement>, key: string): string | undefined {
      const measurement = result[key];
      return measurement && measurement.value !== 'xxx' ? measurement.value : undefined;
    }

    async processResult(result: Record<string, Measurement>, pollSeq?: number) {
      if (!result) {
        return;
      }
      const number = (key: string) => {
        const value = this.reading(result, key);
        return value === undefined ? undefined : Number(value);
      };
      const tenths = (key: string, capabilityId: string) => {
        const value = number(key);
        return value === undefined ? undefined : this.setIfChanged(capabilityId, value / 10);
      };

      await tenths('air_outside', 'measure_temperature.outsideAir');
      await tenths('air_extract', 'measure_temperature.extractAir');
      await tenths('air_supply', 'measure_temperature.step');
      await tenths('air_supply_HRC', 'measure_temperature.supplyAirHRC');
      await tenths('air_exhaust', 'measure_temperature.exhaustAir');

      const setpoint = number('temperature_setpoint');
      if (setpoint !== undefined) {
        const temperature = setpoint / 10;
        if (inRange(temperature, this.setpointRange) !== undefined) {
          await this.setIfChanged('target_temperature.step', temperature);
        } else if (this.loggedSetpoint !== temperature) {
          // The capability cannot hold it, so the previous value stays shown.
          this.loggedSetpoint = temperature;
          this.log(`Target temperature ${temperature} °C is outside ${this.setpointRange.join('–')} °C and is not shown`);
        }
      }

      const humidity = number('air_humidity');
      if (humidity !== undefined) await this.setIfChanged('measure_humidity.extractAir', humidity);
      const supplyEff = number('air_supply_eff');
      if (supplyEff !== undefined) await this.setIfChanged('efficiency.supplyEff', supplyEff);
      const extractEff = number('air_extract_eff');
      if (extractEff !== undefined) await this.setIfChanged('efficiency.extractEff', extractEff);
      const fanLevel = number('fan_speed_level');
      if (fanLevel !== undefined) await this.setIfChanged('fanspeed_level', fanLevel);

      const output = number('controller_output');
      if (output !== undefined) {
        const outputs = controllerOutputs(output);
        await this.setIfChanged('heat_recovery_output', outputs.heatRecovery);
        await this.setIfChanged('after_heating_output', outputs.afterHeating);
      }
      const supplyFan = number('supply_fan_speed');
      if (supplyFan !== undefined) await this.setIfChanged('fan_output.supply', supplyFan);
      const extractFan = number('extract_fan_speed');
      if (extractFan !== undefined) await this.setIfChanged('fan_output.extract', extractFan);

      const average = number('outdoor_24h_average');
      const threshold = number('summer_winter_threshold');
      if (average !== undefined && threshold !== undefined) {
        await this.setIfChanged('season', average > threshold ? 'summer' : 'winter');
      }

      const status = this.reading(result, 'status');
      if (status !== undefined) {
        const mapped = this.statusFromRegister(status);
        if (mapped !== undefined) await this.setIfChanged(this.statusCapability, mapped);
      }

      const statusMode = this.reading(result, 'status_mode');
      if (statusMode !== undefined) {
        const mapped = this.statusModeFromRegister(statusMode, result);
        this.unitBoosting = (Number(statusMode) & UNIT_BOOST_BITS) !== 0;
        if (mapped !== undefined) {
          await this.applyModeReading(mapped);
          await this.setIfChanged('boost', this.getCapabilityValue(this.statusModeCapability) === '3');
        }
      }

      const eco = this.reading(result, 'eco_mode');
      if (eco === '0' || eco === '1') await this.setIfChanged('ecomode_mode', eco);

      await this.applyOnOff(result, 'heater_status', 'heater_mode', this.driverCards.ids.heaterChanged);
      await this.applyOnOff(result, 'heat_exchanger_state', 'heat_exchanger_mode', this.driverCards.ids.heatExchangerChanged);

      const heatingCoil = this.reading(result, 'heating_coil');
      if (heatingCoil === '0' || heatingCoil === '1') await this.setIfChanged(this.heatingCoilCapability, heatingCoil);

      await this.applyAlarms(result);

      // Mirror the unit's fireplace/overpressure duration in the device
      // settings. On units that report the default (HREG 57), that is the
      // duration kept after a power cut, so it is the one shown. setSettings
      // does not re-trigger onSettings, so this cannot loop.
      const active = number('fireplace_duration');
      const standard = number('fireplace_duration_default');
      if (active !== undefined && standard !== undefined && active !== standard
        && this.loggedDurationMismatch !== `${active}/${standard}`) {
        this.loggedDurationMismatch = `${active}/${standard}`;
        this.log(`Fireplace duration is ${active} min now but ${standard} min after a restart of the unit (HREG 56/57)`);
      }
      const duration = standard ?? active;
      if (duration !== undefined && inRange(duration, [1, 60]) !== undefined) {
        await this.mirrorSetting('fireplace_duration_minutes', duration, pollSeq);
      }

      const boostDuration = number('boost_duration');
      if (boostDuration !== undefined && inRange(boostDuration, this.boostDurationRange) !== undefined) {
        await this.mirrorSetting('boost_duration_minutes', boostDuration, pollSeq);
      }

      await this.applyFilterCountdown(result, pollSeq);
    }

    /** An on/off reading with a *_changed trigger fired on every change after the first reading. */
    private async applyOnOff(result: Record<string, Measurement>, key: string, capabilityId: string, cardId: string) {
      const value = this.reading(result, key);
      if (value !== '0' && value !== '1') return;
      const previous = this.getCapabilityValue(capabilityId);
      await this.setIfChanged(capabilityId, value);
      if (typeof previous === 'string' && previous !== value) {
        await this.fireModeChanged(cardId, value, capabilityId);
      }
    }

    /**
     * The A and B alarms (coils 41 and 42) with a trigger when one goes off,
     * and the newest alarm in the log (HREG 385/386) as text while it is on.
     */
    private async applyAlarms(result: Record<string, Measurement>) {
      const type = this.reading(result, 'alarm_type');
      const state = this.reading(result, 'alarm_state');
      const language = this.homey.i18n.getLanguage();
      const logText = type !== undefined && state !== undefined && alarmOn(Number(state)) && Number(type) > 0
        ? alarmText(Number(type), language, this.edaAlarmNames) : undefined;

      const alarms: Array<[string, string, string]> = [
        ['alarm_a', 'alarm_a', this.driverCards.ids.alarmATriggered],
        ['alarm_b_desc', 'alarm_b.desc', this.driverCards.ids.alarmBTriggered],
      ];
      const active: string[] = [];
      for (const [key, capabilityId, cardId] of alarms) {
        const value = this.reading(result, key);
        if (value !== '0' && value !== '1') continue;
        const on = value === '1';
        if (on) active.push(capabilityId);
        const wasOn = this.getCapabilityValue(capabilityId) === true;
        await this.setIfChanged(capabilityId, on);
        if (on && !wasOn) {
          const text = logText ?? this.homey.__(capabilityId === 'alarm_a' ? 'alarmA' : 'alarmB');
          await this.homey.flow.getDeviceTriggerCard(cardId)
            .trigger(this, { alarm: text })
            .catch(this.error);
        }
      }
      if (this.reading(result, 'alarm_a') !== undefined || this.reading(result, 'alarm_b_desc') !== undefined) {
        let text = this.homey.__('noAlarm');
        if (logText) text = logText;
        else if (active.includes('alarm_a')) text = this.homey.__('alarmA');
        else if (active.includes('alarm_b.desc')) text = this.homey.__('alarmB');
        await this.setIfChanged('active_alarm', text);
      }
    }

    /**
     * Days until the service reminder: configured interval (HREG 538) minus
     * days since the last acknowledgement (HREG 710), on units that have the
     * counter, while the reminder is on (coil 49).
     */
    private async applyFilterCountdown(result: Record<string, Measurement>, pollSeq?: number) {
      const intervalValue = this.reading(result, 'service_interval_days');
      if (intervalValue === undefined) return;
      const interval = Number(intervalValue);
      const counter = this.reading(result, 'days_since_service_ack');
      const reminder = this.reading(result, 'service_reminder');
      if (counter !== undefined) {
        const previous = this.getCapabilityValue('filter_days_remaining');
        const remaining = reminder === '0' ? null : Math.max(0, interval - Number(counter));
        await this.setIfChanged('filter_days_remaining', remaining);
        if (this.driverCards.ids.filterDaysBelow && typeof previous === 'number' && typeof remaining === 'number' && remaining < previous) {
          await this.homey.flow.getDeviceTriggerCard(this.driverCards.ids.filterDaysBelow)
            .trigger(this, { days: remaining }, { previous, current: remaining })
            .catch(this.error);
        }
      }
      // Mirror the unit's actual interval in the device settings. On units
      // with the counter this waits for a poll that read both registers.
      const hasCounter = 'days_since_service_ack' in this.registers;
      if ((counter !== undefined || !hasCounter) && inRange(interval, [1, 365]) !== undefined) {
        await this.mirrorSetting('filter_interval_days', interval, pollSeq);
      }
    }
}


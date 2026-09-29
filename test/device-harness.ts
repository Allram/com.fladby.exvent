/* eslint-disable max-classes-per-file */
// Runs the real device and driver classes without Homey or a unit: 'homey',
// 'net' and 'jsmodbus' are replaced by fakes, and a simulated unit records
// every write.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';

/** The repository root, from .homeybuild/test. */
export const ROOT = path.join(__dirname, '..', '..');

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// eslint-disable-next-line no-use-before-define
const units = new Map<string, FakeUnit>();

/** An error as jsmodbus rejects with, e.g. modbusError('Timeout'). */
export function modbusError(err: string) {
  return { err, message: `${err} (fake)` };
}

/** A unit on the network, addressed by the device's IP address setting. */
export class FakeUnit {
  hreg = new Map<number, number>();
  coils = new Map<number, boolean>();
  /** Every write, e.g. 'FC15 unit 1 coil 3=1' or 'FC6 unit 255 hreg 50=2'. */
  writes: string[] = [];
  reachable = true;
  /** When true, connections are accepted by nobody: the attempt never answers. */
  silent = false;
  /** When false, writes are recorded but not applied, as if still on their way. */
  applyWrites = true;
  /** When true, holding register 44 follows the stop and mode coils, as on an EDA unit. */
  deriveState = false;
  /** Registers and coils the unit answers with a Modbus exception, e.g. 'coil 16' or 'hreg 66'. */
  unreadable = new Set<string>();
  /** Writes that fail, e.g. 'coil 2' → ['Timeout', 'Timeout']: one error per attempt, then they succeed. */
  failWrites = new Map<string, string[]>();
  readonly address: string;

  static count = 0;

  constructor(hreg: Record<number, number> = {}, coils: Record<number, boolean> = {}) {
    FakeUnit.count++;
    this.address = `192.0.2.${FakeUnit.count}`;
    for (const [address, value] of Object.entries(hreg)) this.hreg.set(Number(address), value);
    for (const [address, value] of Object.entries(coils)) this.coils.set(Number(address), value);
    units.set(this.address, this);
  }

  holding(address: number): number {
    if (address === 44 && this.deriveState) {
      const bits: Array<[number, number]> = [[0, 8], [1, 16], [2, 32], [3, 1024], [10, 512]];
      return bits.reduce((state, [coil, bit]) => (this.coils.get(coil) ? state | bit : state), 0);
    }
    return this.hreg.get(address) ?? 0;
  }
}

class FakeSocket extends EventEmitter {
  host = '';
  destroyed = false;

  setKeepAlive() {
    return this;
  }

  setTimeout() {
    return this;
  }

  connect(options: { host: string }) {
    this.host = options.host;
    setImmediate(() => {
      if (this.destroyed) return;
      const unit = units.get(this.host);
      if (unit && unit.silent) return;
      if (unit && unit.reachable) this.emit('connect');
      else this.destroy(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    return this;
  }

  end() {}

  destroy(err?: Error) {
    if (this.destroyed) return;
    this.destroyed = true;
    setImmediate(() => {
      if (err) this.emit('error', err);
      this.emit('close');
    });
  }

  /** The unit closes the connection, as when it restarts. */
  drop() {
    this.emit('end');
    this.destroy();
  }
}

/** Every socket the fakes created, newest last. */
export const sockets: FakeSocket[] = [];
class TrackedSocket extends FakeSocket {
  constructor() {
    super();
    sockets.push(this);
  }
}

class FakeModbusClient {
  private socket: FakeSocket;
  private unitId: number;

  constructor(socket: FakeSocket, unitId: number) {
    this.socket = socket;
    this.unitId = unitId;
  }

  private get unit(): FakeUnit {
    if (this.socket.destroyed) throw modbusError('Offline');
    const unit = units.get(this.socket.host);
    if (!unit || !unit.reachable) throw modbusError('Timeout');
    return unit;
  }

  private checkReadable(kind: string, start: number, length: number) {
    for (let i = 0; i < length; i++) {
      if (this.unit.unreadable.has(`${kind} ${start + i}`)) throw modbusError('ModbusException');
    }
  }

  async readHoldingRegisters(start: number, length: number) {
    this.checkReadable('hreg', start, length);
    const buffer = Buffer.alloc(length * 2);
    const values = [];
    for (let i = 0; i < length; i++) {
      const value = this.unit.holding(start + i) & 0xffff;
      buffer.writeUInt16BE(value, i * 2);
      values.push(value);
    }
    return { response: { body: { valuesAsBuffer: buffer, valuesAsArray: values } } };
  }

  async readCoils(start: number, length: number) {
    this.checkReadable('coil', start, length);
    const values = [];
    for (let i = 0; i < length; i++) values.push(this.unit.coils.get(start + i) ? 1 : 0);
    return { response: { body: { valuesAsArray: values } } };
  }

  async writeSingleCoil(address: number, value: boolean) {
    this.writeCoil('FC5', address, value);
  }

  async writeMultipleCoils(address: number, values: boolean[]) {
    this.writeCoil('FC15', address, values[0]);
  }

  async writeSingleRegister(address: number, value: number) {
    this.writeRegister('FC6', address, value);
  }

  async writeMultipleRegisters(address: number, values: number[]) {
    this.writeRegister('FC16', address, values[0]);
  }

  private failIfAsked(target: string) {
    const failures = this.unit.failWrites.get(target);
    if (failures && failures.length > 0) throw modbusError(failures.shift()!);
  }

  private writeCoil(code: string, address: number, value: boolean) {
    const { unit } = this;
    this.failIfAsked(`coil ${address}`);
    unit.writes.push(`${code} unit ${this.unitId} coil ${address}=${value ? 1 : 0}`);
    if (unit.applyWrites) unit.coils.set(address, value);
  }

  private writeRegister(code: string, address: number, value: number) {
    const { unit } = this;
    this.failIfAsked(`hreg ${address}`);
    unit.writes.push(`${code} unit ${this.unitId} hreg ${address}=${value}`);
    if (unit.applyWrites) unit.hreg.set(address, value);
  }
}

class FakeCard {
  listener: ((args: any, state?: any) => Promise<any>) | null = null;
  private id: string;
  private triggers: string[];
  private tokens: Array<Record<string, unknown>>;

  constructor(id: string, triggers: string[], tokens: Array<Record<string, unknown>>) {
    this.id = id;
    this.triggers = triggers;
    this.tokens = tokens;
  }

  registerRunListener(listener: (args: any, state?: any) => Promise<any>) {
    this.listener = listener;
    return this;
  }

  async trigger(device: unknown, tokens?: Record<string, unknown>, state?: unknown) {
    this.triggers.push(`${this.id} ${JSON.stringify(state ?? {})}`);
    this.tokens.push({ card: this.id, ...tokens });
  }
}

class FakeLog {
  entries: Array<number | boolean> = [];
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async createEntry(value: number | boolean) {
    this.entries.push(value);
  }
}

export interface DeviceOptions {
  capabilities?: string[];
  values?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  store?: Record<string, unknown>;
  capabilityOptions?: Record<string, any>;
}

let manifest: any;

/** Homey.Device as far as the drivers use it. */
class FakeDevice {
  capabilities: string[];
  values: Record<string, unknown>;
  settings: Record<string, unknown>;
  store: Record<string, unknown>;
  capabilityOptions: Record<string, any> = {};
  listeners: Record<string, (value: any) => Promise<unknown>> = {};
  /** Capability, store and settings changes, in order. */
  events: string[] = [];
  /** Fired flow triggers, e.g. 'edastatus_mode_changed {"mode":"0"}'. */
  triggers: string[] = [];
  /** Tokens of the fired flow triggers, with the card id. */
  triggerTokens: Array<Record<string, unknown>> = [];
  flowCards = new Map<string, FakeCard>();
  logs = new Map<string, FakeLog>();
  available = true;
  warning: string | null = null;
  homey: any;
  error: (...args: unknown[]) => void;
  logLines: string[] = [];

  constructor(options: DeviceOptions = {}) {
    this.capabilities = [...(options.capabilities ?? [])];
    this.values = { ...options.values };
    this.settings = { ...options.settings };
    this.store = { ...options.store };
    this.capabilityOptions = { ...options.capabilityOptions };
    this.error = (...args) => this.events.push(`error ${args.map(String).join(' ')}`);
    const card = (id: string) => {
      if (!this.flowCards.has(id)) this.flowCards.set(id, new FakeCard(id, this.triggers, this.triggerTokens));
      return this.flowCards.get(id);
    };
    manifest ??= readJson('app.json');
    this.homey = {
      __: (key: string) => key,
      manifest,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
      clearTimeout: (timer: any) => clearTimeout(timer),
      clearInterval: (timer: any) => clearInterval(timer),
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => 'UTC' },
      flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
      insights: {
        getLog: async (id: string) => {
          const log = this.logs.get(id);
          if (!log) throw new Error('Not found');
          return log;
        },
        createLog: async (id: string) => {
          const log = new FakeLog(id);
          this.logs.set(id, log);
          return log;
        },
        deleteLog: async (log: FakeLog) => {
          this.logs.delete(log.id);
        },
      },
    };
  }

  log(...args: unknown[]) {
    this.logLines.push(args.map(String).join(' '));
  }

  getName() {
    return 'Exvent';
  }

  getData() {
    return { id: 'test' };
  }

  getAvailable() {
    return this.available;
  }

  async setWarning(message: string) {
    this.events.push(`setWarning ${message}`);
    this.warning = message;
  }

  async unsetWarning() {
    this.events.push('unsetWarning');
    this.warning = null;
  }

  getSetting(key: string) {
    return this.settings[key];
  }

  async setSettings(settings: Record<string, unknown>) {
    this.events.push(`setSettings ${JSON.stringify(settings)}`);
    Object.assign(this.settings, settings);
  }

  getStoreValue(key: string) {
    return this.store[key];
  }

  async setStoreValue(key: string, value: unknown) {
    this.events.push(`setStoreValue ${key}=${JSON.stringify(value)}`);
    this.store[key] = value;
  }

  hasCapability(id: string) {
    return this.capabilities.includes(id);
  }

  async addCapability(id: string) {
    this.events.push(`addCapability ${id}`);
    this.capabilities.push(id);
  }

  async removeCapability(id: string) {
    this.events.push(`removeCapability ${id}`);
    this.capabilities = this.capabilities.filter((capability) => capability !== id);
  }

  getCapabilityOptions(id: string) {
    return this.capabilityOptions[id] ?? {};
  }

  async setCapabilityOptions(id: string, options: any) {
    this.events.push(`setCapabilityOptions ${id} ${JSON.stringify(options)}`);
    this.capabilityOptions[id] = options;
  }

  getCapabilityValue(id: string) {
    return this.values[id] ?? null;
  }

  async setCapabilityValue(id: string, value: unknown) {
    if (!this.hasCapability(id)) throw new Error(`Invalid Capability: ${id}`);
    this.values[id] = value;
  }

  registerCapabilityListener(id: string, listener: (value: any) => Promise<unknown>) {
    this.listeners[id] = listener;
  }
}

/** Homey.Driver as far as the drivers use it. */
class FakeDriver {
  homey: any;
  devices: any[] = [];
  log() {}
  error() {}
  getDevices() {
    return this.devices;
  }
}

const fakes: Record<string, unknown> = {
  homey: { Device: FakeDevice, Driver: FakeDriver, App: class {} },
  net: { Socket: TrackedSocket },
  jsmodbus: { client: { TCP: FakeModbusClient } },
};
const loader = Module as any;
const load = loader._load;
loader._load = function fakeLoad(request: string, ...rest: unknown[]) {
  return request in fakes ? fakes[request] : load.call(this, request, ...rest);
};

const devices: any[] = [];

export type DriverName = 'eda' | 'eWind' | 'eAir';

/** A driver with its flow cards registered on the given device's Homey. */
export function createDriver(driver: DriverName, homey: any): any {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const DriverClass = require(`../drivers/${driver}/driver`);
  const instance = new DriverClass();
  instance.homey = homey;
  instance.onInit();
  return instance;
}

/**
 * A device of the driver on the unit, not yet initialised, with the
 * driver's flow cards registered. Writes go out without the one-second
 * spacing. Unless given, the device has the capabilities of a newly paired
 * device.
 */
export function createDevice(driver: DriverName, unit: FakeUnit, options: DeviceOptions = {}): any {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const DeviceClass = require(`../drivers/${driver}/device`);
  const device = new DeviceClass({
    ...options,
    capabilities: options.capabilities ?? readJson(`drivers/${driver}/driver.compose.json`).capabilities,
    settings: { ...options.settings, address: unit.address, port: 502 },
  });
  device.delay = async () => {};
  device.driver = createDriver(driver, device.homey);
  device.driver.devices.push(device);
  devices.push(device);
  return device;
}

/** Default values of a driver's settings, as a newly paired device has them. */
export function defaultSettings(driver: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const group of readJson(`drivers/${driver}/driver.compose.json`).settings) {
    for (const setting of group.children) settings[setting.id] = setting.value;
  }
  return settings;
}

/** An initialised device of the driver on a unit, with the writes, events and triggers of the start cleared. */
export async function startDevice(driver: DriverName, unit: FakeUnit, options: DeviceOptions = {}) {
  const device = createDevice(driver, unit, { ...options, settings: { ...defaultSettings(driver), ...options.settings } });
  await device.onInit();
  // eslint-disable-next-line no-use-before-define
  await settle(device);
  unit.writes.length = 0;
  device.events.length = 0;
  device.triggers.length = 0;
  device.triggerTokens.length = 0;
  return device;
}

/** Waits until the device's queued writes have all been sent. */
export async function settle(device: any) {
  for (let round = 0; round < 1000; round++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (!device.drainingWriteQueue && device.writeQueue.length === 0 && !device.pollingInProgress) return;
  }
  throw new Error('writes did not settle');
}

/** Stops the devices created so far, so no timer keeps the test process alive. */
export function cleanupDevices() {
  for (const device of devices.splice(0)) device.cleanup();
}

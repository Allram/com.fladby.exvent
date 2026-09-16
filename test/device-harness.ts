/* eslint-disable max-classes-per-file */
// Runs the real device classes without Homey or a unit: 'homey', 'net' and
// 'jsmodbus' are replaced by fakes, and a simulated unit records every write.
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

/** A unit on the network, addressed by the device's IP address setting. */
export class FakeUnit {
  hreg = new Map<number, number>();
  coils = new Map<number, boolean>();
  /** Every write, e.g. 'FC15 unit 1 coil 3=1' or 'FC6 unit 255 hreg 50=2'. */
  writes: string[] = [];
  reachable = true;
  /** When false, writes are recorded but not applied, as if still on their way. */
  applyWrites = true;
  /** When true, holding register 44 follows the stop and mode coils, as on an EDA unit. */
  deriveState = false;
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
  setKeepAlive() {
    return this;
  }

  setTimeout() {
    return this;
  }

  connect(options: { host: string }) {
    this.host = options.host;
    setImmediate(() => {
      const unit = units.get(this.host);
      if (unit && unit.reachable) this.emit('connect');
      else this.emit('error', new Error('ECONNREFUSED'));
    });
    return this;
  }

  end() {}
  destroy() {}
}

class FakeModbusClient {
  private socket: FakeSocket;
  private unitId: number;

  constructor(socket: FakeSocket, unitId: number) {
    this.socket = socket;
    this.unitId = unitId;
  }

  private get unit(): FakeUnit {
    const unit = units.get(this.socket.host);
    if (!unit || !unit.reachable) throw new Error('No response');
    return unit;
  }

  async readHoldingRegisters(start: number, length: number) {
    const buffer = Buffer.alloc(length * 2);
    for (let i = 0; i < length; i++) buffer.writeUInt16BE(this.unit.holding(start + i) & 0xffff, i * 2);
    return { response: { body: { valuesAsBuffer: buffer } } };
  }

  async readCoils(start: number, length: number) {
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

  private writeCoil(code: string, address: number, value: boolean) {
    const { unit } = this;
    unit.writes.push(`${code} unit ${this.unitId} coil ${address}=${value ? 1 : 0}`);
    if (unit.applyWrites) unit.coils.set(address, value);
  }

  private writeRegister(code: string, address: number, value: number) {
    const { unit } = this;
    unit.writes.push(`${code} unit ${this.unitId} hreg ${address}=${value}`);
    if (unit.applyWrites) unit.hreg.set(address, value);
  }
}

class FakeCard {
  listener: ((args: any, state?: any) => Promise<any>) | null = null;
  private id: string;
  private triggers: string[];

  constructor(id: string, triggers: string[]) {
    this.id = id;
    this.triggers = triggers;
  }

  registerRunListener(listener: (args: any, state?: any) => Promise<any>) {
    this.listener = listener;
    return this;
  }

  async trigger(device: unknown, tokens?: unknown, state?: unknown) {
    this.triggers.push(`${this.id} ${JSON.stringify(state ?? {})}`);
  }
}

export interface DeviceOptions {
  capabilities?: string[];
  values?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  store?: Record<string, unknown>;
}

/** Homey.Device as far as the drivers use it. */
class FakeDevice {
  capabilities: string[];
  values: Record<string, unknown>;
  settings: Record<string, unknown>;
  store: Record<string, unknown>;
  listeners: Record<string, (value: any) => Promise<unknown>> = {};
  /** Capability, store and settings changes, in order. */
  events: string[] = [];
  /** Fired flow triggers, e.g. 'edastatus_mode_changed {"mode":"0"}'. */
  triggers: string[] = [];
  cards = new Map<string, FakeCard>();
  available = true;
  homey: any;
  error: (...args: unknown[]) => void;

  constructor(options: DeviceOptions = {}) {
    this.capabilities = [...(options.capabilities ?? [])];
    this.values = { ...options.values };
    this.settings = { ...options.settings };
    this.store = { ...options.store };
    this.error = (...args) => this.events.push(`error ${args.map(String).join(' ')}`);
    const card = (id: string) => {
      if (!this.cards.has(id)) this.cards.set(id, new FakeCard(id, this.triggers));
      return this.cards.get(id);
    };
    this.homey = {
      __: (key: string) => key,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      i18n: { getLanguage: () => 'en' },
      clock: { getTimezone: () => 'UTC' },
      flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    };
  }

  log() {}
  getData() {
    return { id: 'test' };
  }

  getAvailable() {
    return this.available;
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

const fakes: Record<string, unknown> = {
  homey: { Device: FakeDevice, Driver: class {}, App: class {} },
  net: { Socket: FakeSocket },
  jsmodbus: { client: { TCP: FakeModbusClient } },
};
const loader = Module as any;
const load = loader._load;
loader._load = function fakeLoad(request: string, ...rest: unknown[]) {
  return request in fakes ? fakes[request] : load.call(this, request, ...rest);
};

const devices: any[] = [];

/**
 * A device of the driver on the unit, not yet initialised. Writes go out
 * without the one-second spacing. Unless given, the device has the
 * capabilities of a newly paired device.
 */
export function createDevice(driver: 'eda' | 'eWind' | 'eAir', unit: FakeUnit, options: DeviceOptions = {}): any {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const DeviceClass = require(`../drivers/${driver}/device`);
  const device = new DeviceClass({
    ...options,
    capabilities: options.capabilities ?? readJson(`drivers/${driver}/driver.compose.json`).capabilities,
    settings: { ...options.settings, address: unit.address, port: 502 },
  });
  device.delay = async () => {};
  devices.push(device);
  return device;
}

/** Waits until the device's queued writes have all been sent. */
export async function settle(device: any) {
  for (let round = 0; round < 1000; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!device.drainingWriteQueue && device.writeQueue.length === 0) return;
  }
  throw new Error('writes did not settle');
}

/** Stops the devices created so far, so no timer keeps the test process alive. */
export function cleanupDevices() {
  for (const device of devices.splice(0)) device.cleanup();
}

import * as net from 'net';
import * as Modbus from 'jsmodbus';
import Homey from 'homey';
import { DriverCards, registerFlowCards } from './flowCards';
import { describeError, requestFailure } from './modbus';
import { isValidHost, isValidPort } from './settings';

/** The answer to the pairing view's connection test. */
export interface PairTestResult {
  ok: boolean;
  /** Why the test failed, for the view: invalid, duplicate, refused, timeout, notExvent, platform or failed. */
  code?: string;
  /** A message for the user, in their language. */
  message?: string;
}

const PAIR_TEST_TIMEOUT_MS = 5000;

/**
 * Shared driver: registers the driver's flow cards once, before its devices
 * start, and answers the pairing view's connection test.
 */
export abstract class ExventDriver extends Homey.Driver {
  protected abstract readonly driverCards: DriverCards;
  /** The Modbus unit ID and holding register the pairing test reads. */
  protected readonly pairUnitId: number = 255;
  protected readonly pairTestRegister: number = 44;
  /** Locale key of the message for a refused connection. */
  protected readonly refusedMessage: string = 'pair.test.refused';

  async onInit() {
    registerFlowCards(this.homey, this.driverCards);
    this.registerDriverFlowCards();
  }

  /** Flow cards of this driver only. */
  protected registerDriverFlowCards() {}

  async onPair(session: any) {
    session.setHandler('test', async (data: any) => this.testConnection(data ?? {}));
  }

  /**
   * Connects to the address, reads one register and closes again. The view
   * shows the message and still lets the user add the device, since the
   * unit may just be switched off for now.
   */
  async testConnection({ address, port }: { address?: unknown; port?: unknown }): Promise<PairTestResult> {
    const host = String(address ?? '').trim();
    const portNumber = Number(port);
    if (!isValidHost(host) || !isValidPort(portNumber)) {
      return { ok: false, code: 'invalid', message: this.homey.__('pair.invalidip') };
    }
    const duplicate = this.getDevices().some((device: any) => String(device.getSetting('address') ?? '').trim() === host
      && Number(device.getSetting('port')) === portNumber);
    if (duplicate) return { ok: false, code: 'duplicate', message: this.homey.__('pair.test.duplicate') };

    const socket = new net.Socket();
    const client = new Modbus.client.TCP(socket, this.pairUnitId, PAIR_TEST_TIMEOUT_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = this.homey.setTimeout(() => socket.destroy(Object.assign(new Error('Connect timeout'), { code: 'ETIMEDOUT' })), PAIR_TEST_TIMEOUT_MS);
        socket.once('connect', () => {
          this.homey.clearTimeout(timer);
          resolve();
        });
        socket.once('error', (err: Error) => {
          this.homey.clearTimeout(timer);
          reject(err);
        });
        socket.connect({ host, port: portNumber });
      });
      const { response } = await client.readHoldingRegisters(this.pairTestRegister, 1);
      return this.checkPairReading(response.body.valuesAsArray[0]);
    } catch (err: any) {
      this.log(`Pairing test to ${host}:${portNumber} failed: ${describeError(err)}`);
      if (requestFailure(err) === 'exception') return { ok: false, code: 'notExvent', message: this.homey.__('pair.test.notExvent') };
      if (err && err.code === 'ECONNREFUSED') return { ok: false, code: 'refused', message: this.homey.__(this.refusedMessage) };
      if (requestFailure(err) === 'timeout' || (err && ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(err.code))) {
        return { ok: false, code: 'timeout', message: this.homey.__('pair.test.timeout') };
      }
      return { ok: false, code: 'failed', message: `${this.homey.__('pair.test.failed')} (${describeError(err)})` };
    } finally {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    }
  }

  /** Whether the value read looks like this driver's unit. */
  protected checkPairReading(value: number): PairTestResult {
    return { ok: true };
  }
}

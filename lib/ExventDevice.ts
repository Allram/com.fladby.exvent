import * as net from 'net';
import * as Modbus from 'jsmodbus';
import Homey from 'homey';
import { Measurement, RegisterMap, readModbus } from './modbus';

const POLL_INTERVAL = 60 * 1000;
const CONNECTION_RETRY_MIN = 5000;
const CONNECTION_RETRY_MAX = 30000;
const WAIT_FOR_CONNECT_TIMEOUT = 10000;
const SOCKET_IDLE_TIMEOUT = 0;
const WRITE_SPACING_MS = 1000;
const MODBUS_TIMEOUT = 5000;
const MODBUS_UNIT_ID = 255;
const CONFIRM_POLL_DELAY_MS = 3000;

/**
 * Every active device across both drivers, so the process shutdown handlers
 * can close all sockets — not just the last-initialized device.
 */
// eslint-disable-next-line no-use-before-define
const activeDevices = new Set<ExventModbusDevice>();
let shutdownHooked = false;

function hookShutdownHandlers() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const shutdown = () => {
    for (const device of activeDevices) {
      device.cleanup();
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export interface FlowCardIds {
    ecomode: string;
    heatingcoil: string;
    heatingcoilArg: string;
    statusMode: string;
    setTemperature: string;
    resetFilterReminder: string;
    statusModeIs: string;
    heatExchangerIs: string;
    heaterIs: string;
    statusModeChanged: string;
    heatExchangerChanged: string;
    heaterChanged: string;
    alarmBTriggered: string;
}

/**
 * Shared implementation for the eWind and eAir drivers. The subclasses only
 * provide capability names and flow card ids — the Modbus registers and all
 * connection, polling and write logic are identical for both device types.
 */
export abstract class ExventModbusDevice extends Homey.Device {
    /** e.g. 'eWindstatus' */
    protected abstract readonly statusCapability: string;
    /** e.g. 'eWindstatus_mode' */
    protected abstract readonly statusModeCapability: string;
    protected abstract readonly flowCardIds: FlowCardIds;
    /** Condition-card dropdown ids mapped to capability values ({} when they already match). */
    protected abstract readonly statusModeArgMap: Record<string, string>;
    protected abstract readonly onOffArgMap: Record<string, string>;

    registers: RegisterMap = {
      air_outside: [6, 1, 'INT16', 'Fresh air'],
      air_supply_HRC: [7, 1, 'INT16', 'Supply air after HRC'],
      air_supply: [8, 1, 'INT16', 'Supply air'],
      air_exhaust: [9, 1, 'INT16', 'Exhaust air'],
      air_extract: [10, 1, 'INT16', 'Extract air temperature'],
      air_humidity: [13, 1, 'UINT16', 'Air humidity extract'],
      air_supply_eff: [29, 1, 'UINT16', 'Heat recovery efficiency, supply air'],
      air_extract_eff: [30, 1, 'UINT16', 'Heat recovery efficiency, exhaust air'],
      temperature_setpoint: [135, 1, 'INT16', 'Temperature setpoint'],
      fan_speed_level: [50, 1, 'UINT16', 'Fan speed level'],
      status: [45, 1, 'INT16', 'status'],
      status_mode: [44, 1, 'INT16', 'statusMode'],
      service_interval_days: [538, 1, 'UINT16', 'Days until service reminder alarm'],
      days_since_service_ack: [710, 1, 'UINT16', 'Days since service reminder was acknowledged'],
    };

    coilRegisters: RegisterMap = {
      eco_mode: [40, 1, 'UINT32', 'eco Mode'],
      alarm_b_desc: [42, 1, 'UINT32', 'Alarm B description'],
      heater_status: [32, 1, 'UINT32', 'After-heater On/Off'],
      heat_exchanger_state: [30, 1, 'UINT32', 'State of Heat exchanger On/Off'],
      heating_coil: [54, 1, 'UINT32', 'State of Heater coil On/Off'],
    };

    socket: net.Socket | null = null;
    client: any = null;

    modbusOptions = {
      host: this.getSetting('address'),
      port: this.getSetting('port'),
    };

    private intervalId: NodeJS.Timeout | null = null;
    private connectionRetryId: NodeJS.Timeout | null = null;
    private flowListenersRegistered: boolean = false;
    private capabilityListenersRegistered: boolean = false;
    private pollingInProgress: boolean = false;
    private isActive: boolean = true;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;
    private connectingPromise: Promise<void> | null = null;
    private connectionRetryDelay: number = CONNECTION_RETRY_MIN;
    private writeQueue: Array<() => Promise<void>> = [];
    private drainingWriteQueue: boolean = false;
    private confirmPollTimeout: NodeJS.Timeout | null = null;

    private async markNoConnection() {
      if (!this.isActive) return;
      try {
        await this.setCapabilityValue('lastPollTime', 'No connection');
      } catch (_) {
        // ignore capability write errors when device is unavailable
      }
    }

    /**
     * Guard against acting on stale/deleted devices; Homey returns 404 when a
     * flow or capability change targets a missing device entry.
     */
    private isUsable(): boolean {
      return this.isActive && this.getAvailable();
    }

    /**
     * Writes are serialized through a FIFO queue with a pause between each
     * command, so concurrent flows/capability changes cannot cancel each
     * other's writes and the Modbus module is never flooded.
     */
    private enqueueWrite(op: () => Promise<void>) {
      this.writeQueue.push(op);
      this.drainWriteQueue().catch(this.error);
    }

    private async drainWriteQueue() {
      if (this.drainingWriteQueue) return;
      this.drainingWriteQueue = true;
      let didWrite = false;
      try {
        while (this.isActive && this.writeQueue.length > 0) {
          const op = this.writeQueue.shift()!;
          try {
            await this.ensureConnected();
            await op();
            didWrite = true;
          } catch (err) {
            await this.markNoConnection();
          }
          if (this.writeQueue.length > 0) await this.delay(WRITE_SPACING_MS);
        }
      } finally {
        this.drainingWriteQueue = false;
        if (didWrite) this.scheduleConfirmationPoll();
      }
    }

    /**
     * Re-read the device shortly after commands have been sent, so Homey
     * reflects the unit's actual state without waiting for the next
     * 60-second poll.
     */
    private scheduleConfirmationPoll() {
      if (!this.isActive) return;
      if (this.confirmPollTimeout) clearTimeout(this.confirmPollTimeout);
      this.confirmPollTimeout = setTimeout(() => {
        this.confirmPollTimeout = null;
        if (this.isActive) this.pollDevice().catch(this.error);
      }, CONFIRM_POLL_DELAY_MS);
    }

    async onInit() {
      activeDevices.add(this);
      hookShutdownHandlers();
      this.isActive = true;
      this.connectSocket();
      await this.syncCapabilities();
      this.registerFlowListeners();
      this.registerCapabilityListeners();

      await this.pollDevice();
      if (!this.getData() || !this.getData().id) return;
      this.intervalId = setInterval(async () => {
        if (!this.isActive) return;
        await this.pollDevice();
      }, POLL_INTERVAL);
    }

    attachSocketListeners(socket: net.Socket) {
      socket.setKeepAlive(true);
      socket.setTimeout(SOCKET_IDLE_TIMEOUT);
      const onGone = () => {
        if (!this.isActive) return;
        this.isConnected = false;
        this.isConnecting = false;
        this.teardownSocket();
        this.markNoConnection();
        this.retryConnection();
      };
      socket.on('end', onGone);
      socket.on('timeout', onGone);
      socket.on('error', onGone);
      socket.on('close', onGone);
      socket.on('connect', () => {
        if (!this.isActive) return;
        this.isConnected = true;
        this.isConnecting = false;
        this.connectionRetryDelay = CONNECTION_RETRY_MIN;
        this.clearRetryConnection();
      });
      // Only successful polls should update lastPollTime; raw socket data is ignored.
      socket.on('data', () => {});
    }

    connectSocket() {
      if (this.isConnecting && this.connectingPromise) return;
      this.isConnecting = true;
      this.teardownSocket();
      this.socket = new net.Socket();
      this.attachSocketListeners(this.socket);
      this.client = new Modbus.client.TCP(this.socket, MODBUS_UNIT_ID, MODBUS_TIMEOUT);

      const promise = new Promise<void>((resolve, reject) => {
        if (!this.socket) {
          reject(new Error('Socket missing'));
          return;
        }
        this.socket.once('connect', () => resolve());
        this.socket.once('error', (err: any) => reject(err));
        this.socket.connect({
          host: this.modbusOptions.host,
          port: this.modbusOptions.port,
        });
      }).finally(() => {
        this.isConnecting = false;
        this.connectingPromise = null;
      });
        // Callers awaiting via ensureConnected() see the rejection; this guard
        // only prevents an unhandled rejection when nobody is waiting.
      promise.catch(() => {});
      this.connectingPromise = promise;
    }

    retryConnection() {
      if (!this.isActive) return; // Do not retry if device has been deleted
      if (this.connectionRetryId || this.isConnecting) return;
      this.connectionRetryId = setTimeout(() => {
        if (!this.isActive) return;
        this.connectionRetryId = null;
        this.connectSocket();
        this.connectionRetryDelay = Math.min(CONNECTION_RETRY_MAX, this.connectionRetryDelay * 2 || CONNECTION_RETRY_MIN);
      }, this.connectionRetryDelay);
    }

    clearRetryConnection() {
      if (this.connectionRetryId) {
        clearTimeout(this.connectionRetryId);
        this.connectionRetryId = null;
      }
    }

    teardownSocket() {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.end();
        this.socket.destroy();
      }
      this.socket = null;
      this.client = null;
      this.isConnected = false;
    }

    ensureConnected(): Promise<void> {
      if (this.isConnected) return Promise.resolve();
      if (!this.isConnecting) {
        this.connectSocket();
      }

      if (this.connectingPromise) {
        return this.connectingPromise;
      }

      return new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const checkInterval = setInterval(() => {
          if (this.isConnected) {
            clearInterval(checkInterval);
            resolve();
          } else if (!this.isActive || Date.now() - start > WAIT_FOR_CONNECT_TIMEOUT) {
            clearInterval(checkInterval);
            reject(new Error('Connection timeout'));
          }
        }, 500);
      });
    }

    async pollDevice() {
      if (!this.isActive) return;
      if (this.pollingInProgress) return;
      this.pollingInProgress = true;

      if (!this.isConnected) {
        try {
          await this.ensureConnected();
        } catch (err) {
          await this.markNoConnection();
          this.pollingInProgress = false;
          return;
        }
      }

      try {
        const registerResult = await readModbus(this.client, this.registers, 'holding');
        await this.processResult({ ...registerResult });
        const coilResult = await readModbus(this.client, this.coilRegisters, 'coil');
        await this.processResult({ ...coilResult });
        if (this.isActive) {
          try {
            await this.setCapabilityValue(
              'lastPollTime',
              new Date().toLocaleString(this.homey.i18n.getLanguage(), { timeZone: this.homey.clock.getTimezone(), hour12: false }),
            );
          } catch (err) {
            // Ignore errors if device is deleted
          }
        }
      } catch (error) {
        this.isConnected = false;
        this.isConnecting = false;
        this.teardownSocket();
        await this.markNoConnection();
        this.retryConnection();
      } finally {
        this.pollingInProgress = false;
      }
    }

    /**
     * Applies a status mode by writing the corresponding coil sequence.
     * The capability update is queued last, after all writes have been sent.
     */
    async setStatusModeValue(value: string) {
      switch (value) {
        case '0':
          await this.sendCoilRequest(0, false);
          await this.sendCoilRequest(1, false);
          await this.sendCoilRequest(3, false);
          await this.sendCoilRequest(10, false);
          break;
        case '1':
          await this.sendCoilRequest(0, false);
          await this.sendCoilRequest(10, false);
          await this.sendCoilRequest(1, true);
          break;
        case '2':
          await this.sendCoilRequest(0, false);
          await this.sendCoilRequest(10, false);
          await this.sendCoilRequest(3, true);
          break;
        case '3':
          await this.sendCoilRequest(0, false);
          await this.sendCoilRequest(10, true);
          break;
        case '4':
          await this.sendCoilRequest(0, true);
          break;
        default:
          break;
      }
      this.enqueueWrite(async () => {
        if (this.isActive) {
          await this.setCapabilityValue(this.statusModeCapability, value);
        }
      });
    }

    async sendHoldingRequest(register: number, value: number) {
      this.enqueueWrite(async () => {
        await this.client.writeSingleRegister(register, value);
      });
    }

    async sendCoilRequest(register: number, value: boolean) {
      this.enqueueWrite(async () => {
        await this.client.writeSingleCoil(register, value);
      });
    }

    private async syncCapabilities() {
      const toAdd = [
        'efficiency.supplyEff',
        'efficiency.extractEff',
        'measure_temperature.step',
        'measure_temperature.exhaustAir',
        'measure_temperature.extractAir',
        'measure_temperature.supplyAirHRC',
        'ecomode_mode',
        'heater_mode',
        'heating_coil_state',
        'heat_exchanger_mode',
        'target_temperature.step',
        'alarm_b.desc',
        'filter_days_remaining',
        'measure_humidity.extractAir',
        'fanspeed_level',
        this.statusCapability,
        this.statusModeCapability,
        'lastPollTime',
      ];
      for (const capability of toAdd) {
        if (!this.hasCapability(capability)) {
          await this.addCapability(capability);
        }
      }
    }

    registerFlowListeners() {
      if (this.flowListenersRegistered) return;
      const cards = this.flowCardIds;

      this.homey.flow.getActionCard(cards.ecomode)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          if (!device.isUsable()) return false;
          await device.setMode('ecomode_mode', args.ecomode);
          await device.sendCoilRequest(40, args.ecomode === '1');
          return true;
        });

      this.homey.flow.getActionCard(cards.heatingcoil)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          if (!device.isUsable()) return false;
          await device.setMode('heating_coil_state', args[cards.heatingcoilArg]);
          await device.sendCoilRequest(54, args[cards.heatingcoilArg] === '1');
          return true;
        });

      this.homey.flow.getActionCard(cards.statusMode)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          if (!device.isUsable()) return false;
          await device.setMode(device.statusModeCapability, args.mode);
          await device.setStatusModeValue(args.mode);
          return true;
        });

      this.homey.flow.getActionCard(cards.setTemperature)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          if (!device.isUsable()) return false;
          await device.setCapabilityValue('target_temperature.step', args.temperature);
          await device.sendHoldingRequest(135, args.temperature * 10);
          return true;
        });

      // HREG 710 (HREG_DAYS_RUNNING) counts days since the service reminder
      // was acknowledged; writing 0 restarts the filter change countdown.
      this.homey.flow.getActionCard(cards.resetFilterReminder)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          if (!device.isUsable()) return false;
          await device.sendHoldingRequest(710, 0);
          return true;
        });

      this.flowListenersRegistered = true;
    }

    registerCapabilityListeners() {
      if (this.capabilityListenersRegistered) return;
      const cards = this.flowCardIds;

      this.homey.flow.getConditionCard(cards.statusModeIs)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          const expected = device.statusModeArgMap[args.mode] ?? args.mode;
          return device.getCapabilityValue(device.statusModeCapability) === expected;
        });

      this.homey.flow.getConditionCard(cards.heatExchangerIs)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          const expected = device.onOffArgMap[args.mode] ?? args.mode;
          return device.getCapabilityValue('heat_exchanger_mode') === expected;
        });

      this.homey.flow.getConditionCard(cards.heaterIs)
        .registerRunListener(async (args: any) => {
          const device = args.device as ExventModbusDevice;
          const expected = device.onOffArgMap[args.mode] ?? args.mode;
          return device.getCapabilityValue('heater_mode') === expected;
        });

      this.registerCapabilityListener(this.statusModeCapability, async (value) => {
        if (!this.isUsable()) return;
        await this.setStatusModeValue(value);
        await this.homey.flow.getDeviceTriggerCard(cards.statusModeChanged)
          .trigger(this)
          .catch(this.error);
      });

      this.registerCapabilityListener('target_temperature.step', async (value) => {
        if (!this.isUsable()) return;
        await this.sendHoldingRequest(135, value * 10);
      });

      this.registerCapabilityListener('ecomode_mode', async (value) => {
        if (!this.isUsable()) return;
        await this.sendCoilRequest(40, value === '1');
      });

      this.registerCapabilityListener('heat_exchanger_mode', async () => {
        if (!this.isUsable()) return;
        await this.homey.flow.getDeviceTriggerCard(cards.heatExchangerChanged)
          .trigger(this)
          .catch(this.error);
      });

      this.registerCapabilityListener('heater_mode', async () => {
        if (!this.isUsable()) return;
        await this.homey.flow.getDeviceTriggerCard(cards.heaterChanged)
          .trigger(this)
          .catch(this.error);
      });

      this.registerCapabilityListener('heating_coil_state', async (value) => {
        if (!this.isUsable()) return;
        let coilValue: boolean | null = null;
        if (value === true || value === '1' || value === 'true') {
          coilValue = true;
        } else if (value === false || value === '0' || value === 'false') {
          coilValue = false;
        }
        if (coilValue !== null) {
          await this.sendCoilRequest(54, coilValue);
        }
      });

      this.capabilityListenersRegistered = true;
    }

    cleanup() {
      this.isActive = false;
      activeDevices.delete(this);
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      this.writeQueue = [];
      if (this.confirmPollTimeout) {
        clearTimeout(this.confirmPollTimeout);
        this.confirmPollTimeout = null;
      }
      if (this.connectionRetryId) {
        clearTimeout(this.connectionRetryId);
        this.connectionRetryId = null;
      }
      this.connectingPromise = null;
      this.flowListenersRegistered = false;
      this.capabilityListenersRegistered = false;
      this.teardownSocket();
    }

    async setMode(mode: string, value: string): Promise<void> {
      if (!this.getAvailable()) return;
      await this.setCapabilityValue(mode, value);
    }

    async onAdded() {
      setTimeout(async () => {
        if (this.isActive) await this.pollDevice();
      }, 10000);
    }

    async onSettings({ newSettings }: { newSettings: Record<string, any>; changedKeys: string[] }) {
      if (newSettings && (newSettings.address || newSettings.port)) {
        try {
          this.modbusOptions.host = newSettings.address;
          this.modbusOptions.port = newSettings.port;
          this.teardownSocket();
          this.connectionRetryDelay = CONNECTION_RETRY_MIN;
          await this.delay(1000);
          this.connectSocket();
          await this.ensureConnected();
          await this.pollDevice();
        } catch (error: any) {
          await this.markNoConnection();
        }
      }
    }

    async onDeleted() {
      this.cleanup();
    }

    delay(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async setIfChanged(capabilityId: string, value: any) {
      try {
        const current = this.getCapabilityValue(capabilityId);
        if (current === value) return;
        await this.setCapabilityValue(capabilityId, value);
      } catch (_) {
        // Ignore capability errors (e.g., device deleted)
      }
    }

    async processResult(result: Record<string, Measurement>) {
      if (!result) {
        return;
      }

      if (result['air_outside'] && result['air_outside'].value !== 'xxx') {
        await this.setIfChanged('measure_temperature.outsideAir', Number(result['air_outside'].value) / 10);
      }

      if (result['air_extract'] && result['air_extract'].value !== 'xxx') {
        await this.setIfChanged('measure_temperature.extractAir', Number(result['air_extract'].value) / 10);
      }

      if (result['air_supply'] && result['air_supply'].value !== 'xxx') {
        await this.setIfChanged('measure_temperature.step', Number(result['air_supply'].value) / 10);
      }

      if (result['air_supply_HRC'] && result['air_supply_HRC'].value !== 'xxx') {
        await this.setIfChanged('measure_temperature.supplyAirHRC', Number(result['air_supply_HRC'].value) / 10);
      }

      if (result['air_exhaust'] && result['air_exhaust'].value !== 'xxx') {
        await this.setIfChanged('measure_temperature.exhaustAir', Number(result['air_exhaust'].value) / 10);
      }

      if (result['temperature_setpoint'] && result['temperature_setpoint'].value !== 'xxx') {
        const temperature = Number(result['temperature_setpoint'].value) / 10;
        if (temperature >= 15 && temperature <= 22) {
          await this.setIfChanged('target_temperature.step', temperature);
        }
      }

      if (result['air_humidity'] && result['air_humidity'].value !== 'xxx') {
        await this.setIfChanged('measure_humidity.extractAir', Number(result['air_humidity'].value));
      }

      if (result['air_supply_eff'] && result['air_supply_eff'].value !== 'xxx') {
        await this.setIfChanged('efficiency.supplyEff', Number(result['air_supply_eff'].value));
      }

      if (result['air_extract_eff'] && result['air_extract_eff'].value !== 'xxx') {
        await this.setIfChanged('efficiency.extractEff', Number(result['air_extract_eff'].value));
      }

      if (result['fan_speed_level'] && result['fan_speed_level'].value !== 'xxx') {
        await this.setIfChanged('fanspeed_level', Number(result['fan_speed_level'].value));
      }

      if (result['status'] && result['status'].value !== 'xxx') {
        const statusMap: Record<string, string> = {
          0: '0', 1: '1', 2: '2', 4: '3', 7: '4', 8: '5',
        };
        const mapped = statusMap[result['status'].value];
        if (mapped !== undefined) {
          await this.setIfChanged(this.statusCapability, mapped);
        }
      }

      if (result['status_mode'] && result['status_mode'].value !== 'xxx') {
        const statusModeMap: Record<string, string> = {
          0: '0', 16: '1', 1024: '2', 512: '3',
        };
        const mapped = statusModeMap[result['status_mode'].value];
        if (mapped !== undefined) {
          await this.setIfChanged(this.statusModeCapability, mapped);
        }
      }

      if (result['eco_mode'] && result['eco_mode'].value !== 'xxx') {
        const { value } = result['eco_mode'];
        if (value === '0' || value === '1') {
          await this.setIfChanged('ecomode_mode', value);
        }
      }

      if (result['heater_status'] && result['heater_status'].value !== 'xxx') {
        const { value } = result['heater_status'];
        if (value === '0' || value === '1') {
          await this.setIfChanged('heater_mode', value);
        }
      }

      if (result['heat_exchanger_state'] && result['heat_exchanger_state'].value !== 'xxx') {
        const { value } = result['heat_exchanger_state'];
        if (value === '0' || value === '1') {
          await this.setIfChanged('heat_exchanger_mode', value);
        }
      }

      if (result['heating_coil'] && result['heating_coil'].value !== 'xxx') {
        const { value } = result['heating_coil'];
        if (value === '0' || value === '1') {
          await this.setIfChanged('heating_coil_state', value);
        }
      }

      if (result['alarm_b_desc'] && result['alarm_b_desc'].value !== 'xxx') {
        const { value } = result['alarm_b_desc'];
        if (value === '0' || value === '1') {
          const alarmActive = value === '1';
          // Capability listeners only fire on user-initiated changes, so the
          // filter alarm trigger must be fired here on the poll transition.
          const wasActive = this.getCapabilityValue('alarm_b.desc') === true;
          await this.setIfChanged('alarm_b.desc', alarmActive);
          if (alarmActive && !wasActive) {
            await this.homey.flow.getDeviceTriggerCard(this.flowCardIds.alarmBTriggered)
              .trigger(this)
              .catch(this.error);
          }
        }
      }

      // Days until the filter change reminder: configured interval (HREG 538)
      // minus days elapsed since last acknowledgement (HREG 710).
      if (result['service_interval_days'] && result['service_interval_days'].value !== 'xxx'
        && result['days_since_service_ack'] && result['days_since_service_ack'].value !== 'xxx') {
        const interval = Number(result['service_interval_days'].value);
        const elapsed = Number(result['days_since_service_ack'].value);
        await this.setIfChanged('filter_days_remaining', Math.max(0, interval - elapsed));
      }
    }
}

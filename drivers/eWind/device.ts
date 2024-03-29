import net from 'net';
import * as Modbus from 'jsmodbus';	
import {eWind} from '../eWind';
import {checkRegister} from '../response';
import {checkCoils} from '../response_coil';

	
const socket = new net.Socket();
const client = new Modbus.client.TCP(socket, 255);
const RETRY_INTERVAL = 60 * 1000; 
//let timer:NodeJS.Timer;

const shutdown = () => {
	socket.end();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

class MyeWindDevice extends eWind {
	modbusOptions = {
    host: this.getSetting('address'),
    port: this.getSetting('port'),
    unitId: this.getSetting('id'),
    timeout: 5,
    autoReconnect: true,
    logLabel: 'eWind',
    logLevel: 'error',
    logEnabled: true,
    };
    

async onInit() {
    this.log('MyeWindDevice has been initialized');
    socket.setKeepAlive(true);
    //socket.setTimeout(15000);
    socket.connect(this.modbusOptions);
    this.setCapabilities();
    this.flowActionCards();
    this.registerCapabilityListeners();
    socket.on('end', () => {});
    socket.on('timeout', () => {
      socket.end();
      socket.connect(this.modbusOptions);
    });
    socket.on('error', (err: any) => {});
    socket.on('close', (err: any) => {
      socket.end();
      socket.connect(this.modbusOptions);
    });
    socket.on('data', () => {
      this.setCapabilityValue('lastPollTime', new Date().toLocaleString('no-nb', {timeZone: 'CET', hour12: false}));
    });
    await this.poll_eWind();
    setInterval(async () => {
      await this.poll_eWind();
    }, RETRY_INTERVAL);
  } catch (error: Error) {
    console.log(error);
  }

  async poll_eWind() {
    console.log('Polling eWind...');
    try {
      const checkRegisterRes = await checkRegister(this.registers, client);
      this.processResult({ ...checkRegisterRes });
      const checkCoilsRes = await checkCoils(this.coilRegisters, client);
      this.processResult({ ...checkCoilsRes });
    } catch (error) {
      console.error(error);
    }
  }

  async setEWindValue(value: string) {
    await this.poll_eWind(); // Wait for polling to finish
    switch (value) {
      case "0":
        this.sendCoilRequest(0, false);
        this.sendCoilRequest(1, false);
        this.sendCoilRequest(3, false);
        this.sendCoilRequest(10, false);
        break;
      case "1":
        this.sendCoilRequest(0, false);
        this.sendCoilRequest(10, false);
        this.sendCoilRequest(1, true);
        break;
      case "2":
        this.sendCoilRequest(0, false);
        this.sendCoilRequest(10, false);
        this.sendCoilRequest(3, true);
        break;
      case "3":
        this.sendCoilRequest(0, false);
        this.sendCoilRequest(10, true);
        break;
      case "4":
        this.sendCoilRequest(0, true);
        break;
      default:
        break;
    }
  }

  async sendHoldingRequest(register: number, value: number) {
    await this.poll_eWind(); // Wait for polling to finish
    client.writeSingleRegister(register, value)
      .catch((error) => {
        console.error(error);
      });   
  } 
  
  async sendCoilRequest(register: number, value: boolean) {
    await this.poll_eWind(); // Wait for polling to finish
    client.writeSingleCoil(register, value)
      .catch((error) => {
        console.error(error);
      });   
  }
  async setCapabilities() {
    if (this.hasCapability('efficiency.supplyEff') === false) {
      await this.addCapability('efficiency.supplyEff');
    }
    if (this.hasCapability('efficiency.extractEff') === false) {
      await this.addCapability('efficiency.extractEff');
    }
    if (this.hasCapability('measure_temperature.step') === false) {
      await this.addCapability('measure_temperature.step');
    }
    if (this.hasCapability('measure_temperature.exhaustAir') === false) {
      await this.addCapability('measure_temperature.exhaustAir');
    }
    if (this.hasCapability('measure_temperature.supplyAir') === true) {
      await this.removeCapability('measure_temperature.supplyAir');
    }
    if (this.hasCapability('target_temperature') === true) {
      await this.removeCapability('target_temperature');
    }
    if (this.hasCapability('measure_temperature') === true) {
      await this.removeCapability('measure_temperature');
    }
    if (this.hasCapability('measure_temperature.extractAir') === false) {
      await this.addCapability('measure_temperature.extractAir');
    }
    if (this.hasCapability('measure_temperature.supplyAirHRC') === false) {
      await this.addCapability('measure_temperature.supplyAirHRC');
    }
    if (this.hasCapability('ecomode_mode') === false) {
      await this.addCapability('ecomode_mode');
    }
    if (this.hasCapability('heater_mode') === false) {
      await this.addCapability('heater_mode');
    }
    if (this.hasCapability('heat_exchanger_mode') === false) {
      await this.addCapability('heat_exchanger_mode');
    }
    if (this.hasCapability('target_temperature.step') === false) {
      await this.addCapability('target_temperature.step');
    }
    if (this.hasCapability('alarm_b.desc') === false) {
      await this.addCapability('alarm_b.desc');
    }
    if (this.hasCapability('measure_humidity.extractAir') === false) {
      await this.addCapability('measure_humidity.extractAir');
    }
    if (this.hasCapability('fanspeed_level') === false) {
      await this.addCapability('fanspeed_level');
    }
    if (this.hasCapability('eWindstatus') === false) {
      await this.addCapability('eWindstatus');
    }
    if (this.hasCapability('eWindstatus_mode') === false) {
      await this.addCapability('eWindstatus_mode');
    }
    if (this.hasCapability('lastPollTime') === false) {
      await this.addCapability('lastPollTime');
    }
    if (this.hasCapability('remaining.filter_days') === true) {
      await this.removeCapability('remaining.filter_days');
    }
  }

  flowActionCards() {
    //Action cards
    const ecomodeCard = this.homey.flow.getActionCard('ecomode');
    ecomodeCard.registerRunListener(async (args) => {
      args.device.setMode('ecomode_mode', args.ecomode);
      this.sendCoilRequest(40, args.ecomode === '1');
    });
    
    const eWindStatusCard = this.homey.flow.getActionCard('status-mode');
    eWindStatusCard.registerRunListener(async (args) => {
      args.device.setMode('eWindstatus_mode', args.mode);
      this.setEWindValue(args.mode);
    });

    const SetTemperatureCard = this.homey.flow.getActionCard('set-temperature');
    SetTemperatureCard.registerRunListener(async (args) => {
      this.setCapabilityValue('target_temperature.step', args.temperature);
      this.sendHoldingRequest(135, args.temperature*10);
    });
  }

  registerCapabilityListeners() {
    this.registerCapabilityListener('eWindstatus_mode', async (value) => {
      await this.poll_eWind(); // Wait for polling to finish
      this.log('Changes to :', value);
      this.setEWindValue(value);
    });
    this.registerCapabilityListener('target_temperature.step', async (value) => {
      await this.poll_eWind(); // Wait for polling to finish
      this.log('Changes to :', value);
      this.sendHoldingRequest(135, value*10);
    });
    this.registerCapabilityListener('ecomode_mode', async (value) => {
      await this.poll_eWind(); // Wait for polling to finish
      this.log('Changes to :', value);
      this.sendCoilRequest(40, value === '1');
    });
  }

  async setMode(mode: string, value: string): Promise<void> {
    if (!this.getAvailable()) {
      return;
    }
    this.setCapabilityValue(mode, value);
  } 

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyeWindDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ newSettings }: { newSettings: Record<string, any>; changedKeys: string[] }) {
    if (newSettings && (newSettings.address || newSettings.port)) {
        try {
            this.log('IP address or port changed. Reconnecting...');
            this.modbusOptions.host = newSettings.address;
            this.modbusOptions.port = newSettings.port;
            socket.end();
            await this.delay(1000); // Add a delay to ensure the socket is closed before reconnecting
            socket.connect(this.modbusOptions);
            // Additional logic if needed after reconnecting
            this.log('Reconnected successfully.');
        } catch (error: any) {
            // Explicitly type error as an Error
            this.error('Error reconnecting:', (error as Error).message);
        }
    }
}

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyeWindDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyeWindDevice has been deleted');
    //this.homey.clearInterval(timer);
  }

  delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
module.exports = MyeWindDevice;
import * as Modbus from 'jsmodbus';
import net from 'net';
import {eWind}     from '../eWind';
import {checkRegister} from '../response';
import {checkCoils} from '../response_coil';

const RETRY_INTERVAL = 18 * 1000; 
let timer:NodeJS.Timer;

class MyeWindDevice extends eWind {
  static socket: net.Socket = new net.Socket();
   modbusOptions = {
    'host': this.getSetting('address'),
    'port': this.getSetting('port'),
    'unitId': this.getSetting('id'),
    'timeout': 15,
    'autoReconnect': false,
    'logLabel' : 'eWind',
    'logLevel': 'error',
    'logEnabled': true
  }

  setSocketAttributes() {
    MyeWindDevice.socket.setKeepAlive(true, 10000);
    MyeWindDevice.socket.setTimeout(10000);
  }

  connectSocket() {
    MyeWindDevice.socket.connect(this.modbusOptions);
  }

  async onInit() {
    this.log('MyeWindDevice has been initialized');
    this.setSocketAttributes();
    this.connectSocket();
    this.setCapabilities();
    this.flowActionCards();
    this.registerCapabilityListeners();
    this.poll_eWind();
    timer = this.homey.setInterval(() => {
      this.poll_eWind();
    }, RETRY_INTERVAL);
  }
  
  async poll_eWind() {
    console.log('Polling eWind...');
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(MyeWindDevice.socket, unitID);
    MyeWindDevice.socket.on('connect', async () => {
      console.log('Connected...');
      const checkRegisterRes = await checkRegister(this.registers, client);
      this.processResult({...checkRegisterRes});
      const checkCoilsRes = await checkCoils(this.coilRegisters, client); 
      this.processResult({...checkCoilsRes});
      this.setCapabilityValue('lastPollTime', new Date().toLocaleString('no-nb', {timeZone: 'CET', hour12: false}));
    });    
    MyeWindDevice.socket.on('close', () => {
      console.log('Client closed');
      this.connectSocket();
      this.poll_eWind();
    });  
    MyeWindDevice.socket.on('timeout', () => {
      console.log('Socket timed out!');
      this.connectSocket();
      this.poll_eWind();
    });
    MyeWindDevice.socket.on('error', (err) => {
      console.log('Socket error: ', err);
    });
  }

  setEWindValue(value: string) {
    switch (value) {
      case "0":
        this.sendCoilRequest(1, false);
        this.sendCoilRequest(3, false);
        this.sendCoilRequest(10, false);
        break;
      case "1":
        this.sendCoilRequest(10, false);
        this.sendCoilRequest(1, true);
        break;
      case "2":
        this.sendCoilRequest(10, false);
        this.sendCoilRequest(3, true);
        break;
      case "3":
        this.sendCoilRequest(10, true);
        break;
      default:
        break;
    }
  }

  sendHoldingRequest(register: number, value: number) {
    const socket = MyeWindDevice.socket;
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.on('connect', async () => {
      client.writeSingleRegister(register, value)
    });    
    socket.on('timeout', () => {
      console.log('Socket timed out!');
      this.connectSocket();
      this.poll_eWind();
    });
    socket.on('error', (err) => {
      console.log('Socket error: ', err);
    });
  }
  
  sendCoilRequest(register: number, value: boolean) {
    const socket = MyeWindDevice.socket;
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.on('connect', async () => {
      client.writeSingleCoil(register, value)
    });
    socket.on('timeout', () => {
      console.log('Socket timed out!');
      this.connectSocket();
      this.poll_eWind();
    });
    socket.on('error', (err) => {
      console.log('Socket error: ', err);
    });
  }

  async setCapabilities() {
    if (this.hasCapability('efficiency.supplyEff') === false) {
      await this.addCapability('efficiency.supplyEff');
    }
    if (this.hasCapability('efficiency.extractEff') === false) {
      await this.addCapability('efficiency.extractEff');
    }
    if (this.hasCapability('measure_temperature.outsideAir') === false) {
      await this.addCapability('measure_temperature.outsideAir');
    }
    if (this.hasCapability('measure_temperature.exhaustAir') === false) {
      await this.addCapability('measure_temperature.exhaustAir');
    }
    if (this.hasCapability('measure_temperature.supplyAir') === false) {
      await this.addCapability('measure_temperature.supplyAir');
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
    if (this.hasCapability('measure_temperature') === false) {
      await this.addCapability('measure_temperature');
    }
    if (this.hasCapability('heater_mode') === false) {
      await this.addCapability('heater_mode');
    }
    if (this.hasCapability('heat_exchanger_mode') === false) {
      await this.addCapability('heat_exchanger_mode');
    }
    if (this.hasCapability('target_temperature') === false) {
      await this.addCapability('target_temperature');
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
      //await this.delay(1000); // Add 1 second delay to avoid socket hangup
      this.sendCoilRequest(40, args.ecomode === '1');
    });
    
    const eWindStatusCard = this.homey.flow.getActionCard('status-mode');
    eWindStatusCard.registerRunListener(async (args) => {
      args.device.setMode('eWindstatus_mode', args.mode);
      //await this.delay(1000); // Add 1 second delay to avoid socket hangup
      this.setEWindValue(args.mode);
    });
  }

  registerCapabilityListeners() {
    this.registerCapabilityListener('eWindstatus_mode', async (value) => {
      this.log('Changes to :', value);
      this.setEWindValue(value);
    });
    this.registerCapabilityListener('target_temperature', async (value) => {
      this.log('Changes to :', value);
      this.sendHoldingRequest(135, value*10);
    });
    this.registerCapabilityListener('ecomode_mode', async (value) => {
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
  async onSettings({ oldSettings: {}, newSettings: {}, changedKeys: {} }): Promise<string|void> {
    this.log('MyeWindDevice settings where changed');
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
    this.homey.clearInterval(timer);
  }

  delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
module.exports = MyeWindDevice;
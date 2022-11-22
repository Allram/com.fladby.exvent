import * as Modbus from 'jsmodbus';
import net from 'net';
import {eWind}     from '../eWind';
import {checkRegister} from '../response';
import {checkCoils} from '../response_coil';

const RETRY_INTERVAL = 18 * 1000; 
let timer:NodeJS.Timer;

class MyeWindDevice extends eWind {
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyeWindDevice has been initialized');


    let name = this.getData().id;
    this.log("device name id " + name );
    this.log("device name " + this.getName());

    this.poll_eWind();

    timer = this.homey.setInterval(() => {
      // poll device state from eWind
      this.poll_eWind();
    }, RETRY_INTERVAL);

    this.registerCapabilityListener('eWindstatus_mode', async (value) => {
      this.log('Changes to :', value);
      switch (value) {
        case "0":
          this.sendCoilRequest(1, false);
          this.sendCoilRequest(3, false);
          this.sendCoilRequest(10, false);
          break;
        case "1":
          this.sendCoilRequest(1, true);
          break;
        case "2":
          this.sendCoilRequest(3, true);
          break;
        case "3":
          this.sendCoilRequest(10, true);
          break;
        default:
          break;
      }
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

  async poll_eWind() {
    this.log("poll_eWind");
    this.log(this.getSetting('address'));
    let socket = new net.Socket();
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.setKeepAlive(false);
    socket.connect(this.modbusOptions);
    socket.on('connect', async () => {
      console.log('Connected ...');
      console.log(this.modbusOptions);
      const checkRegisterRes = await checkRegister(this.registers, client);
      this.processResult({...checkRegisterRes});
      const checkCoilsRes = await checkCoils(this.coilRegisters, client); 
      this.processResult({...checkCoilsRes});
      client.socket.end();
      socket.end();
      console.log('disconnect');
    });    
    socket.on('close', () => {
      console.log('Client closed');
    });  
    socket.on('timeout', () => {
      console.log('socket timed out!');
      socket.end();
    });
    socket.on('error', (err) => {
      console.log(err);
      socket.end();
    })
  }

  sendHoldingRequest(register: number, value: number) {
    let socket = new net.Socket();
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.setKeepAlive(false);
    socket.connect(this.modbusOptions);
    socket.on('connect', async () => {
      client.writeSingleRegister(register, value).then(({ metrics, response }) => {
        //console.log('Metrics: ' + JSON.stringify(metrics));
        //console.log('Response: ' + JSON.stringify(response));
      }).then(() => {
        client.socket.end();
        socket.end();
      });
    });    
    socket.on('timeout', () => {
      socket.end();
    });
    socket.on('error', (err) => {
      console.log(err);
      socket.end();
    })
  }
  
  sendCoilRequest(register: number, value: boolean) {
    let socket = new net.Socket();
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.setKeepAlive(false);
    socket.connect(this.modbusOptions);
    socket.on('connect', async () => {
      client.writeSingleCoil(register, value).then(({ metrics, response }) => {
        //console.log('Metrics: ' + JSON.stringify(metrics));
        //console.log('Response: ' + JSON.stringify(response));
      }).then(() => {
        client.socket.end();
        socket.end();
      });
    });    
    socket.on('timeout', () => {
      socket.end();
    });
    socket.on('error', (err) => {
      console.log(err);
      socket.end();
    })
  }
}
module.exports = MyeWindDevice;
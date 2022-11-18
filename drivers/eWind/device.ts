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

    this.registerCapabilityListener('eWindstatus_mode', async (value, opts) => {
      this.log('Changes to :', value);
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      this.log('Changes to :', value);
    });

    this.registerCapabilityListener('ecomode_mode', async (value) => {
      this.log('Changes to :', value);
    });

    this.registerCapabilityListener('alarm_b.desc', async (value) => {
      this.log('Changes to :', value);
    });


    // flow condition 
    let eWindstatusMode = this.homey.flow.getConditionCard("eWind_mode_condition");
    eWindstatusMode.registerRunListener(async (args, state) => {
        let result = (await this.getCapabilityValue('eWindstatus_mode') >= args.mode);
        return Promise.resolve(result);
    })  

    let ecoMode = this.homey.flow.getConditionCard("Ecomode_mode_condition");
    ecoMode.registerRunListener(async (args, state) => {
        let result = (await this.getCapabilityValue('ecomode_mode') >= args.mode);
        return Promise.resolve(result);
    }) 



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
  
  async poll_eWind() {
    this.log("poll_eWind");
    this.log(this.getSetting('address'));

    let modbusOptions = {
      'host': this.getSetting('address'),
      'port': this.getSetting('port'),
      'unitId': this.getSetting('id'),
      'timeout': 15,
      'autoReconnect': false,
      'logLabel' : 'eWind',
      'logLevel': 'error',
      'logEnabled': true
    }    
    

    let socket = new net.Socket();
    var unitID = this.getSetting('id');
    let client = new Modbus.client.TCP(socket, unitID);
    socket.setKeepAlive(false);
    socket.connect(modbusOptions);

    socket.on('connect', async () => {
      console.log('Connected ...');
      console.log(modbusOptions);

      const checkRegisterRes = await checkRegister(this.registers, client);
      const finalRes = {...checkRegisterRes}
      this.processResult(finalRes)
      const checkCoilsRes = await checkCoils(this.Coilregisters, client);
      client.socket.end();
      socket.end();
      const finalRes2 = {...checkCoilsRes}
      this.processResult(finalRes2)
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
}

module.exports = MyeWindDevice;

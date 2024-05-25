import net from 'net';
import * as Modbus from 'jsmodbus';    
import { eWind } from '../eWind';
import { checkRegister } from '../response';
import { checkCoils } from '../response_coil';

const socket = new net.Socket();
const client = new Modbus.client.TCP(socket, 255);
const RETRY_INTERVAL = 60 * 1000; 

const shutdown = () => {
    if (currentDevice) {
        currentDevice.cleanup();
    }
    socket.end();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let currentDevice: MyeWindDevice | null = null;

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

    private intervalId: NodeJS.Timeout | null = null; // To store the interval ID
    private flowListenersRegistered: boolean = false;
    private capabilityListenersRegistered: boolean = false;
    private pollingInProgress: boolean = false; // Flag to prevent overlapping polls
    private isActive: boolean = true; // Flag to check if the device is active
    private skipNextIntervalPoll: boolean = false; // Flag to skip the next interval poll

    async onInit() {
        this.log('MyeWindDevice has been initialized');
        currentDevice = this;
        this.isActive = true;
        socket.setKeepAlive(true);
        socket.connect(this.modbusOptions);
        this.setCapabilities();
        this.registerFlowListeners();
        this.registerCapabilityListeners();
        socket.on('end', () => {});
        socket.on('timeout', () => {
            socket.end();
            socket.connect(this.modbusOptions);
        });
        socket.on('error', (err: any) => {
            this.log('Socket error:', err);
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', 'No connection');
            }
        });
        socket.on('close', (err: any) => {
            socket.end();
            socket.connect(this.modbusOptions);
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', 'No connection');
            }
        });
        socket.on('data', () => {
            if (this.isActive) {
                try {
                    this.setCapabilityValue('lastPollTime', new Date().toLocaleString('no-nb', { timeZone: 'CET', hour12: false }));
                } catch (error) {
                    this.log('Error setting capability value:', error);
                    this.setCapabilityValue('lastPollTime', 'No connection');
                }
            }
        });
        await this.poll_eWind();
        this.intervalId = setInterval(async () => {
            if (this.skipNextIntervalPoll) {
                this.skipNextIntervalPoll = false; // Reset the flag
                return; // Skip this poll
            }
            await this.poll_eWind();
        }, RETRY_INTERVAL);
    }

    async onUninit() {
        this.log('MyeWindDevice is being uninitialized');
        this.cleanup();  // Clean up when the device is uninitialized
    }

    async poll_eWind() {
        if (this.pollingInProgress) return;
        this.pollingInProgress = true;
        console.log('Polling eWind...');
        try {
            const checkRegisterRes = await checkRegister(this.registers, client);
            this.processResult({ ...checkRegisterRes });
            const checkCoilsRes = await checkCoils(this.coilRegisters, client);
            this.processResult({ ...checkCoilsRes });
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', new Date().toLocaleString('no-nb', { timeZone: 'CET', hour12: false }));
            }
        } catch (error) {
            console.error('Polling error:', error);
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', 'No connection');
            }
        } finally {
            this.pollingInProgress = false;
        }
    }

    async setEWindValue(value: string) {
        switch (value) {
            case "0":
                await this.sendCoilRequest(0, false);
                await this.sendCoilRequest(1, false);
                await this.sendCoilRequest(3, false);
                await this.sendCoilRequest(10, false);
                break;
            case "1":
                await this.sendCoilRequest(0, false);
                await this.sendCoilRequest(10, false);
                await this.sendCoilRequest(1, true);
                break;
            case "2":
                await this.sendCoilRequest(0, false);
                await this.sendCoilRequest(10, false);
                await this.sendCoilRequest(3, true);
                break;
            case "3":
                await this.sendCoilRequest(0, false);
                await this.sendCoilRequest(10, true);
                break;
            case "4":
                await this.sendCoilRequest(0, true);
                break;
            default:
                break;
        }
    }

    async sendHoldingRequest(register: number, value: number) {
        try {
            await client.writeSingleRegister(register, value);
        } catch (error) {
            console.error('Error sending holding request:', error);
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', 'No connection');
            }
        }
    } 
    
    async sendCoilRequest(register: number, value: boolean) {
        try {
            await client.writeSingleCoil(register, value);
        } catch (error) {
            console.error('Error sending coil request:', error);
            if (this.isActive) {
                this.setCapabilityValue('lastPollTime', 'No connection');
            }
        }
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

    registerFlowListeners() {
        if (this.flowListenersRegistered) return;

        // Action cards
        const ecomodeCard = this.homey.flow.getActionCard('ecomode');
        ecomodeCard.registerRunListener(async (args) => {
            args.device.setMode('ecomode_mode', args.ecomode);
            await this.sendCoilRequest(40, args.ecomode === '1');
        });
        
        const eWindStatusCard = this.homey.flow.getActionCard('status-mode');
        eWindStatusCard.registerRunListener(async (args) => {
            args.device.setMode('eWindstatus_mode', args.mode);
            await this.setEWindValue(args.mode);
        });

        const SetTemperatureCard = this.homey.flow.getActionCard('set-temperature');
        SetTemperatureCard.registerRunListener(async (args) => {
            this.setCapabilityValue('target_temperature.step', args.temperature);
            await this.sendHoldingRequest(135, args.temperature * 10);
        });

        // Mark flow listeners as registered
        this.flowListenersRegistered = true;
    }

    registerCapabilityListeners() {
        if (this.capabilityListenersRegistered) return;

        // Condition for eWindstatus_mode
        this.homey.flow.getConditionCard('eWindstatus_mode_is')
          .registerRunListener(async (args) => {
            return this.getCapabilityValue('eWindstatus_mode') === args.mode;
          });

        // Condition for heat_exchanger_mode
        this.homey.flow.getConditionCard('heat_exchanger_mode_is')
          .registerRunListener(async (args) => {
            return this.getCapabilityValue('heat_exchanger_mode') === args.mode;
          });

        // Condition for heater_mode
        this.homey.flow.getConditionCard('heater_mode_is')
          .registerRunListener(async (args) => {
            return this.getCapabilityValue('heater_mode') === args.mode;
          });

        this.registerCapabilityListener('eWindstatus_mode', async (value) => {
            this.log('Changes to :', value);
            await this.setEWindValue(value);
            await this.homey.flow.getDeviceTriggerCard('eWindstatus_mode_changed').trigger(this)
            .catch(this.error);
        });

        this.registerCapabilityListener('target_temperature.step', async (value) => {
            this.log('Changes to :', value);
            await this.sendHoldingRequest(135, value * 10);
        });

        this.registerCapabilityListener('ecomode_mode', async (value) => {
            this.log('Changes to :', value);
            await this.sendCoilRequest(40, value === '1');
        });

        // Register capability listener for heat_exchanger_mode
        this.registerCapabilityListener('heat_exchanger_mode', async (value) => {
          this.log('heat_exchanger_mode changed to:', value);
          await this.homey.flow.getDeviceTriggerCard('heat_exchanger_mode_changed').trigger(this)
            .catch(this.error);
        });

        // Register capability listener for heater_mode
        this.registerCapabilityListener('heater_mode', async (value) => {
          this.log('heater_mode changed to:', value);
          await this.homey.flow.getDeviceTriggerCard('heater_mode_changed').trigger(this)
            .catch(this.error);
        });

        // Register capability listener for alarm_b
        this.registerCapabilityListener('alarm_b', async (value) => {
          this.log('Alarm B triggered with value:', value);
          if (value) {
            // Trigger the flow card
            await this.homey.flow.getDeviceTriggerCard('alarm_b_triggered').trigger(this)
              .catch(this.error);
          }
        });

        // Mark capability listeners as registered
        this.capabilityListenersRegistered = true;
    }

    cleanup() {
        this.isActive = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.flowListenersRegistered = false;
        this.capabilityListenersRegistered = false;
        socket.end();  // Close the Modbus connection
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
        setTimeout(async () => {
            await this.poll_eWind(); // Poll 10 seconds after the device is added
        }, 10000); // 10 seconds delay
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
                if (this.isActive) {
                    this.setCapabilityValue('lastPollTime', 'No connection');
                }
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
        this.cleanup();  // Clean up when the device is deleted
    }

    delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = MyeWindDevice;

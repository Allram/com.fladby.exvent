import net from 'net';
import * as Modbus from 'jsmodbus';
import { eWind } from '../eWind';
import { checkRegister } from '../response';
import { checkCoils } from '../response_coil';

const socket = new net.Socket();
const client = new Modbus.client.TCP(socket, 255);
const RETRY_INTERVAL = 60 * 1000;
const CONNECTION_RETRY_INTERVAL = 30000; // Retry connection every 30 seconds if it fails

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

    private intervalId: NodeJS.Timeout | null = null;
    private connectionRetryId: NodeJS.Timeout | null = null;
    private flowListenersRegistered: boolean = false;
    private capabilityListenersRegistered: boolean = false;
    private pollingInProgress: boolean = false;
    private isActive: boolean = true;
    private skipNextIntervalPoll: boolean = false;
    private pollDebounceTimeout: NodeJS.Timeout | null = null;
    private isConnected: boolean = false;
    private isConnecting: boolean = false;

    async onInit() {
        this.log('MyeWindDevice has been initialized');
        currentDevice = this;
        this.isActive = true;
        socket.setKeepAlive(true);
        this.connectSocket();
        this.setCapabilities();
        this.registerFlowListeners();
        this.registerCapabilityListeners();
        socket.on('end', () => {
            try {
            this.log('Socket ended');
            this.isConnected = false;
            this.retryConnection();
            } catch (error) {
                this.log('Error socket end:', error);
            }
        });
        socket.on('timeout', () => {
            try {
            this.log('Socket timeout');
            this.isConnected = false;
            this.retryConnection();
            } catch (error) {
                this.log('Error socket timeout:', error);
            }
        });
        socket.on('error', (err: any) => {
            try {
            this.log('Socket error:', err);
            this.isConnected = false;
            this.retryConnection();
            } catch (error) {
                this.log('Error socket error:', error);
            }
        });
        socket.on('close', (err: any) => {
            try {
            this.log('Socket closed');
            this.isConnected = false;
            this.retryConnection();
            } catch (error) {
                this.log('Error socket closed:', error);
            }
        });
        socket.on('connect', () => {
            try {
            this.log('Socket connected');
            this.isConnected = true;
            this.isConnecting = false;
            this.clearRetryConnection();
            } catch (error) {
                this.log('Error socket connected:', error);
            }
        });
        socket.on('data', () => {
            if (this.isActive) {
                try {
                    this.setCapabilityValue('lastPollTime', new Date().toLocaleString('no-nb', { timeZone: 'CET', hour12: false }));
                } catch (error) {
                    this.log('Error socket on data:', error);
                }
            }
        });
        await this.poll_eWind();
        this.intervalId = setInterval(async () => {
            if (this.skipNextIntervalPoll) {
                this.skipNextIntervalPoll = false;
                return;
            }
            await this.poll_eWind();
        }, RETRY_INTERVAL);
    }

    connectSocket() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        this.log('Attempting to connect to Modbus server...');
        socket.connect(this.modbusOptions, () => {
            this.log('Connected to Modbus server');
            this.isConnecting = false;
            this.pollingInProgress = false;
            if (this.connectionRetryId) {
                clearTimeout(this.connectionRetryId);
                this.connectionRetryId = null;
            }
        });
    }

    retryConnection() {
        if (this.connectionRetryId || this.isConnecting) return; // Already retrying or connecting
        this.log('Retrying connection to Modbus server...');
        this.connectionRetryId = setTimeout(() => {
            this.connectSocket();
        }, CONNECTION_RETRY_INTERVAL);
    }

    clearRetryConnection() {
        if (this.connectionRetryId) {
            clearTimeout(this.connectionRetryId);
            this.connectionRetryId = null;
        }
    }

    async onUninit() {
        this.log('MyeWindDevice is being uninitialized');
        this.cleanup();
    }

    async ensureConnected() {
        if (this.isConnected) return;
        return new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.isConnected) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 500);
        });
    }

    async poll_eWind() {
        if (this.pollingInProgress) return;
        this.pollingInProgress = true;
        await this.ensureConnected();
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
        if (this.pollDebounceTimeout) {
            clearTimeout(this.pollDebounceTimeout);
        }
    
        this.pollDebounceTimeout = setTimeout(async () => {
            await this.ensureConnected();
            const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
            try {
                switch (value) {
                    case "0":
                        await this.sendCoilRequest(0, false);
                        await delay(1000);
                        await this.sendCoilRequest(1, false);
                        await delay(1000);
                        await this.sendCoilRequest(3, false);
                        await delay(1000);
                        await this.sendCoilRequest(10, false);
                        break;
                    case "1":
                        await this.sendCoilRequest(0, false);
                        await delay(1000);
                        await this.sendCoilRequest(10, false);
                        await delay(1000);
                        await this.sendCoilRequest(1, true);
                        break;
                    case "2":
                        await this.sendCoilRequest(0, false);
                        await delay(1000);
                        await this.sendCoilRequest(10, false);
                        await delay(1000);
                        await this.sendCoilRequest(3, true);
                        break;
                    case "3":
                        await this.sendCoilRequest(0, false);
                        await delay(1000);
                        await this.sendCoilRequest(10, true);
                        break;
                    case "4":
                        await this.sendCoilRequest(0, true);
                        break;
                    default:
                        break;
                }
                // Update the capability value after sending the command
                await delay(10000); // Wait for 10 seconds
                await this.poll_eWind(); // Poll once immediately after setting the value
                this.skipNextIntervalPoll = true; // Skip the next interval poll
                this.setCapabilityValue('eWindstatus_mode', value);
            } catch (error) {
                console.error('Error setting eWind value:', error);
            }
        }, 1000);
    }
    

    async sendHoldingRequest(register: number, value: number) {
        if (this.pollDebounceTimeout) {
            clearTimeout(this.pollDebounceTimeout);
        }

        this.pollDebounceTimeout = setTimeout(async () => {
            await this.ensureConnected();
            try {
                await client.writeSingleRegister(register, value);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds
                await this.poll_eWind(); // Poll once immediately after sending the request
                this.skipNextIntervalPoll = true; // Skip the next interval poll
            } catch (error) {
                console.error('Error sending holding request:', error);
                if (this.isActive) {
                    this.setCapabilityValue('lastPollTime', 'No connection');
                }
            }
        }, 1000);
    }

    async sendCoilRequest(register: number, value: boolean) {
        if (this.pollDebounceTimeout) {
            clearTimeout(this.pollDebounceTimeout);
        }

        this.pollDebounceTimeout = setTimeout(async () => {
            await this.ensureConnected();
            try {
                await client.writeSingleCoil(register, value);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds
                await this.poll_eWind(); // Poll once immediately after sending the request
                this.skipNextIntervalPoll = true; // Skip the next interval poll
            } catch (error) {
                console.error('Error sending coil request:', error);
                if (this.isActive) {
                    this.setCapabilityValue('lastPollTime', 'No connection');
                }
            }
        }, 1000);
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
        if (this.hasCapability('heating_coil_state') === false) {
            await this.addCapability('heating_coil_state');
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

        const ecomodeCard = this.homey.flow.getActionCard('ecomode');
        ecomodeCard.registerRunListener(async (args) => {
            args.device.setMode('ecomode_mode', args.ecomode);
            await this.sendCoilRequest(40, args.ecomode === '1');
        });

        const HeatingCoilCard = this.homey.flow.getActionCard('heatingcoil');
        HeatingCoilCard.registerRunListener(async (args) => {
            args.device.setMode('heating_coil_state', args.ecomode);
            await this.sendCoilRequest(54, args.ecomode === '1');
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

        this.flowListenersRegistered = true;
    }

    registerCapabilityListeners() {
        if (this.capabilityListenersRegistered) return;

        this.homey.flow.getConditionCard('eWindstatus_mode_is')
            .registerRunListener(async (args) => {
                return this.getCapabilityValue('eWindstatus_mode') === args.mode;
            });

        this.homey.flow.getConditionCard('heat_exchanger_mode_is')
            .registerRunListener(async (args) => {
                return this.getCapabilityValue('heat_exchanger_mode') === args.mode;
            });

        this.homey.flow.getConditionCard('heater_mode_is')
            .registerRunListener(async (args) => {
                return this.getCapabilityValue('heater_mode') === args.mode;
            });

        this.registerCapabilityListener('eWindstatus_mode', async (value) => {
            this.log('Changes to :', value);
            await this.setEWindValue(value);
            await this.homey.flow.getDeviceTriggerCard('eWindstatus_mode_changed').trigger(this)
                .catch(this.error);
            await this.poll_eWind();
        });

        this.registerCapabilityListener('target_temperature.step', async (value) => {
            this.log('Changes to :', value);
            await this.sendHoldingRequest(135, value * 10);
            await this.poll_eWind();
        });

        this.registerCapabilityListener('ecomode_mode', async (value) => {
            this.log('Changes to :', value);
            await this.sendCoilRequest(40, value === '1');
            await this.poll_eWind();
        });

        this.registerCapabilityListener('heat_exchanger_mode', async (value) => {
            this.log('heat_exchanger_mode changed to:', value);
            await this.homey.flow.getDeviceTriggerCard('heat_exchanger_mode_changed').trigger(this)
                .catch(this.error);
        });

        this.registerCapabilityListener('heater_mode', async (value) => {
            this.log('heater_mode changed to:', value);
            await this.homey.flow.getDeviceTriggerCard('heater_mode_changed').trigger(this)
                .catch(this.error);
        });

        this.registerCapabilityListener('alarm_b', async (value) => {
            this.log('Alarm B triggered with value:', value);
            if (value) {
                await this.homey.flow.getDeviceTriggerCard('alarm_b_triggered').trigger(this)
                    .catch(this.error);
            }
        });

        this.registerCapabilityListener('heating_coil_state', async (value) => {
            this.log('Heater changed to :', value);
            
            // Convert different types of values to boolean: true, "1", "true" => true; false, "0", "false" => false
            const coilValue = (value === true || value === '1' || value === 'true') ? true : 
                              (value === false || value === '0' || value === 'false') ? false : null;
        
            if (coilValue !== null) {
                await this.sendCoilRequest(54, coilValue);
            } else {
                this.log('Invalid heater value:', value);
            }
            
            await this.poll_eWind();
        });

        this.capabilityListenersRegistered = true;
    }

    cleanup() {
        this.isActive = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.pollDebounceTimeout) {
            clearTimeout(this.pollDebounceTimeout);
            this.pollDebounceTimeout = null;
        }
        if (this.connectionRetryId) {
            clearTimeout(this.connectionRetryId);
            this.connectionRetryId = null;
        }
        this.flowListenersRegistered = false;
        this.capabilityListenersRegistered = false;
        socket.end();
    }

    async setMode(mode: string, value: string): Promise<void> {
        if (!this.getAvailable()) {
            return;
        }
        this.setCapabilityValue(mode, value);
    }

    async onAdded() {
        this.log('MyeWindDevice has been added');
        setTimeout(async () => {
            await this.poll_eWind();
        }, 10000);
    }

    async onSettings({ newSettings }: { newSettings: Record<string, any>; changedKeys: string[] }) {
        if (newSettings && (newSettings.address || newSettings.port)) {
            try {
                this.log('IP address or port changed. Reconnecting...');
                this.modbusOptions.host = newSettings.address;
                this.modbusOptions.port = newSettings.port;
                socket.end();
                await this.delay(1000);
                this.connectSocket();
                //this.log('Reconnected successfully.');
            } catch (error: any) {
                this.error('Error reconnecting:', (error as Error).message);
                if (this.isActive) {
                    this.setCapabilityValue('lastPollTime', 'No connection');
                }
            }
        }
    }

    async onRenamed(name: string) {
        this.log('MyeWindDevice was renamed');
    }

    async onDeleted() {
        this.log('MyeWindDevice has been deleted');
        this.cleanup();
    }

    delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = MyeWindDevice;

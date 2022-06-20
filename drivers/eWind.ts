import { info } from 'console';
import Homey from 'homey';

export interface Measurement {
    value: string;
    scale: string;
    label: string;
}

export class eWind extends Homey.Device {
    registers: Object = {
        "air_outside": [6, 1, 'INT16', "Fresh air"],
        "air_supply_HRC": [7, 1, 'INT16', "Supply air after HRC"],
        "air_supply": [8, 1, 'INT16', "Supply air"], 
        "air_exhaust": [9, 1, 'INT16', "Exhaust air"], 
        "air_extract": [10, 1, 'INT16', "Extract air temperature"], 
        "air_humidity": [13, 1, 'UINT16', "Air humidity extract"], 
        "air_supply_eff": [29, 1, 'UINT16', "Heat recovery efficiency, supply air"], 
        "air_extract_eff": [30, 1, 'UINT16', "Heat recovery efficiency, exhaust air"], 
        "temperature_setpoint": [135, 1, 'INT16', "Temperature setpoint"], 
        "fan_speed_level": [50, 1, 'UINT16', "Fan speed level"], 
        "status": [49, 1, 'INT16', "status"], 
        "status_mode": [44, 1, 'INT16', "statusMode"], 
    };

    processResult(result: Record<string, Measurement>) {
        if (!result) {
            return;
        }

        // result
        for (let k in result) {
            console.log(k, result[k].value, result[k].scale, result[k].label)   
        }

        if (result['air_outside'] && result['air_outside'].value !== 'xxx') {
            this.addCapability('measure_temperature.outsideAir');
            let air_outside = ((Number(result['air_outside'].value) / 10));
            this.setCapabilityValue('measure_temperature.outsideAir', air_outside);
        }

        if (result['air_extract'] && result['air_extract'].value !== 'xxx') {
            this.addCapability('measure_temperature.extractAir');
            let extractair = ((Number(result['air_extract'].value) / 10));
            this.setCapabilityValue('measure_temperature.extractAir', extractair);
        }

        if (result['air_supply'] && result['air_supply'].value !== 'xxx') {
            this.addCapability('measure_temperature.supplyAir');
            this.addCapability('measure_temperature');
            let airsupply = ((Number(result['air_supply'].value) / 10));
            this.setCapabilityValue('measure_temperature.supplyAir', airsupply);
        }
        
        if (result['air_supply_HRC'] && result['air_supply_HRC'].value !== 'xxx') {
            this.addCapability('measure_temperature.supplyAirHRC');
            let temperature = ((Number(result['air_supply_HRC'].value) / 10));
            this.setCapabilityValue('measure_temperature.supplyAirHRC', temperature);
            this.setCapabilityValue('measure_temperature', temperature);
        }

        if (result['air_exhaust'] && result['air_exhaust'].value !== 'xxx') {
            this.addCapability('measure_temperature.exhaustAir');
            let temperature = ((Number(result['air_exhaust'].value) / 10));
            this.setCapabilityValue('measure_temperature.exhaustAir', temperature);
        }

        if (result['temperature_setpoint'] && result['temperature_setpoint'].value !== 'xxx') {
            this.addCapability('target_temperature');
            let temperature = ((Number(result['temperature_setpoint'].value) / 10));
            this.setCapabilityValue('target_temperature', temperature);
        }

        if (result['air_humidity'] && result['air_humidity'].value !== 'xxx') {
            this.addCapability('measure_humidity.extractAir');
            let humidity = ((Number(result['air_humidity'].value)));
            this.setCapabilityValue('measure_humidity.extractAir', humidity);
        }

        if (result['air_supply_eff'] && result['air_supply_eff'].value !== 'xxx') {
            this.addCapability('efficiency.supplyEff');
            let humidity = ((Number(result['air_supply_eff'].value) / 10));
            this.setCapabilityValue('efficiency.supplyEff', humidity);
        }

        if (result['air_extract_eff'] && result['air_extract_eff'].value !== 'xxx') {
            this.addCapability('efficiency.extractEff');
            let humidity = ((Number(result['air_extract_eff'].value) / 10));
            this.setCapabilityValue('efficiency.extractEff', humidity);
        }

        if (result['fan_speed_level'] && result['fan_speed_level'].value !== 'xxx') {
            this.addCapability('fanspeed_level');
            let humidity = ((Number(result['fan_speed_level'].value)));
            this.setCapabilityValue('fanspeed_level', humidity);
        }



        if (result['status'] && result['status'].value !== 'xxx') {
            this.addCapability('eWindstatus');
            let statusValue = Number(result['status'].value);
            if (statusValue === 0) { 
                this.setCapabilityValue('eWindstatus', '0');
            } else if (statusValue >= -100 && statusValue <= -1) {
                this.setCapabilityValue('eWindstatus', '1');
            } else if (statusValue >= 1 && statusValue <= 100) {
                this.setCapabilityValue('eWindstatus', '2');
            } else if (statusValue >= 101 && statusValue <= 200) {
                this.setCapabilityValue('eWindstatus', '3');
            } else if (statusValue >= 201 && statusValue <= 300) {
                this.setCapabilityValue('eWindstatus', '4');
            }

        if (result['status_mode'] && result['status_mode'].value !== 'xxx') {
            this.addCapability('eWindstatus_mode');
            let statusValue = result['status_mode'].value;
            if (statusValue === "0") { 
                this.setCapabilityValue('eWindstatus_mode', '0');
            } else if (statusValue === "16") {
                this.setCapabilityValue('eWindstatus_mode', '1');
            } else if (statusValue === "1024") {
                this.setCapabilityValue('eWindstatus_mode', '2');
            } else if (statusValue === "512") {
                this.setCapabilityValue('eWindstatus_mode', '3');
            }
            }  
        }
    }
}
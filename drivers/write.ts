import * as Modbus from 'jsmodbus';
import { Measurement } from './eWind';

export async function writeSingleRegister(registers: Object, client: InstanceType<typeof Modbus.client.TCP>) {
    let result: Record<string, Measurement> = {};
    for (const [key, value] of Object.entries(registers)) {
        try {
            const res = client.readHoldingRegisters(value[0], value[1])
            const actualRes = await res;
            // const metrics = actualRes.metrics;
            // const request = actualRes.request;
            const response = actualRes.response;
            const measurement: Measurement = {
                value: 'xxx',
                scale: 'xxx',
                label: value[3],
            };
            let resultValue: string = 'xxx';
            switch (value[2]) {
                case 'UINT16':
                    resultValue = response.body.valuesAsBuffer.readInt16BE().toString();
                    break;
                case 'UINT32':
                    resultValue = response.body.valuesAsArray[0].toString();
                    // console.log( response.body);
                    break;
                case 'ACC32':
                    resultValue = response.body.valuesAsBuffer.readUInt32BE().toString();
                    break;
                case 'FLOAT':
                    resultValue = response.body.valuesAsBuffer.readFloatBE().toString();
                    break;
                case 'STRING':
                    resultValue = response.body.valuesAsBuffer.toString();
                    break;
                case 'INT16':
                    resultValue = response.body.valuesAsBuffer.readInt16BE().toString();
                    break;
                case 'SCALE':
                    resultValue = response.body.valuesAsBuffer.readInt16BE().toString();
                    // console.log(value[3] + ": " + resultValue);
                    // console.log(key.replace('_scale', ''));
                    result[key.replace('_scale', '')].scale = resultValue
                    break;
                case 'FLOAT32':
                    resultValue = response.body.valuesAsBuffer.swap16().swap32().readFloatBE().toString();
                    break;
                default:
                    console.log(key + ": type not found " + value[2]);
                    break;
            }
            measurement.value = resultValue;
            result[key] = measurement;

        } catch (err) {
            console.log("error with key: " + key);
            // console.log(err);
        }
    }

    // console.log('writeSingleRegister result');
    return result;
}


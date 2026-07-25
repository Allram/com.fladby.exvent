import * as Modbus from 'jsmodbus';

export interface Measurement {
    value: string;
    scale: string;
    label: string;
}

/** [address, length, type, label] */
export type RegisterMap = Record<string, [number, number, string, string]>;

/**
 * Reads every entry in a register map and decodes the response.
 * Shared by holding-register and coil reads; only the client call differs.
 */
export async function readModbus(
    client: InstanceType<typeof Modbus.client.TCP>,
    registers: RegisterMap,
    kind: 'holding' | 'coil',
): Promise<Record<string, Measurement>> {
    const result: Record<string, Measurement> = {};
    let successCount = 0;
    for (const [key, value] of Object.entries(registers)) {
        try {
            const actualRes = await (kind === 'holding'
                ? client.readHoldingRegisters(value[0], value[1])
                : client.readCoils(value[0], value[1]));
            const response = actualRes.response;
            const measurement: Measurement = {
                value: 'xxx',
                scale: 'xxx',
                label: value[3],
            };
            let resultValue: string = 'xxx';
            switch (value[2]) {
                case 'UINT16':
                    resultValue = response.body.valuesAsBuffer.readUInt16BE().toString();
                    break;
                case 'UINT32':
                    resultValue = response.body.valuesAsArray[0].toString();
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
                    result[key.replace('_scale', '')].scale = resultValue;
                    break;
                case 'FLOAT32':
                    resultValue = response.body.valuesAsBuffer.swap16().swap32().readFloatBE().toString();
                    break;
                default:
                    break;
            }
            measurement.value = resultValue;
            result[key] = measurement;
            successCount++;
        } catch (err) {
            // Individual register failures are tolerated; only a fully dead
            // device (no register responding) is treated as an error below.
        }
    }

    if (successCount === 0) {
        throw new Error(kind === 'holding' ? 'No holding registers responded' : 'No coils responded');
    }

    return result;
}

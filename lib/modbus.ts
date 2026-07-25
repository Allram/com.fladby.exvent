import * as Modbus from 'jsmodbus';

export interface Measurement {
    value: string;
    scale: string;
    label: string;
}

/** [address, length, type, label] */
export type RegisterMap = Record<string, [number, number, string, string]>;

export type ModbusKind = 'holding' | 'coil';

export interface RegisterEntry {
    key: string;
    addr: number;
    len: number;
    type: string;
    label: string;
}

// Merge registers into one request when the gap of unmapped addresses
// between them is at most this large. Coils are single bits, so a wider
// span costs next to nothing; holding registers are kept tighter.
const MAX_GAP: Record<ModbusKind, number> = { holding: 3, coil: 12 };
const MAX_BLOCK_LENGTH = 32;

export function toBlocks(registers: RegisterMap, kind: ModbusKind): RegisterEntry[][] {
    const entries: RegisterEntry[] = Object.entries(registers)
        .map(([key, def]) => ({ key, addr: def[0], len: def[1], type: def[2], label: def[3] }))
        .sort((a, b) => a.addr - b.addr);

    const blocks: RegisterEntry[][] = [];
    let current: RegisterEntry[] = [];
    for (const entry of entries) {
        if (current.length > 0) {
            const last = current[current.length - 1];
            const gap = entry.addr - (last.addr + last.len);
            const blockLength = entry.addr + entry.len - current[0].addr;
            if (gap > MAX_GAP[kind] || blockLength > MAX_BLOCK_LENGTH) {
                blocks.push(current);
                current = [];
            }
        }
        current.push(entry);
    }
    if (current.length > 0) blocks.push(current);
    return blocks;
}

export function decode(response: any, entry: RegisterEntry, blockStart: number, kind: ModbusKind): Measurement {
    const measurement: Measurement = {
        value: 'xxx',
        scale: 'xxx',
        label: entry.label,
    };
    if (kind === 'coil') {
        const bit = response.body.valuesAsArray[entry.addr - blockStart];
        measurement.value = Number(bit).toString();
        return measurement;
    }
    const buffer = response.body.valuesAsBuffer;
    const offset = (entry.addr - blockStart) * 2;
    switch (entry.type) {
        case 'INT16':
            measurement.value = buffer.readInt16BE(offset).toString();
            break;
        case 'UINT16':
            measurement.value = buffer.readUInt16BE(offset).toString();
            break;
        case 'UINT32':
        case 'ACC32':
            measurement.value = buffer.readUInt32BE(offset).toString();
            break;
        case 'FLOAT':
            measurement.value = buffer.readFloatBE(offset).toString();
            break;
        default:
            break;
    }
    return measurement;
}

/**
 * Reads every entry in a register map, batching adjacent registers into as
 * few Modbus requests as possible. If a batched read is rejected (some
 * firmwares refuse spans that touch unmapped addresses), the registers in
 * that block are read individually instead.
 */
export async function readModbus(
    client: InstanceType<typeof Modbus.client.TCP>,
    registers: RegisterMap,
    kind: ModbusKind,
): Promise<Record<string, Measurement>> {
    const read = (start: number, length: number) => (kind === 'holding'
        ? client.readHoldingRegisters(start, length)
        : client.readCoils(start, length));

    const result: Record<string, Measurement> = {};
    let successCount = 0;

    for (const block of toBlocks(registers, kind)) {
        const start = block[0].addr;
        const last = block[block.length - 1];
        const length = last.addr + last.len - start;
        try {
            const { response } = await read(start, length);
            for (const entry of block) {
                result[entry.key] = decode(response, entry, start, kind);
                successCount++;
            }
        } catch (blockErr) {
            for (const entry of block) {
                try {
                    const { response } = await read(entry.addr, entry.len);
                    result[entry.key] = decode(response, entry, entry.addr, kind);
                    successCount++;
                } catch (err) {
                    // Individual register failures are tolerated; only a fully
                    // dead device (nothing responding) is treated as an error.
                }
            }
        }
    }

    if (successCount === 0) {
        throw new Error(kind === 'holding' ? 'No holding registers responded' : 'No coils responded');
    }

    return result;
}

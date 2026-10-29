"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toBlocks = toBlocks;
exports.decode = decode;
exports.requestFailure = requestFailure;
exports.describeError = describeError;
exports.readModbus = readModbus;
// Merge registers into one request when the gap of unmapped addresses
// between them is at most this large. Coils are single bits, so a wider
// span costs next to nothing; holding registers are kept tighter.
const MAX_GAP = { holding: 3, coil: 12 };
const MAX_BLOCK_LENGTH = 32;
function toBlocks(registers, kind) {
    const entries = Object.entries(registers)
        .map(([key, def]) => ({
        key, addr: def[0], len: def[1], type: def[2], label: def[3],
    }))
        .sort((a, b) => a.addr - b.addr);
    const blocks = [];
    let current = [];
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
    if (current.length > 0)
        blocks.push(current);
    return blocks;
}
// The register maps never change after a device is set up, so their blocks
// are worked out once per map.
const blockCache = {
    holding: new WeakMap(), coil: new WeakMap(),
};
function cachedBlocks(registers, kind) {
    let blocks = blockCache[kind].get(registers);
    if (!blocks) {
        blocks = toBlocks(registers, kind);
        blockCache[kind].set(registers, blocks);
    }
    return blocks;
}
function decode(response, entry, blockStart, kind) {
    const measurement = {
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
function requestFailure(err) {
    switch (err && err.err) {
        case 'ModbusException': return 'exception';
        case 'Timeout': return 'timeout';
        case 'OutOfSync':
        case 'Protocol': return 'outOfSync';
        case 'Offline':
        case 'ManuallyCleared': return 'offline';
        default: return 'other';
    }
}
/** A short description of a request or socket error for the log. */
function describeError(err) {
    if (err && typeof err.err === 'string')
        return err.message ? `${err.err}: ${err.message}` : err.err;
    if (err && err.code)
        return `${err.code}${err.message ? ` (${err.message})` : ''}`;
    return err && err.message ? err.message : String(err);
}
/**
 * Reads every entry in a register map, batching adjacent registers into as
 * few Modbus requests as possible. If the unit answers a batched read with a
 * Modbus exception (some firmwares refuse spans that touch unmapped
 * addresses), the registers in that block are read individually instead.
 * A timeout or a lost connection is not a refused span: the first register
 * of the block is tried alone once, and if that fails too the read fails,
 * so the caller can reconnect instead of timing out on every register.
 */
async function readModbus(client, registers, kind) {
    const read = (start, length) => (kind === 'holding'
        ? client.readHoldingRegisters(start, length)
        : client.readCoils(start, length));
    const result = {};
    let successCount = 0;
    for (const block of cachedBlocks(registers, kind)) {
        const start = block[0].addr;
        const last = block[block.length - 1];
        const length = last.addr + last.len - start;
        try {
            const { response } = await read(start, length);
            for (const entry of block) {
                result[entry.key] = decode(response, entry, start, kind);
                successCount++;
            }
        }
        catch (blockErr) {
            if (requestFailure(blockErr) !== 'exception') {
                const first = block[0];
                const { response } = await read(first.addr, first.len);
                result[first.key] = decode(response, first, first.addr, kind);
                successCount++;
            }
            for (const entry of block) {
                if (result[entry.key])
                    continue;
                try {
                    const { response } = await read(entry.addr, entry.len);
                    result[entry.key] = decode(response, entry, entry.addr, kind);
                    successCount++;
                }
                catch {
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

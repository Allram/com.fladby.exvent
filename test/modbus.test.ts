import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  toBlocks, decode, readModbus, requestFailure, RegisterMap,
} from '../lib/modbus';
import { EAIR_HOLDING_REGISTERS, EWIND_HOLDING_REGISTERS, EXVENT_COILS } from '../lib/exvent';

function blockSpans(blocks: ReturnType<typeof toBlocks>): Array<[number, number]> {
  return blocks.map((block) => {
    const last = block[block.length - 1];
    return [block[0].addr, last.addr + last.len - block[0].addr];
  });
}

test('eWind holding registers batch into 10 requests', () => {
  assert.deepEqual(blockSpans(toBlocks(EWIND_HOLDING_REGISTERS, 'holding')), [
    [6, 8], // 6..13 incl. the 11/12 gap
    [29, 2], // 29..30
    [44, 7], // 44..50: the controller output (49) joins the mode, step and fan level
    [56, 2], // 56..57
    [66, 1],
    [134, 4], // 134..137
    [385, 2],
    [538, 1],
    [710, 1],
  ]);
});

test('eAir reads the fan speeds with the temperatures and has no boost duration', () => {
  const spans = blockSpans(toBlocks(EAIR_HOLDING_REGISTERS, 'holding'));
  assert.deepEqual(spans[0], [3, 11]); // 3..13
  assert.ok(!spans.some(([start]) => start === 66));
});

test('coils batch into a single request', () => {
  assert.deepEqual(blockSpans(toBlocks(EXVENT_COILS, 'coil')), [[30, 25]]); // 30..54
});

test('blocks preserve every register exactly once', () => {
  const blocks = toBlocks(EWIND_HOLDING_REGISTERS, 'holding');
  const keys = blocks.flat().map((entry) => entry.key).sort();
  assert.deepEqual(keys, Object.keys(EWIND_HOLDING_REGISTERS).sort());
});

test('a gap wider than the tolerance splits holding blocks', () => {
  const map: RegisterMap = {
    a: [0, 1, 'UINT16', 'a'],
    b: [5, 1, 'UINT16', 'b'], // gap of 4 > holding tolerance 3
  };
  assert.deepEqual(blockSpans(toBlocks(map, 'holding')), [[0, 1], [5, 1]]);
});

test('blocks never exceed the max length', () => {
  const map: RegisterMap = {};
  for (let i = 0; i < 20; i++) {
    map[`r${i}`] = [i * 2, 1, 'UINT16', `r${i}`]; // gap 1, span 39 > 32
  }
  const spans = blockSpans(toBlocks(map, 'holding'));
  assert.ok(spans.length > 1);
  for (const [, length] of spans) {
    assert.ok(length <= 32, `block length ${length} exceeds max`);
  }
});

test('decode INT16 reads negative values at the correct offset', () => {
  // Block starting at 6; register 8 sits at offset 4. -12.3°C = -123 raw.
  const buffer = Buffer.alloc(8);
  buffer.writeInt16BE(-123, 4);
  const response = { body: { valuesAsBuffer: buffer } };
  const entry = {
    key: 'air_supply', addr: 8, len: 1, type: 'INT16', label: 'Supply air',
  };
  assert.equal(decode(response, entry, 6, 'holding').value, '-123');
});

test('decode UINT16 reads values above 32767', () => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(40000, 2);
  const response = { body: { valuesAsBuffer: buffer } };
  const entry = {
    key: 'x', addr: 1, len: 1, type: 'UINT16', label: 'x',
  };
  assert.equal(decode(response, entry, 0, 'holding').value, '40000');
});

test('decode coil picks the right bit from a block', () => {
  // Block 30..54: coil 40 sits at index 10.
  const bits = new Array(25).fill(0);
  bits[10] = 1;
  const response = { body: { valuesAsArray: bits } };
  const entry = {
    key: 'eco_mode', addr: 40, len: 1, type: 'BIT', label: 'eco Mode',
  };
  assert.equal(decode(response, entry, 30, 'coil').value, '1');
  const off = {
    key: 'heating_coil', addr: 54, len: 1, type: 'BIT', label: 'coil',
  };
  assert.equal(decode(response, off, 30, 'coil').value, '0');
});

test('decode returns xxx for unknown types', () => {
  const response = { body: { valuesAsBuffer: Buffer.alloc(2) } };
  const entry = {
    key: 'x', addr: 0, len: 1, type: 'BOGUS', label: 'x',
  };
  assert.equal(decode(response, entry, 0, 'holding').value, 'xxx');
});

/** A client that answers every read with the given error, and counts the requests. */
function failingClient(err: unknown) {
  const requests: string[] = [];
  const fail = async (start: number, length: number) => {
    requests.push(`${start}+${length}`);
    throw err;
  };
  return { requests, client: { readHoldingRegisters: fail, readCoils: fail } };
}

test('a timeout gives up after one more request instead of reading every register', async () => {
  const { requests, client } = failingClient({ err: 'Timeout' });
  await assert.rejects(readModbus(client as any, EWIND_HOLDING_REGISTERS, 'holding'));
  assert.deepEqual(requests, ['6+8', '6+1']);
});

test('a refused span falls back to reading each register', async () => {
  const { requests, client } = failingClient({ err: 'ModbusException' });
  await assert.rejects(readModbus(client as any, { a: [6, 1, 'INT16', 'a'], b: [8, 1, 'INT16', 'b'] }, 'holding'), /No holding registers responded/);
  assert.deepEqual(requests, ['6+3', '6+1', '8+1']);
});

test('request failures are told apart', () => {
  assert.equal(requestFailure({ err: 'ModbusException' }), 'exception');
  assert.equal(requestFailure({ err: 'Timeout' }), 'timeout');
  assert.equal(requestFailure({ err: 'OutOfSync' }), 'outOfSync');
  assert.equal(requestFailure({ err: 'Offline' }), 'offline');
  assert.equal(requestFailure(new Error('ECONNREFUSED')), 'other');
});

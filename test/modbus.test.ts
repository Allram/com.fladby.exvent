import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toBlocks, decode, RegisterMap } from '../lib/modbus';

// The actual register maps used by the drivers.
const holdingRegisters: RegisterMap = {
  air_outside: [6, 1, 'INT16', 'Fresh air'],
  air_supply_HRC: [7, 1, 'INT16', 'Supply air after HRC'],
  air_supply: [8, 1, 'INT16', 'Supply air'],
  air_exhaust: [9, 1, 'INT16', 'Exhaust air'],
  air_extract: [10, 1, 'INT16', 'Extract air temperature'],
  air_humidity: [13, 1, 'UINT16', 'Air humidity extract'],
  air_supply_eff: [29, 1, 'UINT16', 'Heat recovery efficiency, supply air'],
  air_extract_eff: [30, 1, 'UINT16', 'Heat recovery efficiency, exhaust air'],
  temperature_setpoint: [135, 1, 'INT16', 'Temperature setpoint'],
  fan_speed_level: [50, 1, 'UINT16', 'Fan speed level'],
  status: [45, 1, 'INT16', 'status'],
  status_mode: [44, 1, 'INT16', 'statusMode'],
  service_interval_days: [538, 1, 'UINT16', 'Days until service reminder alarm'],
  days_since_service_ack: [710, 1, 'UINT16', 'Days since service reminder was acknowledged'],
};

const coilRegisters: RegisterMap = {
  eco_mode: [40, 1, 'UINT32', 'eco Mode'],
  alarm_b_desc: [42, 1, 'UINT32', 'Alarm B description'],
  heater_status: [32, 1, 'UINT32', 'After-heater On/Off'],
  heat_exchanger_state: [30, 1, 'UINT32', 'State of Heat exchanger On/Off'],
  heating_coil: [54, 1, 'UINT32', 'State of Heater coil On/Off'],
};

function blockSpans(blocks: ReturnType<typeof toBlocks>): Array<[number, number]> {
  return blocks.map((block) => {
    const last = block[block.length - 1];
    return [block[0].addr, last.addr + last.len - block[0].addr];
  });
}

test('holding registers batch into 7 requests', () => {
  const blocks = toBlocks(holdingRegisters, 'holding');
  assert.deepEqual(blockSpans(blocks), [
    [6, 8], // 6..13 incl. the 11/12 gap
    [29, 2], // 29..30
    [44, 2], // 44..45
    [50, 1],
    [135, 1],
    [538, 1],
    [710, 1],
  ]);
});

test('coils batch into a single request', () => {
  const blocks = toBlocks(coilRegisters, 'coil');
  assert.deepEqual(blockSpans(blocks), [[30, 25]]); // 30..54
});

test('blocks preserve every register exactly once', () => {
  const blocks = toBlocks(holdingRegisters, 'holding');
  const keys = blocks.flat().map((entry) => entry.key).sort();
  assert.deepEqual(keys, Object.keys(holdingRegisters).sort());
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
    key: 'eco_mode', addr: 40, len: 1, type: 'UINT32', label: 'eco Mode',
  };
  assert.equal(decode(response, entry, 30, 'coil').value, '1');
  const off = {
    key: 'heating_coil', addr: 54, len: 1, type: 'UINT32', label: 'coil',
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

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toBlocks } from '../lib/modbus';
import {
  EDA_COILS, EDA_HOLDING_REGISTERS, EDA_STATE, edaDefrosting, edaOverpressure, edaStatusMode,
} from '../lib/eda';

function blockSpans(blocks: ReturnType<typeof toBlocks>): Array<[number, number]> {
  return blocks.map((block) => {
    const last = block[block.length - 1];
    return [block[0].addr, last.addr + last.len - block[0].addr];
  });
}

test('EDA state bits map to status modes', () => {
  assert.equal(edaStatusMode(0), '0');
  assert.equal(edaStatusMode(EDA_STATE.AWAY), '1');
  assert.equal(edaStatusMode(EDA_STATE.LONG_AWAY), '1');
  assert.equal(edaStatusMode(EDA_STATE.OVERPRESSURE), '2');
  assert.equal(edaStatusMode(EDA_STATE.BOOST), '3');
  assert.equal(edaStatusMode(EDA_STATE.STOP), '4');
  assert.equal(edaStatusMode(EDA_STATE.EMERGENCY_STOP), '4');
});

test('EDA status mode survives other bits being set', () => {
  // CO2 and humidity boost are the unit's own and leave the mode at home.
  assert.equal(edaStatusMode(128 | 256), '0');
  assert.equal(edaStatusMode(EDA_STATE.DEFROSTING), '0');
  assert.equal(edaStatusMode(EDA_STATE.DEFROSTING | EDA_STATE.OVERPRESSURE), '2');
  assert.equal(edaStatusMode(EDA_STATE.STOP | EDA_STATE.AWAY), '4');
});

test('EDA status mode handles the register read as signed', () => {
  // 32768 + 1024 read as INT16
  assert.equal(edaStatusMode(-31744), '2');
});

test('EDA holding registers batch without the MD-only registers', () => {
  assert.deepEqual(blockSpans(toBlocks(EDA_HOLDING_REGISTERS, 'holding')), [
    [6, 8],
    [29, 2],
    [44, 2],
    [50, 8], // 50..57
    [135, 1],
    [164, 1],
    [196, 1],
    [538, 1],
  ]);
  const addresses = Object.values(EDA_HOLDING_REGISTERS).map(([addr]) => addr);
  assert.ok(!addresses.includes(56), 'HREG 56 is read only on EDA');
  assert.ok(!addresses.includes(710), 'HREG 710 does not exist on EDA');
});

test('EDA coils batch into two requests without eco mode', () => {
  assert.deepEqual(blockSpans(toBlocks(EDA_COILS, 'coil')), [[16, 27], [49, 6]]); // 16..42, 49..54
  const addresses = Object.values(EDA_COILS).map(([addr]) => addr);
  assert.ok(!addresses.includes(40), 'coil 40 is reserved on EDA');
});

test('EDA defrosting is the top bit, however the register is read', () => {
  assert.equal(edaDefrosting(0), false);
  assert.equal(edaDefrosting(EDA_STATE.OVERPRESSURE), false);
  assert.equal(edaDefrosting(EDA_STATE.DEFROSTING), true);
  assert.equal(edaDefrosting(EDA_STATE.DEFROSTING | EDA_STATE.AWAY), true);
  assert.equal(edaDefrosting(-32768), true);
});

test('EDA overpressure follows its bit alone', () => {
  assert.equal(edaOverpressure(0), false);
  assert.equal(edaOverpressure(EDA_STATE.OVERPRESSURE), true);
  assert.equal(edaOverpressure(EDA_STATE.OVERPRESSURE | EDA_STATE.STOP), true);
  assert.equal(edaOverpressure(EDA_STATE.BOOST | EDA_STATE.DEFROSTING), false);
});

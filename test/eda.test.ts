import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toBlocks } from '../lib/modbus';
import {
  EDA_COILS, EDA_HOLDING_REGISTERS, EDA_MODE_COILS, EDA_STATE, edaDefrosting, edaOverpressure, edaStatus, edaStatusMode,
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

test('EDA status covers every temperature control step in the register list', () => {
  // 0 nothing, 1 cooling, 2 heat recovery, 4 heating, 5 step delay, 6 summer
  // night cooling, 7 startup, 8 stop, 9 HR clean, 10 EXT unit defrost
  const steps = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10].map(edaStatus);
  assert.deepEqual(steps, ['0', '1', '2', '3', '6', '7', '4', '5', '8', '9']);
  assert.equal(new Set(steps).size, steps.length);
  assert.equal(edaStatus(3), undefined);
  assert.equal(edaStatus(11), undefined);
});

test('EDA mode coils are the unit modes, without the stop coil', () => {
  // Away, long away, overpressure, max heating, max cooling, manual boost;
  // not stop (coil 0), which is not a mode.
  assert.deepEqual(EDA_MODE_COILS, [3, 10, 1, 2, 6, 7]);
  assert.ok(!EDA_MODE_COILS.includes(0));
});

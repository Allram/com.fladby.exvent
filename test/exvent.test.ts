import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MODE_BITS, controllerOutputs, exventStatus, exventStatusMode,
} from '../lib/exvent';
import { alarmOn, alarmText } from '../lib/alarms';
import { inRange, isValidHost, isValidPort } from '../lib/settings';

test('eWind/eAir mode bits map to status modes, whatever else is set', () => {
  const cases: Array<[number, number | undefined, string]> = [
    [0, 2, '0'],
    [0, 3, '5'], // Home at panel fan level 3 is enhanced ventilation
    [MODE_BITS.AWAY, 1, '1'],
    [MODE_BITS.LONG_AWAY, 1, '1'],
    [MODE_BITS.OVERPRESSURE, 2, '2'],
    [MODE_BITS.MANUAL_BOOST, 4, '3'],
    [MODE_BITS.STOP, 2, '4'],
    [MODE_BITS.ALARM_A, 2, '4'], // stopped by an A alarm
    [MODE_BITS.STOP | 8192, 2, '4'],
    [MODE_BITS.CO2_BOOST, 2, '5'],
    [MODE_BITS.RH_BOOST, 2, '5'],
    [MODE_BITS.TEMPERATURE_BOOST, 2, '5'],
    [MODE_BITS.AWAY | 2048, 1, '1'], // away while the cooker hood runs
    [MODE_BITS.MANUAL_BOOST | MODE_BITS.CO2_BOOST, 4, '3'],
    [MODE_BITS.OVERPRESSURE | MODE_BITS.CO2_BOOST, 2, '2'],
    [MODE_BITS.AWAY | MODE_BITS.CO2_BOOST, 1, '1'],
    [32768, 2, '0'], // defrosting
    [16384, 2, '0'], // summer night cooling
    [-31744, 2, '2'], // 32768 | 1024 read as signed
  ];
  for (const [state, level, mode] of cases) assert.equal(exventStatusMode(state, level), mode, `HREG 44 = ${state}`);
});

test('the status is the step in bits 0-3', () => {
  assert.deepEqual([0, 1, 2, 4, 6, 7, 8].map(exventStatus), ['0', '1', '2', '3', '6', '4', '5']);
  assert.equal(exventStatus(2 | 4096), '2');
  assert.equal(exventStatus(4 | 16384), '3');
  assert.equal(exventStatus(5), undefined);
});

test('the controller output splits into heat recovery and after-heating', () => {
  assert.deepEqual(controllerOutputs(-40), { heatRecovery: 0, afterHeating: 0 });
  assert.deepEqual(controllerOutputs(0), { heatRecovery: 0, afterHeating: 0 });
  assert.deepEqual(controllerOutputs(55), { heatRecovery: 55, afterHeating: 0 });
  assert.deepEqual(controllerOutputs(130), { heatRecovery: 100, afterHeating: 30 });
  assert.deepEqual(controllerOutputs(250), { heatRecovery: 100, afterHeating: 100 });
});

test('alarm texts', () => {
  assert.equal(alarmText(16, 'no'), 'Tilluftsfilter tett');
  assert.equal(alarmText(16, 'en'), 'Supply air filter dirty');
  assert.equal(alarmText(13, 'no'), 'Ekstern alarm');
  assert.equal(alarmText(13, 'no', true), 'Brannfare');
  assert.equal(alarmText(99, 'no'), 'Alarm 99');
  assert.equal(alarmOn(2), true);
  assert.equal(alarmOn(0x0201), false);
  assert.equal(alarmOn(0x0202), true);
});

test('addresses and ports', () => {
  for (const host of ['192.168.3.59', ' 10.0.0.1 ', 'exvent.local', 'unit-1']) assert.ok(isValidHost(host), host);
  for (const host of ['192.168.003.059', '256.1.1.1', '1.2.3', '192.168.3.59:502', '', '-bad', 5]) assert.ok(!isValidHost(host), String(host));
  for (const port of [1, 502, '502', 65535]) assert.ok(isValidPort(port), String(port));
  for (const port of [0, 65536, 2.5, '', 'x', null]) assert.ok(!isValidPort(port), String(port));
  assert.equal(inRange('30', [1, 60]), 30);
  assert.equal(inRange(61, [1, 60]), undefined);
});

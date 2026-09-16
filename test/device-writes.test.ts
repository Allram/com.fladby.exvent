import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DeviceOptions, FakeUnit, cleanupDevices, createDevice, readJson, settle,
} from './device-harness';

afterEach(cleanupDevices);

const EDA_HREG = {
  6: 52, 7: 160, 8: 190, 9: 70, 10: 215, 13: 38, 29: 81, 30: 79, 44: 0, 45: 2, 50: 50, 53: 50, 57: 10, 135: 210, 164: 160, 196: 250, 538: 180,
};
const EDA_COILS = {
  16: true, 30: true, 49: true, 52: true, 54: true,
};

/** Default values of a driver's settings, as a newly paired device has them. */
function defaultSettings(driver: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const group of readJson(`drivers/${driver}/driver.compose.json`).settings) {
    for (const setting of group.children) settings[setting.id] = setting.value;
  }
  return settings;
}

/** An initialised device of the driver on a unit, with the writes, events and triggers of the start cleared. */
async function startDevice(driver: 'eda' | 'eWind' | 'eAir', unit: FakeUnit, options: DeviceOptions = {}) {
  const device = createDevice(driver, unit, { ...options, settings: { ...defaultSettings(driver), ...options.settings } });
  await device.onInit();
  await settle(device);
  unit.writes.length = 0;
  device.events.length = 0;
  device.triggers.length = 0;
  return device;
}

function capabilityEvents(device: any): string[] {
  return device.events.filter((event: string) => /Capability|StoreValue/.test(event));
}

function coilWrites(unitId: number, code: string, coils: Array<[number, number]>): string[] {
  return coils.map(([coil, value]) => `${code} unit ${unitId} coil ${coil}=${value}`);
}

test('EDA mode writes turn the other mode coils off', async () => {
  const expected: Record<string, Array<[number, number]>> = {
    0: [[0, 0], [3, 0], [10, 0], [1, 0], [2, 0], [6, 0], [7, 0]],
    1: [[0, 0], [1, 1], [3, 0], [10, 0], [2, 0], [6, 0], [7, 0]],
    2: [[0, 0], [3, 1], [10, 0], [1, 0], [2, 0], [6, 0], [7, 0]],
    3: [[0, 0], [10, 1], [3, 0], [1, 0], [2, 0], [6, 0], [7, 0]],
    4: [[0, 1]],
  };
  for (const [mode, coils] of Object.entries(expected)) {
    const unit = new FakeUnit(EDA_HREG, EDA_COILS);
    const device = await startDevice('eda', unit);
    await device.listeners['edastatus_mode'](mode);
    await settle(device);
    assert.deepEqual(unit.writes, coilWrites(1, 'FC15', coils), `mode ${mode}`);
    assert.equal(device.getCapabilityValue('edastatus_mode'), mode);
    assert.deepEqual(device.triggers, [`edastatus_mode_changed {"mode":"${mode}"}`]);
  }
});

test('EDA Home ends a long away set on the panel', async () => {
  const unit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 2: true });
  unit.deriveState = true;
  const device = await startDevice('eda', unit);
  assert.equal(device.getCapabilityValue('edastatus_mode'), '1');
  await device.listeners['edastatus_mode']('0');
  await settle(device);
  await device.pollDevice();
  assert.equal(unit.coils.get(2), false);
  assert.equal(device.getCapabilityValue('edastatus_mode'), '0');
});

test('EDA Away and Boost end overpressure', async () => {
  for (const mode of ['1', '3']) {
    const unit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 3: true });
    unit.deriveState = true;
    const device = await startDevice('eda', unit);
    assert.equal(device.getCapabilityValue('edastatus_mode'), '2');
    await device.listeners['edastatus_mode'](mode);
    await settle(device);
    await device.pollDevice();
    assert.equal(unit.coils.get(3), false);
    assert.equal(device.getCapabilityValue('edastatus_mode'), mode);
    assert.equal(device.getCapabilityValue('overpressure'), false);
  }
});

test('EDA overpressure quick action off only ends overpressure', async () => {
  // Stopped with overpressure still set: the unit stays stopped.
  let unit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 0: true, 3: true });
  unit.deriveState = true;
  let device = await startDevice('eda', unit);
  assert.equal(device.getCapabilityValue('edastatus_mode'), '4');
  assert.equal(device.getCapabilityValue('overpressure'), true);
  await device.listeners['overpressure'](false);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC15 unit 1 coil 3=0']);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('edastatus_mode'), '4');
  assert.equal(device.getCapabilityValue('overpressure'), false);
  assert.deepEqual(device.triggers, []);

  // Overpressure during away: away stays on, and the poll reports it.
  unit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 1: true, 3: true });
  unit.deriveState = true;
  device = await startDevice('eda', unit);
  assert.equal(device.getCapabilityValue('edastatus_mode'), '2');
  await device.listeners['overpressure'](false);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC15 unit 1 coil 3=0']);
  assert.deepEqual(device.triggers, []);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('edastatus_mode'), '1');
  assert.deepEqual(device.triggers, ['edastatus_mode_changed {"mode":"1"}']);
});

test('EDA overpressure quick action on starts overpressure like the mode picker', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  unit.deriveState = true;
  const device = await startDevice('eda', unit);
  await device.listeners['overpressure'](true);
  await settle(device);
  assert.deepEqual(unit.writes, coilWrites(1, 'FC15', [[0, 0], [3, 1], [10, 0], [1, 0], [2, 0], [6, 0], [7, 0]]));
  assert.deepEqual(device.triggers, ['edastatus_mode_changed {"mode":"2"}']);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('edastatus_mode'), '2');
  assert.deepEqual(device.triggers, ['edastatus_mode_changed {"mode":"2"}']);
});

test('EDA overpressure quick action off reports the mode change right after turning it on', async () => {
  // On and then off again from Homey, well within the echo window of the
  // mode write: the poll after the off write still fires the mode trigger.
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  unit.deriveState = true;
  const device = await startDevice('eda', unit);
  await device.listeners['overpressure'](true);
  await settle(device);
  await device.pollDevice();
  device.triggers.length = 0;
  await device.listeners['overpressure'](false);
  await settle(device);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('edastatus_mode'), '0');
  assert.deepEqual(device.triggers, ['edastatus_mode_changed {"mode":"0"}']);
});

test('EDA heating picker keeps the heating allowed setting in step', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  unit.deriveState = true;
  const device = await startDevice('eda', unit);
  await device.onSettings({ newSettings: { ...device.settings, heating_allowed: false }, changedKeys: ['heating_allowed'] });
  device.settings.heating_allowed = false;
  await settle(device);
  await device.listeners['heating_allowed']('1');
  await settle(device);
  await device.pollDevice();
  assert.equal(unit.coils.get(54), true);
  assert.equal(device.settings.heating_allowed, true);
});

test('EDA fan level calls made before the fan type is known keep their order', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = createDevice('eda', unit, { settings: defaultSettings('eda') });
  await Promise.all([device.setFanLevel(30), device.setFanLevel(40), device.setFanLevel(60)]);
  await settle(device);
  assert.deepEqual(unit.writes.filter((write) => write.includes('hreg 53')), [
    'FC16 unit 1 hreg 53=30', 'FC16 unit 1 hreg 53=40', 'FC16 unit 1 hreg 53=60',
  ]);
});

test('EDA units with AC fans lose the fan level slider once', async () => {
  const unit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 16: false });
  const paired = createDevice('eda', unit, { settings: defaultSettings('eda') });
  await paired.onInit();
  assert.deepEqual(capabilityEvents(paired), ['setStoreValue ec_fans=false', 'removeCapability fanspeed_level_set']);

  const restarted = createDevice('eda', unit, {
    capabilities: paired.capabilities, store: paired.store, values: paired.values, settings: paired.settings,
  });
  await restarted.onInit();
  assert.deepEqual(capabilityEvents(restarted), []);
  assert.equal('fanspeed_level_set' in restarted.listeners, false);
});

test('EDA units with EC fans keep the fan level slider', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = createDevice('eda', unit, { settings: defaultSettings('eda') });
  await device.onInit();
  assert.deepEqual(capabilityEvents(device), ['setStoreValue ec_fans=true']);
  assert.equal(typeof device.listeners['fanspeed_level_set'], 'function');
  assert.equal(device.getCapabilityValue('fanspeed_level_set'), 0.5);

  // Stored as AC, but the unit now reports EC fans: the slider comes back.
  const swapped = createDevice('eda', unit, {
    capabilities: device.capabilities.filter((id: string) => id !== 'fanspeed_level_set'),
    store: { ec_fans: false },
    settings: defaultSettings('eda'),
  });
  await swapped.onInit();
  assert.ok(swapped.events.includes('addCapability fanspeed_level_set'));
  assert.equal(typeof swapped.listeners['fanspeed_level_set'], 'function');
  assert.equal(swapped.store.ec_fans, true);
});

test('EDA set fan level card is offered only on devices with the slider', () => {
  const card = readJson('app.json').flow.actions.find((action: any) => action.id === 'set-fan-level_eda');
  assert.equal(card.args[0].type, 'device');
  assert.equal(card.args[0].filter, 'driver_id=eda&capabilities=fanspeed_level_set');
});

test('EDA fan level can be set before the first poll', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = createDevice('eda', unit, { settings: defaultSettings('eda') });
  assert.equal(await device.setFanLevel(40), 40);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC16 unit 1 hreg 53=40']);
  assert.equal(device.store.ec_fans, true);

  const acUnit = new FakeUnit(EDA_HREG, { ...EDA_COILS, 16: false });
  const acDevice = createDevice('eda', acUnit, { settings: defaultSettings('eda') });
  await assert.rejects(acDevice.setFanLevel(40), { message: 'fanLevelUnsupported' });
  assert.deepEqual(acUnit.writes, []);
});

test('EDA fan level on an unreachable unit gives a connection error', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  unit.reachable = false;
  const device = createDevice('eda', unit, { settings: defaultSettings('eda') });
  await assert.rejects(device.setFanLevel(40), { message: 'noConnection' });

  // A known fan type needs no reading.
  const known = createDevice('eda', unit, { settings: defaultSettings('eda'), store: { ec_fans: false } });
  await assert.rejects(known.setFanLevel(40), { message: 'fanLevelUnsupported' });
});

test('EDA fan level is kept within 20-100% and must be a number', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = await startDevice('eda', unit);
  for (const [level, written] of [[5, 20], [150, 100], [57.4, 57], [NaN, undefined], [null, undefined], ['', undefined]]) {
    assert.equal(await device.setFanLevel(level), written, `level ${level}`);
  }
  await settle(device);
  assert.deepEqual(unit.writes, ['FC16 unit 1 hreg 53=20', 'FC16 unit 1 hreg 53=100', 'FC16 unit 1 hreg 53=57']);
});

test('EDA status follows every temperature control step', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = await startDevice('eda', unit);
  const steps: Array<[number, string]> = [[0, '0'], [1, '1'], [2, '2'], [4, '3'], [5, '6'], [6, '7'], [7, '4'], [8, '5'], [9, '8'], [10, '9']];
  const values = readJson('.homeycompose/capabilities/edastatus.json').values.map((value: any) => value.id);
  for (const [step, status] of steps) {
    unit.hreg.set(45, step);
    await device.pollDevice();
    assert.equal(device.getCapabilityValue('edastatus'), status, `HREG 45 = ${step}`);
    assert.ok(values.includes(status));
  }
  unit.hreg.set(45, 3);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('edastatus'), '9', 'a value the register list does not name keeps the last status');
});

/** Setting id, register or coil and scale of the EDA settings mirrored from the unit. */
const EDA_NUMBER_SETTINGS: Array<[string, number, number]> = [
  ['heating_block_temperature', 196, 10],
  ['cooling_block_temperature', 164, 10],
  ['fireplace_duration_minutes', 57, 1],
  ['filter_interval_days', 538, 1],
];

function composeSetting(driver: string, id: string): any {
  for (const group of readJson(`drivers/${driver}/driver.compose.json`).settings) {
    const setting = group.children.find((child: any) => child.id === id);
    if (setting) return setting;
  }
  return undefined;
}

test('EDA mirrors only unit values within the settings range', async () => {
  for (const [id, register, scale] of EDA_NUMBER_SETTINGS) {
    const { min, max } = composeSetting('eda', id);
    for (const [value, mirrored] of [[min - 1 / scale, false], [max + 1 / scale, false], [min, true], [max, true]]) {
      const unit = new FakeUnit(EDA_HREG, EDA_COILS);
      const device = await startDevice('eda', unit);
      device.settings[id] = (min + max) / 2;
      unit.hreg.set(register, Math.round(Number(value) * scale) & 0xffff);
      await device.pollDevice();
      assert.equal(device.settings[id], mirrored ? value : (min + max) / 2, `${id} = ${value}`);
    }
  }
});

test('EDA mirrored settings wait for their own writes', async (t) => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = await startDevice('eda', unit);
  const changed = {
    heating_allowed: false, cooling_allowed: false, heating_block_temperature: 18, cooling_block_temperature: 20, fireplace_duration_minutes: 15, filter_interval_days: 90,
  };
  // The writes have not reached the unit when the next poll reads it.
  unit.applyWrites = false;
  await device.onSettings({ oldSettings: { ...device.settings }, newSettings: { ...device.settings, ...changed }, changedKeys: Object.keys(changed) });
  Object.assign(device.settings, changed);
  await device.pollDevice();
  assert.deepEqual(device.events.filter((event: string) => event.startsWith('setSettings')), []);
  for (const [id, value] of Object.entries(changed)) assert.equal(device.settings[id], value, id);

  // A change made on the panel to a setting Homey did not write still shows.
  unit.coils.set(49, false);
  await device.pollDevice();
  assert.deepEqual(device.events.filter((event: string) => event.startsWith('setSettings')), ['setSettings {"service_reminder":false}']);

  // A write that never arrives: after the settle time the unit's value shows again.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 31 * 1000);
  device.events.length = 0;
  await device.pollDevice();
  const unitValues = {
    heating_allowed: true, cooling_allowed: true, heating_block_temperature: 25, cooling_block_temperature: 16, fireplace_duration_minutes: 10, filter_interval_days: 180,
  };
  for (const [id, value] of Object.entries(unitValues)) assert.equal(device.settings[id], value, id);
});

test('EDA mirrored settings follow writes that arrived', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = await startDevice('eda', unit);
  const changed = { heating_block_temperature: -5, cooling_block_temperature: 17.5, fireplace_duration_minutes: 15 };
  await device.onSettings({ oldSettings: { ...device.settings }, newSettings: { ...device.settings, ...changed }, changedKeys: Object.keys(changed) });
  Object.assign(device.settings, changed);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC16 unit 1 hreg 57=15', 'FC16 unit 1 hreg 196=65486', 'FC16 unit 1 hreg 164=175']);
  await device.pollDevice();
  assert.deepEqual(device.events.filter((event: string) => event.startsWith('setSettings')), []);
  assert.equal(device.settings.heating_block_temperature, -5);
});

test('EDA writes skip values outside the settings range', async () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  const device = await startDevice('eda', unit);
  for (const value of [25.5, -5.5, NaN, null, '', 'warm']) {
    await device.onSettings({ newSettings: { ...device.settings, heating_block_temperature: value }, changedKeys: ['heating_block_temperature'] });
  }
  for (const value of [4.5, 40.5]) {
    await device.onSettings({ newSettings: { ...device.settings, cooling_block_temperature: value }, changedKeys: ['cooling_block_temperature'] });
  }
  const card = (id: string) => device.cards.get(id).listener;
  await card('set-heating-block-temperature_eda')({ device, temperature: 26 });
  await card('set-cooling-block-temperature_eda')({ device, temperature: 4 });
  for (const minutes of [0, 61, 2.5, NaN]) await card('set-overpressure-duration_eda')({ device, minutes });
  await settle(device);
  assert.deepEqual(unit.writes, []);
  assert.deepEqual(device.events, []);

  await card('set-heating-block-temperature_eda')({ device, temperature: 25 });
  await card('set-cooling-block-temperature_eda')({ device, temperature: 5 });
  await card('set-overpressure-duration_eda')({ device, minutes: 60 });
  await settle(device);
  assert.deepEqual(unit.writes, ['FC16 unit 1 hreg 196=250', 'FC16 unit 1 hreg 164=50', 'FC16 unit 1 hreg 57=60']);
  assert.deepEqual(device.events, [
    'setSettings {"heating_block_temperature":25}', 'setSettings {"cooling_block_temperature":5}', 'setSettings {"fireplace_duration_minutes":60}',
  ]);
});

test('EDA unit ID setting falls back to 1', () => {
  const unit = new FakeUnit(EDA_HREG, EDA_COILS);
  for (const [setting, id] of [[undefined, 1], [1, 1], [7, 7], ['3', 3], [0, 1], [256, 1], [2.5, 1], ['x', 1]]) {
    const device = createDevice('eda', unit, { settings: { unit_id: setting } });
    assert.equal(device.modbusOptions.unitId, id, `unit_id ${setting}`);
  }
});

// Written on main (4.10.1) by the same calls; eWind and eAir must not change.
const EWIND_EAIR_WRITES = [
  // Mode 0 (Home) to 5 (Enhanced ventilation)
  'FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 1=0', 'FC5 unit 255 coil 3=0', 'FC5 unit 255 coil 10=0', 'FC6 unit 255 hreg 50=2',
  'FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 10=0', 'FC5 unit 255 coil 1=1',
  'FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 10=0', 'FC5 unit 255 coil 3=1',
  'FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 10=1',
  'FC5 unit 255 coil 0=1',
  'FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 1=0', 'FC5 unit 255 coil 3=0', 'FC5 unit 255 coil 10=0', 'FC6 unit 255 hreg 50=3',
  // Eco mode, heating coil, target temperature
  'FC5 unit 255 coil 40=1', 'FC5 unit 255 coil 54=0', 'FC6 unit 255 hreg 135=210',
  // Settings: filter interval, fireplace duration
  'FC6 unit 255 hreg 538=90', 'FC6 unit 255 hreg 56=20', 'FC6 unit 255 hreg 57=20',
  // Reset filter reminder
  'FC6 unit 255 hreg 710=0',
];

for (const driver of ['eWind', 'eAir'] as const) {
  test(`${driver} writes are unchanged`, async () => {
    const unit = new FakeUnit({
      44: 0, 45: 2, 50: 2, 56: 10, 57: 10, 135: 200, 538: 120, 710: 25,
    }, { 30: true, 54: true });
    const device = await startDevice(driver, unit);
    const statusMode = `${driver}status_mode`;
    for (const mode of ['0', '1', '2', '3', '4', '5']) {
      await device.listeners[statusMode](mode);
      await settle(device);
    }
    await device.listeners['ecomode_mode']('1');
    await device.listeners['heating_coil_state']('0');
    await device.listeners['target_temperature.step'](21);
    await device.onSettings({
      newSettings: { ...device.settings, filter_interval_days: 90, fireplace_duration_minutes: 20 },
      changedKeys: ['filter_interval_days', 'fireplace_duration_minutes'],
    });
    await device.cards.get(device.flowCardIds.resetFilterReminder).listener({ device });
    await settle(device);
    assert.deepEqual(unit.writes, EWIND_EAIR_WRITES);
    assert.deepEqual(device.triggers, ['0', '1', '2', '3', '4', '5'].map((mode) => `${device.flowCardIds.statusModeChanged} {"mode":"${mode}"}`));
  });

  test(`${driver} status and mirrored settings are unchanged`, async () => {
    const unit = new FakeUnit({
      44: 0, 45: 8, 50: 2, 56: 10, 57: 10, 135: 200, 538: 120, 710: 25,
    }, { 30: true, 54: true });
    const device = await startDevice(driver, unit);
    const status = `${driver}status`;
    assert.equal(device.getCapabilityValue(status), '5');
    for (const step of [5, 6, 9, 10]) {
      unit.hreg.set(45, step);
      await device.pollDevice();
      assert.equal(device.getCapabilityValue(status), '5', `HREG 45 = ${step} is not mapped on ${driver}`);
    }
    // Fireplace duration is mirrored within 1-60; the filter interval from 1 up.
    unit.hreg.set(56, 61);
    unit.hreg.set(538, 400);
    await device.pollDevice();
    assert.deepEqual(device.events.filter((event: string) => event.startsWith('setSettings')), ['setSettings {"filter_interval_days":400}']);
    unit.hreg.set(56, 30);
    await device.pollDevice();
    assert.equal(device.settings.fireplace_duration_minutes, 30);
  });
}

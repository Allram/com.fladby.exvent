import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DriverName, FakeUnit, cleanupDevices, createDevice, defaultSettings, settle, sockets, startDevice,
} from './device-harness';

afterEach(cleanupDevices);

/** An eWind or eAir unit at home, heat recovery on, 12.3 °C outside. */
const MD_HREG = {
  3: 45, 4: 47, 6: 123, 7: 145, 8: 146, 9: 212, 10: 230, 13: 48, 29: 24, 30: 19, 44: 0, 45: 2, 49: 40, 50: 2,
  56: 60, 57: 60, 66: 120, 134: 110, 135: 150, 137: 120, 385: 0, 386: 0, 538: 180, 710: 63,
};
const MD_COILS = { 30: true, 49: true, 54: true };

function mdUnit(hreg: Record<number, number> = {}, coils: Record<number, boolean> = {}) {
  return new FakeUnit({ ...MD_HREG, ...hreg }, { ...MD_COILS, ...coils });
}

const card = (device: any, id: string) => device.flowCards.get(id).listener;

// ---------------------------------------------------------------- connection

test('a new address is used at once, even while the old one never answers', async () => {
  const old = mdUnit();
  old.silent = true;
  const device = createDevice('eWind', old, { settings: defaultSettings('eWind') });
  device.connectSocket();
  const fresh = mdUnit();
  await device.onSettings({ newSettings: { ...device.settings, address: fresh.address }, changedKeys: ['address'] });
  device.settings.address = fresh.address;
  await settle(device);
  assert.equal(device.getCapabilityValue('measure_temperature.outsideAir'), 12.3);
  await device.changeMode('1');
  assert.ok(fresh.writes.includes('FC5 unit 255 coil 1=1'));
  assert.deepEqual(old.writes, []);
});

test('callers waiting for a connection share one attempt', async () => {
  const unit = mdUnit();
  const device = createDevice('eWind', unit, { settings: defaultSettings('eWind') });
  const before = sockets.length;
  device.connectSocket();
  await Promise.all([device.ensureConnected(), device.ensureConnected()]);
  assert.equal(sockets.length - before, 1);
});

test('a write that waited on a torn-down attempt gets through on the next connection', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  device.teardownSocket();
  unit.silent = true;
  device.connectSocket();
  const write = device.sendCoilRequest(40, true);
  await new Promise((resolve) => setImmediate(resolve));
  // A poll that gave up tears the hanging attempt down.
  device.teardownSocket();
  unit.silent = false;
  await write;
  assert.deepEqual(unit.writes, ['FC5 unit 255 coil 40=1']);
});

test('a connection attempt that gets no answer is given up after 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unit = mdUnit();
  unit.silent = true;
  const device = createDevice('eWind', unit, { settings: defaultSettings('eWind') });
  const attempt = device.ensureConnected();
  t.mock.timers.tick(10000);
  await assert.rejects(attempt, /Connect timeout/);
});

test('after the unit drops the connection the next poll reconnects', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  sockets[sockets.length - 1].drop();
  await settle(device);
  unit.hreg.set(6, 99);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('measure_temperature.outsideAir'), 9.9);
  assert.equal(device.warning, null);
  assert.ok(device.logLines.some((line: string) => line.startsWith('Connection to')));
});

test('the device shows a warning after three failed polls and clears it again', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  const lastPoll = device.getCapabilityValue('lastPollTime');
  unit.reachable = false;
  sockets[sockets.length - 1].drop();
  await settle(device);
  await device.pollDevice();
  await device.pollDevice();
  assert.equal(device.warning, null);
  await device.pollDevice();
  assert.equal(device.warning, 'noConnectionWarning');
  assert.equal(device.getCapabilityValue('lastPollTime'), lastPoll, 'the time of the last good poll stays');
  unit.reachable = true;
  await device.pollDevice();
  assert.equal(device.warning, null);
});

// -------------------------------------------------------------- write queue

test('a write that times out is sent again', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  unit.failWrites.set('coil 40', ['Timeout']);
  await device.setEcoMode('1');
  assert.deepEqual(unit.writes, ['FC5 unit 255 coil 40=1']);
  assert.equal(device.getCapabilityValue('ecomode_mode'), '1');
});

test('a refused mode write is not sent again, and the card fails and puts the mode back', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  unit.failWrites.set('coil 1', ['ModbusException']);
  await assert.rejects(card(device, 'status-mode')({ device, mode: '1' }), { message: 'writeFailed' });
  await settle(device);
  assert.deepEqual(unit.writes, ['FC5 unit 255 coil 0=0'], 'the steps after the failed one are skipped');
  assert.equal(device.getCapabilityValue('eWindstatus_mode'), '0');
  assert.deepEqual(device.triggers, []);
  assert.equal(device.warning, 'writeFailedWarning');
});

test('the mode card fails when the unit cannot be reached', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  unit.reachable = false;
  sockets[sockets.length - 1].drop();
  await settle(device);
  await assert.rejects(card(device, 'status-mode')({ device, mode: '3' }), { message: 'writeFailed' });
  assert.deepEqual(device.triggers, []);
});

test('a card on a removed device fails', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  device.cleanup();
  await assert.rejects(card(device, 'status-mode')({ device, mode: '3' }), { message: 'noConnection' });
});

// -------------------------------------------------------------------- modes

for (const driver of ['eWind', 'eAir'] as const) {
  const statusMode = `${driver}status_mode`;
  const modeChanged = driver === 'eWind' ? 'eWindstatus_mode_changed' : 'eAirstatus_mode_changed2';
  const statusModeCard = driver === 'eWind' ? 'status-mode' : 'status-mode_eAir';

  test(`${driver}: the mode card fires Mode changed once, and not for the mode already set`, async () => {
    const unit = mdUnit();
    const device = await startDevice(driver, unit);
    await card(device, statusModeCard)({ device, mode: '1' });
    assert.deepEqual(device.triggers, [`${modeChanged} {"mode":"1"}`]);
    assert.equal(device.triggerTokens[0].mode, 'Away');
    device.triggers.length = 0;
    await card(device, statusModeCard)({ device, mode: '1' });
    assert.deepEqual(device.triggers, []);
  });

  test(`${driver}: a stop from the panel shows as Off and fires Mode changed`, async () => {
    const unit = mdUnit();
    const device = await startDevice(driver, unit);
    unit.hreg.set(44, 8);
    await device.pollDevice();
    assert.equal(device.getCapabilityValue(statusMode), '4');
    assert.deepEqual(device.triggers, [`${modeChanged} {"mode":"4"}`]);
  });

  test(`${driver}: away, fireplace and boost turn each other off`, async () => {
    for (const [mode, lingering] of [['1', 3], ['2', 1], ['3', 1], ['3', 3]] as const) {
      const unit = mdUnit({}, { [lingering]: true });
      unit.deriveState = true;
      const device = await startDevice(driver, unit);
      await device.listeners[statusMode](mode);
      await settle(device);
      await device.pollDevice();
      assert.equal(unit.coils.get(lingering), false, `mode ${mode} leaves coil ${lingering}`);
      assert.equal(device.getCapabilityValue(statusMode), mode);
    }
  });

  test(`${driver}: a panel change right after a write from Homey fires Mode changed`, async () => {
    const unit = mdUnit();
    const device = await startDevice(driver, unit);
    await card(device, statusModeCard)({ device, mode: '5' });
    await device.pollDevice();
    assert.equal(device.getCapabilityValue(statusMode), '5');
    device.triggers.length = 0;
    unit.hreg.set(44, 1024);
    await device.pollDevice();
    assert.deepEqual(device.triggers, [`${modeChanged} {"mode":"2"}`]);
  });

  test(`${driver}: a reading of the old mode right after a write counts as stale`, async () => {
    const unit = mdUnit();
    const device = await startDevice(driver, unit);
    unit.applyWrites = false;
    await card(device, statusModeCard)({ device, mode: '3' });
    device.triggers.length = 0;
    await device.pollDevice();
    assert.equal(device.getCapabilityValue(statusMode), '3');
    assert.deepEqual(device.triggers, []);
  });
}

test('eAir Home ends a long away set on the panel; eWind leaves coil 2 alone', async () => {
  const eAirUnit = mdUnit({}, { 2: true });
  eAirUnit.deriveState = true;
  const eAir = await startDevice('eAir', eAirUnit);
  assert.equal(eAir.getCapabilityValue('eAirstatus_mode'), '1');
  await eAir.listeners['eAirstatus_mode']('0');
  await settle(eAir);
  await eAir.pollDevice();
  assert.equal(eAirUnit.coils.get(2), false);
  assert.equal(eAir.getCapabilityValue('eAirstatus_mode'), '0');

  const eWindUnit = mdUnit();
  const eWind = await startDevice('eWind', eWindUnit);
  await eWind.listeners['eWindstatus_mode']('0');
  await settle(eWind);
  assert.ok(!eWindUnit.writes.some((write) => write.includes('coil 2=')));
});

test('EDA has no enhanced ventilation: the mode is refused before anything is written', async () => {
  const unit = new FakeUnit({ 44: 0, 45: 2, 50: 50, 53: 50 }, { 16: true });
  const device = await startDevice('eda', unit);
  await assert.rejects(device.setStatusModeValue('5'), { message: 'modeNotSupported' });
  assert.deepEqual(unit.writes, []);
});

test('Mode changed with any mode, named ids from before 4.0.1 and the mode token', async () => {
  const unit = mdUnit();
  const eWind = await startDevice('eWind', unit);
  const trigger = card(eWind, 'eWindstatus_mode_changed');
  assert.equal(await trigger({ mode_title: 'any' }, { mode: '3' }), true);
  assert.equal(await trigger({ mode_title: '3' }, { mode: '3' }), true);
  assert.equal(await trigger({ mode_title: '0' }, { mode: '3' }), false);
  const condition = card(eWind, 'eWindstatus_mode_is');
  assert.equal(await condition({ device: eWind, mode: 'home' }), true);
  assert.equal(await condition({ device: eWind, mode: '0' }), true);
  const eAir = await startDevice('eAir', mdUnit());
  assert.equal(await card(eAir, 'eAirstatus_mode_changed2')({ mode_title: 'any' }, { mode: '0' }), true);
  assert.equal(await card(eAir, 'eAirstatus_mode_is2')({ device: eAir, mode: 'home' }), true);
});

test('the boost quick action starts and ends boost', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  await device.listeners['boost'](true);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC5 unit 255 coil 0=0', 'FC5 unit 255 coil 10=1', 'FC5 unit 255 coil 1=0', 'FC5 unit 255 coil 3=0']);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('boost'), true);
  unit.writes.length = 0;
  await device.listeners['boost'](false);
  await settle(device);
  assert.deepEqual(unit.writes, ['FC5 unit 255 coil 10=0']);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('eWindstatus_mode'), '0');
  assert.equal(device.getCapabilityValue('boost'), false);
});

test('start boost for a number of minutes writes the duration only when it changes', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  await card(device, 'start-boost')({ device, minutes: 30 });
  assert.deepEqual(unit.writes.slice(0, 2), ['FC6 unit 255 hreg 66=30', 'FC5 unit 255 coil 0=0']);
  assert.equal(device.settings.boost_duration_minutes, 30);
  unit.writes.length = 0;
  await card(device, 'start-boost')({ device, minutes: 30 });
  assert.ok(!unit.writes.some((write: string) => write.includes('hreg 66')));
  await assert.rejects(card(device, 'start-fireplace')({ device, minutes: 61 }), { message: 'invalidDuration' });
});

test('the mode is logged in Insights', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  await device.changeMode('1');
  unit.hreg.set(44, 1024);
  device.pendingMode = null;
  await device.pollDevice();
  assert.deepEqual(device.logs.get('modetest').entries, [1, 2]);
});

// ----------------------------------------------------------------- settings

test('a setting that does not reach the unit is refused', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  unit.failWrites.set('hreg 538', ['ModbusException']);
  await assert.rejects(device.onSettings({
    newSettings: { ...device.settings, filter_interval_days: 90 }, changedKeys: ['filter_interval_days'],
  }), { message: 'settingsWriteFailed' });
});

test('a new address is saved even when the settings could not be written to it', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  const gone = mdUnit();
  gone.reachable = false;
  const message = await device.onSettings({
    newSettings: { ...device.settings, address: gone.address, filter_interval_days: 90 }, changedKeys: ['address', 'filter_interval_days'],
  });
  assert.equal(message, 'settingsWriteFailedAddressSaved');
});

test('a new address and a setting in the same save both go to the new unit', async () => {
  const old = mdUnit();
  const device = await startDevice('eWind', old);
  const fresh = mdUnit();
  await device.onSettings({
    newSettings: { ...device.settings, address: fresh.address, filter_interval_days: 90 }, changedKeys: ['address', 'filter_interval_days'],
  });
  assert.deepEqual(fresh.writes, ['FC6 unit 255 hreg 538=90']);
  assert.deepEqual(old.writes, []);
});

test('invalid addresses, ports and numbers are refused with a message', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  const save = (changed: Record<string, unknown>) => device.onSettings({ newSettings: { ...device.settings, ...changed }, changedKeys: Object.keys(changed) });
  await assert.rejects(save({ address: '192.168.003.059' }), { message: 'settings.invalidAddress' });
  await assert.rejects(save({ port: 0 }), { message: 'settings.invalidPort' });
  await assert.rejects(save({ fireplace_duration_minutes: 2.5 }), { message: 'settings.invalidNumber' });
  await assert.rejects(save({ boost_duration_minutes: 501 }), { message: 'settings.invalidNumber' });
  assert.deepEqual(unit.writes, []);
  const named = mdUnit();
  await save({ address: named.address });
  assert.equal(device.modbusOptions.host, named.address);
});

test('a setting is not mirrored back while its write is on the way', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  const write = device.sendHoldingRequest(538, 90, { setting: 'filter_interval_days' });
  assert.equal(device.mayMirrorSetting('filter_interval_days', 180), false);
  const seq = device.settingWriteSeq;
  await write;
  assert.equal(device.mayMirrorSetting('filter_interval_days', 90), true);
  assert.equal(device.mayMirrorSetting('filter_interval_days', 180, seq), false, 'a poll that started before the write finished');
});

test('boost duration is mirrored from the unit on eWind', async () => {
  const unit = mdUnit({ 66: 45 });
  const device = await startDevice('eWind', unit);
  assert.equal(device.settings.boost_duration_minutes, 45);
  await device.onSettings({ newSettings: { ...device.settings, boost_duration_minutes: 90 }, changedKeys: ['boost_duration_minutes'] });
  assert.deepEqual(unit.writes, ['FC6 unit 255 hreg 66=90']);
});

// ------------------------------------------------------ alarms and readings

for (const driver of ['eWind', 'eAir', 'eda'] as DriverName[]) {
  test(`${driver}: an A alarm goes off with its text`, async () => {
    const unit = driver === 'eda'
      ? new FakeUnit({ 44: 0, 45: 2, 50: 50, 53: 50 }, { 16: true })
      : mdUnit();
    const device = await startDevice(driver, unit);
    unit.coils.set(41, true);
    unit.hreg.set(385, 13);
    unit.hreg.set(386, 2);
    await device.pollDevice();
    const text = driver === 'eda' ? 'Fire risk' : 'External alarm';
    assert.equal(device.getCapabilityValue('alarm_a'), true);
    assert.equal(device.getCapabilityValue('active_alarm'), text);
    const alarmCard = { eWind: 'alarm_a_triggered', eAir: 'alarm_a_triggered2', eda: 'alarm_a_triggered_eda' }[driver];
    assert.deepEqual(device.triggers, [`${alarmCard} {}`]);
    assert.equal(device.triggerTokens[0].alarm, text);
    unit.coils.set(41, false);
    unit.hreg.set(386, 1);
    await device.pollDevice();
    assert.equal(device.getCapabilityValue('active_alarm'), 'noAlarm');
  });
}

test('the filter countdown is empty while the service reminder is off, and its trigger fires on the way down', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  assert.equal(device.getCapabilityValue('filter_days_remaining'), 117);
  unit.hreg.set(710, 64);
  await device.pollDevice();
  assert.deepEqual(device.triggers, ['filter_days_below {"previous":117,"current":116}']);
  const below = card(device, 'filter_days_below');
  assert.equal(await below({ days: 117 }, { previous: 117, current: 116 }), true);
  assert.equal(await below({ days: 100 }, { previous: 117, current: 116 }), false);
  unit.coils.set(49, false);
  await device.pollDevice();
  assert.equal(device.getCapabilityValue('filter_days_remaining'), null);
});

test('the controller output, the season and the eAir fan speeds are shown', async () => {
  const unit = mdUnit({ 49: 130, 134: 180 });
  const eWind = await startDevice('eWind', unit);
  assert.equal(eWind.getCapabilityValue('heat_recovery_output'), 100);
  assert.equal(eWind.getCapabilityValue('after_heating_output'), 30);
  assert.equal(eWind.getCapabilityValue('season'), 'summer');
  assert.equal(eWind.hasCapability('fan_output.supply'), false);
  const eAir = await startDevice('eAir', mdUnit());
  assert.equal(eAir.getCapabilityValue('fan_output.supply'), 45);
  assert.equal(eAir.getCapabilityValue('fan_output.extract'), 47);
  assert.equal(eAir.getCapabilityValue('season'), 'winter');
});

test('the unit boosting on its own is a condition', async () => {
  const unit = mdUnit({ 44: 128 });
  const device = await startDevice('eWind', unit);
  assert.equal(await card(device, 'unit_boosting_is')({ device }), true);
  assert.equal(device.getCapabilityValue('eWindstatus_mode'), '5');
  unit.hreg.set(44, 0);
  await device.pollDevice();
  assert.equal(await card(device, 'unit_boosting_is')({ device }), false);
});

test('the reset filter button writes the counter', async () => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  await device.listeners['button.reset_filter'](true);
  assert.deepEqual(unit.writes, ['FC6 unit 255 hreg 710=0']);
});

test('EDA fan type falls back to the panel level, and AC fans show no percent', async () => {
  const unit = new FakeUnit({ 44: 0, 45: 2, 50: 3, 53: 3 }, {});
  unit.unreadable.add('coil 16');
  const device = await startDevice('eda', unit);
  assert.equal(device.store.ec_fans, false);
  assert.deepEqual(device.capabilityOptions.fanspeed_level.units, { en: '', no: '' });
  assert.equal(device.hasCapability('fanspeed_level_set'), false);
});

test('EDA target temperature goes in half degrees', async () => {
  const unit = new FakeUnit({ 44: 0, 45: 2, 50: 50, 53: 50, 135: 210 }, { 16: true });
  const device = await startDevice('eda', unit);
  await card(device, 'set-temperature_eda')({ device, temperature: 21.4 });
  assert.deepEqual(unit.writes, ['FC16 unit 1 hreg 135=215']);
  await assert.rejects(card(device, 'set-temperature_eda')({ device, temperature: 31 }), { message: 'invalidTemperature' });
});

// ----------------------------------------------------------------- pairing

test('pairing test: reachable, refused, duplicate and not answering', async (t) => {
  const unit = mdUnit();
  const device = await startDevice('eWind', unit);
  const { driver } = device;
  const other = mdUnit();
  assert.deepEqual(await driver.testConnection({ address: other.address, port: 502 }), { ok: true });
  assert.equal((await driver.testConnection({ address: unit.address, port: 502 })).code, 'duplicate');
  assert.equal((await driver.testConnection({ address: '1.2.3', port: 502 })).code, 'invalid');
  other.reachable = false;
  assert.equal((await driver.testConnection({ address: other.address, port: 502 })).code, 'refused');
  other.reachable = true;
  other.unreadable.add('hreg 44');
  assert.equal((await driver.testConnection({ address: other.address, port: 502 })).code, 'notExvent');
  const silent = mdUnit();
  silent.silent = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answer = driver.testConnection({ address: silent.address, port: 502 });
  t.mock.timers.tick(5000);
  assert.equal((await answer).code, 'timeout');
});

test('EDA pairing test tells an MD unit from an EDA unit', async () => {
  const eda = new FakeUnit({ 44: 0, 45: 2, 50: 50, 53: 50, 599: 210 }, { 16: true });
  const device = await startDevice('eda', eda);
  const md = new FakeUnit({ 599: 150 });
  assert.equal((await device.driver.testConnection({ address: md.address, port: 502 })).code, 'platform');
  const other = new FakeUnit({ 599: 205 });
  assert.deepEqual(await device.driver.testConnection({ address: other.address, port: 502 }), { ok: true });
});

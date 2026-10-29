"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTION_TIMEOUT_MS = void 0;
exports.withTimeout = withTimeout;
exports.registerFlowCards = registerFlowCards;
/** How long an action card waits for its writes before it reports a failure. */
exports.ACTION_TIMEOUT_MS = 25 * 1000;
/** Rejects with the error made by `timeoutError` when the promise has not settled in time. */
function withTimeout(promise, ms, timeoutError) {
    let timer;
    const timeout = new Promise((_, reject) => {
        // A plain timer: it is always cleared when the promise settles.
        // eslint-disable-next-line homey-app/global-timers
        timer = setTimeout(() => reject(timeoutError()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/**
 * Registers the run listeners of a driver's flow cards; called once from the
 * driver's onInit. Action and condition listeners get the device in
 * args.device. Trigger listeners do not: a device trigger card filters by
 * device itself and passes no device argument, so the argument maps come
 * from the driver's card definition instead.
 */
function registerFlowCards(homey, cards) {
    const { ids, statusModeArgMap, onOffArgMap } = cards;
    const action = (id, run) => {
        if (!id)
            return;
        homey.flow.getActionCard(id).registerRunListener(async (args) => {
            const device = args.device;
            if (!device.isUsable())
                throw new Error(homey.__('noConnection'));
            await withTimeout(run(device, args), exports.ACTION_TIMEOUT_MS, () => new Error(homey.__('writeTimeout')));
            return true;
        });
    };
    const condition = (id, check) => {
        if (!id)
            return;
        homey.flow.getConditionCard(id).registerRunListener(async (args) => check(args.device, args));
    };
    const trigger = (id, listener) => {
        if (!id)
            return;
        homey.flow.getDeviceTriggerCard(id).registerRunListener(async (args, state) => listener(args, state));
    };
    action(ids.ecomode, (device, args) => device.setEcoMode(args.ecomode));
    action(ids.heatingcoil, (device, args) => device.setHeatingCoil(args[ids.heatingcoilArg]));
    action(ids.statusMode, (device, args) => device.changeMode(args.mode));
    action(ids.setTemperature, (device, args) => device.setTargetTemperature(args.temperature));
    action(ids.resetFilterReminder, (device) => device.resetFilterReminder());
    action(ids.startBoost, (device, args) => device.startModeFor('3', args.minutes));
    action(ids.startFireplace, (device, args) => device.startModeFor('2', args.minutes));
    const mapped = (map, value) => map[value] ?? value;
    condition(ids.statusModeIs, (device, args) => device.getCapabilityValue(device.statusModeCapabilityId) === mapped(statusModeArgMap, args.mode));
    condition(ids.heatExchangerIs, (device, args) => device.getCapabilityValue('heat_exchanger_mode') === mapped(onOffArgMap, args.mode));
    condition(ids.heaterIs, (device, args) => device.getCapabilityValue('heater_mode') === mapped(onOffArgMap, args.mode));
    condition(ids.alarmAIs, (device) => device.getCapabilityValue('alarm_a') === true);
    condition(ids.alarmBIs, (device) => device.getCapabilityValue('alarm_b.desc') === true);
    condition(ids.fanLevelIs, (device, args) => Number(device.getCapabilityValue('fanspeed_level')) === Number(args.level));
    condition(ids.heatingCoilIs, (device) => device.getCapabilityValue(device.heatingCoilCapabilityId) === '1');
    condition(ids.unitBoostingIs, (device) => device.unitBoosting === true);
    // The *_changed cards compare their dropdown with the value the trigger was
    // fired with. 'any' matches every value.
    const matches = (map) => (args, state) => {
        if (state == null)
            return false;
        if (args.mode_title === 'any')
            return true;
        return state.mode === mapped(map, args.mode_title);
    };
    trigger(ids.statusModeChanged, matches(statusModeArgMap));
    trigger(ids.heaterChanged, matches(onOffArgMap));
    trigger(ids.heatExchangerChanged, matches(onOffArgMap));
    // Fired on every change of the countdown; runs when it drops below the limit.
    trigger(ids.filterDaysBelow, (args, state) => state != null
        && state.previous >= Number(args.days) && state.current < Number(args.days));
}

import { DriverCards, MD_ON_OFF_ARG_MAP, MD_STATUS_MODE_ARG_MAP } from '../../lib/flowCards';

export const EWIND_CARDS: DriverCards = {
  ids: {
    ecomode: 'ecomode',
    heatingcoil: 'heatingcoil',
    heatingcoilArg: 'heatingcoil',
    statusMode: 'status-mode',
    setTemperature: 'set-temperature',
    resetFilterReminder: 'reset_filter_reminder',
    startBoost: 'start-boost',
    startFireplace: 'start-fireplace',
    statusModeIs: 'eWindstatus_mode_is',
    heatExchangerIs: 'heat_exchanger_mode_is',
    heaterIs: 'heater_mode_is',
    alarmAIs: 'alarm_a_is',
    alarmBIs: 'alarm_b_is',
    fanLevelIs: 'fanspeed_level_is',
    heatingCoilIs: 'heating_coil_state_is',
    unitBoostingIs: 'unit_boosting_is',
    statusModeChanged: 'eWindstatus_mode_changed',
    heatExchangerChanged: 'heat_exchanger_mode_changed',
    heaterChanged: 'heater_mode_changed',
    alarmATriggered: 'alarm_a_triggered',
    alarmBTriggered: 'alarm_b_triggered',
    filterDaysBelow: 'filter_days_below',
  },
  // The eWind condition cards use the capability values as dropdown ids;
  // cards saved before 4.0.1 still carry the named ids.
  statusModeArgMap: MD_STATUS_MODE_ARG_MAP,
  onOffArgMap: MD_ON_OFF_ARG_MAP,
};

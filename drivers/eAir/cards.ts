import { DriverCards, MD_ON_OFF_ARG_MAP, MD_STATUS_MODE_ARG_MAP } from '../../lib/flowCards';

export const EAIR_CARDS: DriverCards = {
  ids: {
    ecomode: 'ecomode_eAir',
    heatingcoil: 'heatingcoil_eAir',
    heatingcoilArg: 'heatingcoil_eAir',
    statusMode: 'status-mode_eAir',
    setTemperature: 'set-temperature_eAir',
    resetFilterReminder: 'reset_filter_reminder_eAir',
    startFireplace: 'start-fireplace_eAir',
    statusModeIs: 'eAirstatus_mode_is2',
    heatExchangerIs: 'heat_exchanger_mode_is2',
    heaterIs: 'heater_mode_is2',
    alarmAIs: 'alarm_a_is2',
    alarmBIs: 'alarm_b_is2',
    fanLevelIs: 'fanspeed_level_is2',
    heatingCoilIs: 'heating_coil_state_is2',
    unitBoostingIs: 'unit_boosting_is2',
    statusModeChanged: 'eAirstatus_mode_changed2',
    heatExchangerChanged: 'heat_exchanger_mode_changed2',
    heaterChanged: 'heater_mode_changed2',
    alarmATriggered: 'alarm_a_triggered2',
    alarmBTriggered: 'alarm_b_triggered2',
    filterDaysBelow: 'filter_days_below2',
  },
  // The eAir condition cards use named dropdown ids.
  statusModeArgMap: MD_STATUS_MODE_ARG_MAP,
  onOffArgMap: MD_ON_OFF_ARG_MAP,
};

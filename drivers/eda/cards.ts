import { DriverCards } from '../../lib/flowCards';

export const EDA_CARDS: DriverCards = {
  ids: {
    heatingcoil: 'heatingcoil_eda',
    heatingcoilArg: 'heatingcoil',
    statusMode: 'status-mode_eda',
    setTemperature: 'set-temperature_eda',
    startBoost: 'start-boost_eda',
    startFireplace: 'start-overpressure_eda',
    statusModeIs: 'edastatus_mode_is',
    heatExchangerIs: 'heat_exchanger_mode_is_eda',
    heaterIs: 'heater_mode_is_eda',
    alarmAIs: 'alarm_a_is_eda',
    alarmBIs: 'alarm_b_is_eda',
    statusModeChanged: 'edastatus_mode_changed',
    heatExchangerChanged: 'heat_exchanger_mode_changed_eda',
    heaterChanged: 'heater_mode_changed_eda',
    alarmATriggered: 'alarm_a_triggered_eda',
    alarmBTriggered: 'alarm_b_triggered_eda',
  },
  // The EDA cards use the capability values as dropdown ids.
  statusModeArgMap: {},
  onOffArgMap: {},
};

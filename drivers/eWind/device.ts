import { ExventModbusDevice, FlowCardIds } from '../../lib/ExventDevice';

class MyeWindDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'eWindstatus';
  protected readonly statusModeCapability = 'eWindstatus_mode';

  protected readonly flowCardIds: FlowCardIds = {
    ecomode: 'ecomode',
    heatingcoil: 'heatingcoil',
    heatingcoilArg: 'heatingcoil',
    statusMode: 'status-mode',
    setTemperature: 'set-temperature',
    resetFilterReminder: 'reset_filter_reminder',
    statusModeIs: 'eWindstatus_mode_is',
    heatExchangerIs: 'heat_exchanger_mode_is',
    heaterIs: 'heater_mode_is',
    statusModeChanged: 'eWindstatus_mode_changed',
    heatExchangerChanged: 'heat_exchanger_mode_changed',
    heaterChanged: 'heater_mode_changed',
    alarmBTriggered: 'alarm_b_triggered',
  };

  // eWind condition cards already use the capability values as dropdown ids.
  protected readonly statusModeArgMap: Record<string, string> = {};
  protected readonly onOffArgMap: Record<string, string> = {};
}

module.exports = MyeWindDevice;

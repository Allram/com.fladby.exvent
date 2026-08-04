import { ExventModbusDevice, FlowCardIds } from '../../lib/ExventDevice';

class MyeAirDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'eAirstatus';
  protected readonly statusModeCapability = 'eAirstatus_mode';

  protected readonly flowCardIds: FlowCardIds = {
    ecomode: 'ecomode_eAir',
    heatingcoil: 'heatingcoil_eAir',
    heatingcoilArg: 'heatingcoil_eAir',
    statusMode: 'status-mode_eAir',
    setTemperature: 'set-temperature_eAir',
    resetFilterReminder: 'reset_filter_reminder_eAir',
    statusModeIs: 'eAirstatus_mode_is2',
    heatExchangerIs: 'heat_exchanger_mode_is2',
    heaterIs: 'heater_mode_is2',
    statusModeChanged: 'eAirstatus_mode_changed2',
    heatExchangerChanged: 'heat_exchanger_mode_changed2',
    heaterChanged: 'heater_mode_changed2',
    alarmBTriggered: 'alarm_b_triggered2',
  };

  // The eAir condition cards use named dropdown ids while the capabilities
  // store numeric strings; map before comparing.
  protected readonly statusModeArgMap: Record<string, string> = {
    home: '0', away: '1', fireplace: '2', boost: '3', off: '4', enhanced: '5',
  };

  protected readonly onOffArgMap: Record<string, string> = {
    on: '1', off: '0',
  };
}

module.exports = MyeAirDevice;

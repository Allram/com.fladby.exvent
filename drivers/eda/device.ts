import { ExventModbusDevice, FlowCardIds } from '../../lib/ExventDevice';
import { RegisterMap } from '../../lib/modbus';
import { EDA_COILS, EDA_HOLDING_REGISTERS, edaStatusMode } from '../../lib/eda';

/**
 * Exvent units with EDA automation, reached through a Freeway WEB adapter.
 * The register map differs from eWind and eAir; see lib/eda.ts.
 */
class MyEdaDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'edastatus';
  protected readonly statusModeCapability = 'edastatus_mode';

  protected readonly flowCardIds: FlowCardIds = {
    heatingcoil: 'heatingcoil_eda',
    heatingcoilArg: 'heatingcoil',
    statusMode: 'status-mode_eda',
    setTemperature: 'set-temperature_eda',
    statusModeIs: 'edastatus_mode_is',
    heatExchangerIs: 'heat_exchanger_mode_is_eda',
    heaterIs: 'heater_mode_is_eda',
    statusModeChanged: 'edastatus_mode_changed',
    heatExchangerChanged: 'heat_exchanger_mode_changed_eda',
    heaterChanged: 'heater_mode_changed_eda',
    alarmBTriggered: 'alarm_b_triggered_eda',
  };

  // The EDA cards use the capability values as dropdown ids.
  protected readonly statusModeArgMap: Record<string, string> = {};
  protected readonly onOffArgMap: Record<string, string> = {};

  // Freeway WEB acknowledges function codes 5 and 6 without passing the
  // write on to the unit; 15 and 16 go through.
  protected readonly useMultipleWrites = true;
  protected readonly enhancedVentilation = false;
  protected readonly setpointRange: [number, number] = [10, 30];
  protected readonly overpressureDurationRegisters = [57];

  registers: RegisterMap = { ...EDA_HOLDING_REGISTERS };
  coilRegisters: RegisterMap = { ...EDA_COILS };

  /** Freeway WEB presents the unit on ID 1 unless the unitId setting says otherwise. */
  protected modbusUnitId(setting: unknown): number {
    const id = Number(setting);
    return Number.isInteger(id) && id >= 1 && id <= 255 ? id : 1;
  }

  protected capabilityIds(): string[] {
    // No eco mode (coil 40 is reserved) and no service countdown (no HREG 710).
    return super.capabilityIds()
      .filter((id) => id !== 'ecomode_mode' && id !== 'filter_days_remaining');
  }

  protected statusModeFromRegister(value: string): string {
    return edaStatusMode(Number(value));
  }
}

module.exports = MyEdaDevice;

import { ExventModbusDevice, FlowCardIds } from '../../lib/ExventDevice';
import { Measurement, RegisterMap } from '../../lib/modbus';
import { EDA_COILS, EDA_HOLDING_REGISTERS, edaStatusMode } from '../../lib/eda';

/** A device setting whose value lives on the unit. */
interface UnitSetting {
  /** Key of the register or coil in the register maps. */
  key: string;
  coil?: boolean;
  /** Register value per unit of the setting, e.g. 10 for tenths of a degree. */
  scale?: number;
}

// Device settings stored on the unit, keyed by setting id. The poll mirrors
// them into Homey, so changes made on the unit's panel show up; onSettings
// and the flow cards write them.
const UNIT_SETTINGS: Record<string, UnitSetting> = {
  heating_allowed: { key: 'heating_coil', coil: true },
  cooling_allowed: { key: 'cooling_allowed', coil: true },
  heating_block_temperature: { key: 'heating_block_temperature', scale: 10 },
  cooling_block_temperature: { key: 'cooling_block_temperature', scale: 10 },
};

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
      .filter((id) => id !== 'ecomode_mode' && id !== 'filter_days_remaining')
      .concat(['cooling_allowed']);
  }

  protected statusModeFromRegister(value: string): string {
    return edaStatusMode(Number(value));
  }

  registerFlowListeners() {
    super.registerFlowListeners();
    const onAction = (cardId: string, action: (device: MyEdaDevice, args: any) => Promise<void>) => {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args: any) => {
          const device = args.device as MyEdaDevice;
          if (!device.getAvailable()) return false;
          await action(device, args);
          return true;
        });
    };
    onAction('set-cooling_eda', (device, args) => device.setUnitSetting('cooling_allowed', args.allowed === '1'));
    onAction('set-heating-block-temperature_eda', (device, args) => device.setUnitSetting('heating_block_temperature', args.temperature));
    onAction('set-cooling-block-temperature_eda', (device, args) => device.setUnitSetting('cooling_block_temperature', args.temperature));
  }

  registerCapabilityListeners() {
    super.registerCapabilityListeners();
    this.registerCapabilityListener('cooling_allowed', async (value) => {
      if (!this.getAvailable()) return;
      await this.setUnitSetting('cooling_allowed', value === '1');
    });
  }

  async onSettings(event: { newSettings: Record<string, any>; changedKeys: string[] }) {
    await super.onSettings(event);
    for (const id of event.changedKeys) {
      if (UNIT_SETTINGS[id]) await this.writeUnitSetting(UNIT_SETTINGS[id], event.newSettings[id]);
    }
  }

  async processResult(result: Record<string, Measurement>) {
    await super.processResult(result);
    const reading = (key: string) => (result[key] && result[key].value !== 'xxx' ? result[key].value : undefined);

    const coolingAllowed = reading('cooling_allowed');
    if (coolingAllowed !== undefined) {
      await this.updateCapability('cooling_allowed', coolingAllowed === '1' ? '1' : '0');
    }

    // setSettings does not trigger onSettings, so mirroring cannot loop.
    for (const [id, setting] of Object.entries(UNIT_SETTINGS)) {
      const raw = reading(setting.key);
      if (raw !== undefined) {
        const value = setting.coil ? raw === '1' : Number(raw) / (setting.scale ?? 1);
        if (this.getSetting(id) !== value) {
          await this.setSettings({ [id]: value }).catch(this.error);
        }
      }
    }
  }

  /** Writes a unit setting and shows the new value in the device settings. */
  async setUnitSetting(id: string, value: boolean | number) {
    await this.writeUnitSetting(UNIT_SETTINGS[id], value);
    await this.setSettings({ [id]: value }).catch(this.error);
  }

  private async writeUnitSetting(setting: UnitSetting, value: unknown) {
    if (setting.coil) {
      await this.sendCoilRequest(this.coilRegisters[setting.key][0], Boolean(value));
    } else {
      await this.sendHoldingRequest(this.registers[setting.key][0], Math.round(Number(value) * (setting.scale ?? 1)));
    }
  }

  private async updateCapability(id: string, value: unknown) {
    if (this.getCapabilityValue(id) === value) return;
    await this.setCapabilityValue(id, value).catch(this.error);
  }
}

module.exports = MyEdaDevice;

import { ExventModbusDevice, FlowCardIds } from '../../lib/ExventDevice';
import { Measurement, RegisterMap } from '../../lib/modbus';
import {
  EDA_COILS, EDA_HOLDING_REGISTERS, edaDefrosting, edaOverpressure, edaStatusMode,
} from '../../lib/eda';

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
  service_reminder: { key: 'service_reminder', coil: true },
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
      .concat(['cooling_allowed', 'cooling_active', 'defrosting', 'fanspeed_level_set', 'overpressure']);
  }

  protected statusModeFromRegister(value: string): string {
    return edaStatusMode(Number(value));
  }

  registerFlowListeners() {
    super.registerFlowListeners();
    const onAction = (cardId: string, action: (device: MyEdaDevice, args: any) => Promise<unknown>) => {
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
    onAction('set-overpressure-duration_eda', (device, args) => device.setOverpressureDuration(args.minutes));
    onAction('set-fan-level_eda', (device, args) => device.setFanLevel(args.level));

    const onCondition = (cardId: string, capabilityId: string) => {
      this.homey.flow.getConditionCard(cardId)
        .registerRunListener(async (args: any) => (args.device as MyEdaDevice).getCapabilityValue(capabilityId) === true);
    };
    onCondition('defrosting_is_eda', 'defrosting');
    onCondition('cooling_active_is_eda', 'cooling_active');
  }

  registerCapabilityListeners() {
    super.registerCapabilityListeners();
    this.registerCapabilityListener('cooling_allowed', async (value) => {
      if (!this.getAvailable()) return;
      await this.setUnitSetting('cooling_allowed', value === '1');
    });

    if (this.hasCapability('fanspeed_level_set')) {
      this.registerCapabilityListener('fanspeed_level_set', async (value) => {
        if (!this.getAvailable()) return;
        // Percent sliders in Homey run from 0 to 1, like dim. The slider
        // shows the full range so its middle is 50%, but the unit's lowest
        // level is 20%. Homey stores the dragged value once this listener
        // returns, so move the slider up to what was written afterwards.
        const percent = await this.setFanLevel(value * 100);
        if (percent !== Math.round(value * 100)) {
          this.homey.setTimeout(() => {
            this.updateCapability('fanspeed_level_set', percent / 100).catch(this.error);
          }, 500);
        }
      });
    }

    // The quick action. Turning it off returns the unit to Home, as the
    // mode picker does.
    this.registerCapabilityListener('overpressure', async (value) => {
      if (!this.getAvailable()) return;
      const mode = value ? '2' : '0';
      await this.setStatusModeValue(mode);
      await this.fireModeChanged(this.flowCardIds.statusModeChanged, mode);
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

    // The fan level is a percentage only on EC fans; AC fans take steps 1-8,
    // which the slider cannot show, so AC units do not get it.
    const fanType = reading('fan_type');
    if (fanType !== undefined) {
      this.ecFans = fanType === '1';
      if (!this.ecFans && this.hasCapability('fanspeed_level_set')) {
        await this.removeCapability('fanspeed_level_set').catch(this.error);
      }
    }

    // Holding registers and coils arrive in separate calls, so the level is
    // kept until the fan type is known.
    const panelLevel = reading('fan_speed_panel');
    if (panelLevel !== undefined) this.panelLevel = Number(panelLevel);
    if (this.ecFans && this.panelLevel !== undefined && this.hasCapability('fanspeed_level_set')) {
      await this.updateCapability('fanspeed_level_set', this.panelLevel / 100);
    }

    const cooling = reading('cooling_status');
    if (cooling !== undefined) {
      await this.updateState('cooling_active', cooling === '1', 'cooling_started_eda', 'cooling_stopped_eda');
    }

    const state = reading('status_mode');
    if (state !== undefined) {
      await this.updateState('defrosting', edaDefrosting(Number(state)), 'defrosting_started_eda', 'defrosting_stopped_eda');
      await this.updateCapability('overpressure', edaOverpressure(Number(state)));
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

  /** Whether the unit has EC fans, from coil 16; unknown until the first poll. */
  private ecFans: boolean | undefined;

  /** The last reading of HREG 53. */
  private panelLevel: number | undefined;

  /**
   * Writes the fan level selected on the panel (HREG 53), in percent, kept
   * within the unit's 20-100%. Returns the level written.
   */
  async setFanLevel(level: number): Promise<number> {
    if (this.ecFans !== true) {
      throw new Error(this.homey.__('fanLevelUnsupported'));
    }
    const percent = Math.min(100, Math.max(20, Math.round(Number(level))));
    await this.sendHoldingRequest(this.registers['fan_speed_panel'][0], percent);
    await this.updateCapability('fanspeed_level_set', percent / 100);
    return percent;
  }

  /** Writes the overpressure duration and shows it in the device settings. */
  async setOverpressureDuration(minutes: number) {
    for (const register of this.overpressureDurationRegisters) {
      await this.sendHoldingRequest(register, minutes);
    }
    await this.setSettings({ fireplace_duration_minutes: minutes }).catch(this.error);
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

  /**
   * Updates an on/off reading and fires its started or stopped trigger. The
   * unit changes these on its own, so the poll is the only place to see it.
   * No trigger on the first reading after the device is added or the app starts.
   */
  private async updateState(id: string, value: boolean, startedCard: string, stoppedCard: string) {
    const previous = this.getCapabilityValue(id);
    await this.updateCapability(id, value);
    if (typeof previous === 'boolean' && previous !== value) {
      await this.homey.flow.getDeviceTriggerCard(value ? startedCard : stoppedCard)
        .trigger(this)
        .catch(this.error);
    }
  }
}

module.exports = MyEdaDevice;

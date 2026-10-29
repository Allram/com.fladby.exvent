import { ExventModbusDevice } from '../../lib/ExventDevice';
import { Measurement, RegisterMap, readModbus } from '../../lib/modbus';
import {
  EDA_COILS, EDA_HOLDING_REGISTERS, EDA_MODE_COIL_BY_MODE, EDA_MODE_COILS, edaDefrosting, edaFanTypeFromLevel, edaOverpressure,
  edaStatus, edaStatusMode,
} from '../../lib/eda';
import { inRange, toNumber } from '../../lib/settings';
import { EDA_CARDS } from './cards';

/** Coil 3 turns overpressure on and off. */
const OVERPRESSURE_COIL = 3;

/** Device store key for the fan type read from coil 16: true for EC fans, false for AC fans. */
const EC_FANS_STORE_KEY = 'ec_fans';

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
  // Coil 54 has its own capability here, with the values Allowed and
  // Blocked; eWind and eAir keep heating_coil_state with On and Off.
  protected readonly heatingCoilCapability = 'heating_allowed';
  protected readonly driverCards = EDA_CARDS;

  // Freeway WEB acknowledges function codes 5 and 6 without passing the
  // write on to the unit; 15 and 16 go through.
  protected readonly useMultipleWrites = true;
  protected readonly enhancedVentilation = false;
  // HREG 135 is in tenths of a degree, and the panel limits it to 10-30 °C.
  protected readonly setpointRange: [number, number] = [10, 30];
  protected readonly setpointStep = 0.5;
  protected readonly boostDurationRange: [number, number] = [1, 60];
  // Freeway WEB acknowledges a write before the unit reports it, so the
  // value written is kept for a while rather than what the unit reports.
  protected readonly settingSettleMs = 30 * 1000;
  protected readonly edaAlarmNames = true;
  // Home, Away, Overpressure and Boost turn the other mode coils off, so
  // Home also ends a long away set on the panel. Off only sets the stop coil:
  // stopping is not one of the modes, and the unit keeps its mode for when it
  // runs again, as it does when stopped from the panel.
  protected readonly exclusiveModeCoils = EDA_MODE_COILS;
  protected readonly modeCoils = EDA_MODE_COIL_BY_MODE;

  registers: RegisterMap = { ...EDA_HOLDING_REGISTERS };
  coilRegisters: RegisterMap = { ...EDA_COILS };

  /** The last reading of HREG 53. */
  private panelLevel: number | undefined;

  private fanLevelListenerRegistered = false;

  /** A read of the fan type still under way, shared by the calls that wait for it. */
  private ecFansRead: Promise<boolean> | null = null;

  /** Freeway WEB presents the unit on ID 1 unless the unit_id setting says otherwise. */
  protected modbusUnitId(setting: unknown = this.getSetting('unit_id')): number {
    const id = inRange(setting, [1, 255]);
    return id !== undefined && Number.isInteger(id) ? id : 1;
  }

  protected capabilityIds(): string[] {
    // No eco mode (coil 40 is reserved), no service countdown (no HREG 710)
    // and none of the MD registers behind the boost quick action, the
    // controller outputs and the season. A unit known to have AC fans does
    // not get the fan level slider back on every start; a unit whose fan
    // type is not known yet keeps it.
    const mdOnly = ['ecomode_mode', 'filter_days_remaining', 'boost', 'heat_recovery_output', 'after_heating_output', 'season', 'button.reset_filter'];
    const acFans = this.ecFans === false;
    return super.capabilityIds()
      .filter((id) => !mdOnly.includes(id))
      .concat(['cooling_allowed', 'cooling_active', 'defrosting', 'fanspeed_level_set', 'overpressure'])
      .filter((id) => !(acFans && id === 'fanspeed_level_set'));
  }

  protected statusModeFromRegister(value: string): string {
    return edaStatusMode(Number(value));
  }

  protected statusFromRegister(value: string): string | undefined {
    return edaStatus(Number(value));
  }

  registerCapabilityListeners() {
    super.registerCapabilityListeners();
    this.registerCapabilityListener('cooling_allowed', async (value) => {
      if (!this.isUsable()) return;
      this.setUnitSetting('cooling_allowed', value === '1').catch(this.error);
    });

    if (this.hasCapability('fanspeed_level_set')) this.registerFanLevelListener();

    // The quick action. Turning it on starts overpressure as the mode picker
    // does. Turning it off only ends overpressure, so a stopped unit stays
    // stopped and away stays on; the poll then reports the mode the unit
    // went back to and fires the mode trigger if it changed.
    this.registerCapabilityListener('overpressure', async (value) => {
      if (!this.isUsable()) return;
      if (value) {
        this.changeMode('2').catch(this.error);
      } else {
        this.sendCoilRequest(OVERPRESSURE_COIL, false).catch(this.error);
        this.endModeWriteSettleAfterQueue();
      }
    });
  }

  /** The fan level slider's listener; registered once the device has the slider. */
  private registerFanLevelListener() {
    if (this.fanLevelListenerRegistered) return;
    this.fanLevelListenerRegistered = true;
    this.registerCapabilityListener('fanspeed_level_set', async (value) => {
      if (!this.isUsable()) return;
      // Percent sliders in Homey run from 0 to 1, like dim. The slider
      // shows the full range so its middle is 50%, but the unit's lowest
      // level is 20%. Homey stores the dragged value once this listener
      // returns, so move the slider up to what was written afterwards.
      const percent = await this.setFanLevel(value * 100);
      if (percent !== undefined && percent !== Math.round(value * 100)) {
        this.homey.setTimeout(() => {
          this.setIfChanged('fanspeed_level_set', percent / 100).catch(this.error);
        }, 500);
      }
    });
  }

  protected settingRanges(): Record<string, [number, number]> {
    return {
      ...super.settingRanges(),
      heating_block_temperature: [-5, 25],
      cooling_block_temperature: [5, 40],
    };
  }

  protected validateSettings(settings: Record<string, any>, changedKeys: string[]) {
    super.validateSettings(settings, changedKeys);
    const ranges = this.settingRanges();
    for (const id of ['heating_block_temperature', 'cooling_block_temperature']) {
      if (changedKeys.includes(id) && inRange(settings[id], ranges[id]) === undefined) {
        const [min, max] = ranges[id];
        throw new Error(this.homey.__('settings.invalidNumber', { range: `${min}–${max}` }));
      }
    }
  }

  protected unitSettingWrites(settings: Record<string, any>, changedKeys: string[]): Array<Promise<unknown>> {
    const writes = super.unitSettingWrites(settings, changedKeys);
    for (const id of changedKeys) {
      if (UNIT_SETTINGS[id]) writes.push(this.writeUnitSetting(id, settings[id]));
    }
    return writes;
  }

  async processResult(result: Record<string, Measurement>, pollSeq?: number) {
    await super.processResult(result, pollSeq);
    const reading = (key: string) => this.reading(result, key);

    const coolingAllowed = reading('cooling_allowed');
    if (coolingAllowed !== undefined) {
      await this.setIfChanged('cooling_allowed', coolingAllowed === '1' ? '1' : '0');
    }

    const panelLevel = reading('fan_speed_panel');
    if (panelLevel !== undefined) this.panelLevel = Number(panelLevel);

    // The fan type is coil 16. Should a unit not answer for it, the level
    // selected on the panel tells AC steps from EC percent.
    const fanType = reading('fan_type');
    if (fanType === '0' || fanType === '1') {
      await this.applyFanType(fanType === '1');
    } else if (this.ecFans === undefined && this.panelLevel !== undefined) {
      const ecFans = edaFanTypeFromLevel(this.panelLevel);
      if (ecFans !== undefined) await this.applyFanType(ecFans);
    }

    if (this.ecFans && this.panelLevel !== undefined && this.hasCapability('fanspeed_level_set')) {
      await this.setIfChanged('fanspeed_level_set', this.panelLevel / 100);
    }

    const cooling = reading('cooling_status');
    if (cooling !== undefined) {
      await this.updateState('cooling_active', cooling === '1', 'cooling_started_eda', 'cooling_stopped_eda');
    }

    const state = reading('status_mode');
    if (state !== undefined) {
      await this.updateState('defrosting', edaDefrosting(Number(state)), 'defrosting_started_eda', 'defrosting_stopped_eda');
      await this.setIfChanged('overpressure', edaOverpressure(Number(state)));
    }

    // setSettings does not trigger onSettings, so mirroring cannot loop.
    for (const [id, setting] of Object.entries(UNIT_SETTINGS)) {
      const raw = reading(setting.key);
      if (raw !== undefined) {
        const value = setting.coil ? raw === '1' : Number(raw) / (setting.scale ?? 1);
        await this.mirrorSetting(id, value, pollSeq);
      }
    }
  }

  /** Writes a unit setting and shows the new value in the device settings. */
  async setUnitSetting(id: string, value: boolean | number) {
    const written = await this.writeUnitSetting(id, value);
    if (written !== undefined) await this.setSettings({ [id]: written }).catch(this.error);
  }

  /**
   * Whether the unit has EC fans, from coil 16. Kept in the device store so
   * it is known when the app starts; undefined until coil 16 has been read.
   */
  private get ecFans(): boolean | undefined {
    const value = this.getStoreValue(EC_FANS_STORE_KEY);
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * Stores the fan type and gives the device the fan level slider only on
   * EC fans. The level is a percentage only on EC fans; AC fans take steps
   * 1-8, which the slider cannot show and which are not a percentage.
   */
  private async applyFanType(ecFans: boolean) {
    if (this.ecFans !== ecFans) await this.setStoreValue(EC_FANS_STORE_KEY, ecFans).catch(this.error);
    await this.applyFanLevelUnits(ecFans);
    const hasSlider = this.hasCapability('fanspeed_level_set');
    if (!ecFans && hasSlider) {
      await this.removeCapability('fanspeed_level_set').catch(this.error);
    } else if (ecFans && !hasSlider) {
      await this.addCapability('fanspeed_level_set').catch(this.error);
      this.registerFanLevelListener();
    }
  }

  /** Shows the fan level in % on EC fans and as a plain step on AC fans; saved only when it changes. */
  private async applyFanLevelUnits(ecFans: boolean) {
    let options: any = {};
    try {
      options = this.getCapabilityOptions('fanspeed_level') ?? {};
    } catch {
      options = {};
    }
    const units = ecFans ? { en: '%', no: '%' } : { en: '', no: '' };
    const current = options.units ?? { en: '%', no: '%' };
    if (current.en === units.en && current.no === units.no) return;
    await this.setCapabilityOptions('fanspeed_level', { ...options, units }).catch(this.error);
  }

  /**
   * The fan type. Until a poll has read it, for example right after the app
   * starts, coil 16 is read now; a unit that cannot be reached gives the
   * connection error, not the message for AC fans.
   */
  private async readEcFans(): Promise<boolean> {
    const known = this.ecFans;
    if (known !== undefined) return known;
    // Flow cards running at the same time share one read, so their writes
    // still go out in the order they were made.
    if (!this.ecFansRead) {
      this.ecFansRead = this.readEcFansFromUnit().finally(() => {
        this.ecFansRead = null;
      });
    }
    return this.ecFansRead;
  }

  private async readEcFansFromUnit(): Promise<boolean> {
    try {
      await this.ensureConnected();
    } catch {
      throw new Error(this.homey.__('noConnection'));
    }
    let ecFans: boolean | undefined;
    try {
      const result = await readModbus(this.client, { fan_type: this.coilRegisters['fan_type'] }, 'coil');
      const value = result['fan_type'] && result['fan_type'].value;
      if (value === '0' || value === '1') ecFans = value === '1';
    } catch {
      ecFans = undefined;
    }
    if (ecFans === undefined) {
      try {
        const result = await readModbus(this.client, { fan_speed_panel: this.registers['fan_speed_panel'] }, 'holding');
        const level = result['fan_speed_panel'] && Number(result['fan_speed_panel'].value);
        if (level !== undefined && Number.isFinite(level)) ecFans = edaFanTypeFromLevel(level);
      } catch {
        ecFans = undefined;
      }
    }
    if (ecFans === undefined) throw new Error(this.homey.__('fanTypeUnknown'));
    await this.applyFanType(ecFans);
    return ecFans;
  }

  /**
   * Writes the fan level selected on the panel (HREG 53), in percent, kept
   * within the unit's 20-100%. Returns the level written, or undefined when
   * the level is not a number.
   */
  async setFanLevel(level: number): Promise<number | undefined> {
    const requested = toNumber(level);
    if (requested === undefined) return undefined;
    if (!await this.readEcFans()) {
      throw new Error(this.homey.__('fanLevelUnsupported'));
    }
    const percent = Math.min(100, Math.max(20, Math.round(requested)));
    await this.sendHoldingRequest(this.registers['fan_speed_panel'][0], percent);
    await this.setIfChanged('fanspeed_level_set', percent / 100);
    return percent;
  }

  /**
   * The heating picker and its flow card write coil 54 through the shared
   * class. Tying the write to the heating_allowed setting lets the setting
   * follow as soon as the unit reports it, as it does for cooling.
   */
  sendCoilRequest(register: number, value: boolean, options: any = {}): Promise<void> {
    if (register === this.coilRegisters[UNIT_SETTINGS.heating_allowed.key][0]) {
      return super.sendCoilRequest(register, value, { setting: 'heating_allowed', settingValue: value, ...options });
    }
    return super.sendCoilRequest(register, value, options);
  }

  /** Writes the overpressure duration and shows it in the device settings. */
  async setOverpressureDuration(minutes: number) {
    const value = inRange(minutes, this.settingRanges().fireplace_duration_minutes);
    if (value === undefined || !Number.isInteger(value)) throw new Error(this.homey.__('invalidDuration'));
    await Promise.all(this.durationWrites('fireplace_duration_minutes', value));
    await this.setSettings({ fireplace_duration_minutes: value }).catch(this.error);
  }

  /**
   * Writes a unit setting. A number outside the setting's range is not
   * written. Resolves with the value the unit will report back once the
   * write has gone out, or undefined when nothing was written.
   */
  async writeUnitSetting(id: string, value: unknown): Promise<number | boolean | undefined> {
    const setting = UNIT_SETTINGS[id];
    if (setting.coil) {
      const on = Boolean(value);
      await this.sendCoilRequest(this.coilRegisters[setting.key][0], on, { setting: id, settingValue: on });
      return on;
    }
    const number = inRange(value, this.settingRanges()[id]);
    if (number === undefined) return undefined;
    const scale = setting.scale ?? 1;
    const raw = Math.round(number * scale);
    await this.sendHoldingRequest(this.registers[setting.key][0], raw, { setting: id, settingValue: raw / scale });
    return raw / scale;
  }

  /**
   * Updates an on/off reading and fires its started or stopped trigger. The
   * unit changes these on its own, so the poll is the only place to see it.
   * A newly added device has no value yet and gets no trigger on its first
   * reading. Values survive an app restart, so a change made while the app
   * was stopped does fire on the first poll.
   */
  private async updateState(id: string, value: boolean, startedCard: string, stoppedCard: string) {
    const previous = this.getCapabilityValue(id);
    await this.setIfChanged(id, value);
    if (typeof previous === 'boolean' && previous !== value) {
      await this.fireTrigger(value ? startedCard : stoppedCard);
    }
  }
}

module.exports = MyEdaDevice;

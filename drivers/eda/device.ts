import { ExventModbusDevice, UnitSetting } from '../../lib/ExventDevice';
import { Measurement, RegisterMap, readModbus } from '../../lib/modbus';
import {
  EDA_COILS, EDA_HOLDING_REGISTERS, EDA_MODE_COIL_BY_MODE, EDA_MODE_COILS, edaDefrosting, edaFanTypeFromLevel, edaOverpressure,
  edaStatus, edaStatusMode,
} from '../../lib/eda';
import { inRange, toNumber } from '../../lib/settings';
import { EDA_ALARM_NAMES } from '../../lib/alarms';
import { EDA_CARDS } from './cards';

/** Device store key for the fan type read from coil 16: true for EC fans, false for AC fans. */
const EC_FANS_STORE_KEY = 'ec_fans';

/**
 * Exvent units with EDA automation, reached through a Freeway WEB adapter.
 * The register map differs from eWind and eAir; see lib/eda.ts.
 */
class MyEdaDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'edastatus';
  readonly statusModeCapability = 'edastatus_mode';
  // Coil 54 has its own capability here, with the values Allowed and
  // Blocked; eWind and eAir keep heating_coil_state with On and Off.
  readonly heatingCoilCapability = 'heating_allowed';
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
  protected readonly alarmNames = EDA_ALARM_NAMES;
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

  protected modelCapabilityIds(): string[] {
    // None of the MD ones: coil 40 (eco mode) is reserved, and there is no
    // HREG 710 (service countdown) nor the registers behind the boost quick
    // action, the controller outputs and the season. A unit known to have AC
    // fans does not get the fan level slider back on every start; a unit
    // whose fan type is not known yet keeps it.
    const ids = ['cooling_allowed', 'cooling_active', 'defrosting', 'fanspeed_level_set', 'overpressure'];
    return this.ecFans === false ? ids.filter((id) => id !== 'fanspeed_level_set') : ids;
  }

  protected statusModeFromRegister(value: string): string {
    return edaStatusMode(Number(value));
  }

  protected statusFromRegister(value: string): string | undefined {
    return edaStatus(Number(value));
  }

  registerCapabilityListeners() {
    super.registerCapabilityListeners();
    this.listen('cooling_allowed', (value) => {
      this.setUnitSetting('cooling_allowed', value === '1').catch(this.error);
    });

    if (this.hasCapability('fanspeed_level_set')) this.registerFanLevelListener();

    this.listenQuickAction('overpressure', '2');
  }

  /** The fan level slider's listener; registered once the device has the slider. */
  private registerFanLevelListener() {
    if (this.fanLevelListenerRegistered) return;
    this.fanLevelListenerRegistered = true;
    this.listen('fanspeed_level_set', async (value) => {
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

  protected unitSettings(): Record<string, UnitSetting> {
    return {
      ...super.unitSettings(),
      heating_allowed: { coil: 'heating_coil', mirror: true },
      cooling_allowed: { coil: 'cooling_allowed', mirror: true },
      heating_block_temperature: {
        registers: ['heating_block_temperature'], scale: 10, range: [-5, 25], mirror: true,
      },
      cooling_block_temperature: {
        registers: ['cooling_block_temperature'], scale: 10, range: [5, 40], mirror: true,
      },
      service_reminder: { coil: 'service_reminder', mirror: true },
    };
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
    await this.sendHoldingRequest(this.address(this.registers, 'fan_speed_panel'), percent);
    await this.setIfChanged('fanspeed_level_set', percent / 100);
    return percent;
  }

  /** Writes the overpressure duration and shows it in the device settings. */
  async setOverpressureDuration(minutes: number) {
    await this.setUnitSetting('fireplace_duration_minutes', this.wholeDuration('fireplace_duration_minutes', minutes));
  }

  /**
   * Updates an on/off reading and fires its started or stopped trigger. The
   * unit changes these on its own, so the poll is the only place to see it.
   * A newly added device has no value yet and gets no trigger on its first
   * reading. Values survive an app restart, so a change made while the app
   * was stopped does fire on the first poll.
   */
  private async updateState(id: string, value: boolean, startedCard: string, stoppedCard: string) {
    if (await this.change(id, value) !== undefined) await this.fireTrigger(value ? startedCard : stoppedCard);
  }
}

module.exports = MyEdaDevice;

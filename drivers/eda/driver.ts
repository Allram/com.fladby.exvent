import { ExventDriver, PairTestResult } from '../../lib/ExventDriver';
import { EDA_CARDS } from './cards';

/** HREG 599 is the software version: below 190 the unit is an MD unit (eWind or eAir), not EDA. */
const EDA_MIN_SOFTWARE_VERSION = 190;

class MyEdaDriver extends ExventDriver {
  protected readonly driverCards = EDA_CARDS;
  // Freeway WEB presents the unit on ID 1.
  protected readonly pairUnitId = 1;
  protected readonly pairTestRegister = 599;
  protected readonly refusedMessage = 'pair.test.refused_eda';

  protected registerDriverFlowCards() {
    const onAction = (cardId: string, action: (device: any, args: any) => Promise<unknown>) => {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args: any) => {
          const { device } = args;
          if (!device.isUsable()) throw new Error(this.homey.__('noConnection'));
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
        .registerRunListener(async (args: any) => args.device.getCapabilityValue(capabilityId) === true);
    };
    onCondition('defrosting_is_eda', 'defrosting');
    onCondition('cooling_active_is_eda', 'cooling_active');
  }

  protected checkPairReading(value: number): PairTestResult {
    if (value > 0 && value < EDA_MIN_SOFTWARE_VERSION) {
      return { ok: false, code: 'platform', message: this.homey.__('pair.test.notEda') };
    }
    return { ok: true };
  }
}

module.exports = MyEdaDriver;

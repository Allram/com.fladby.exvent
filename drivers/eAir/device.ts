import { ExventModbusDevice } from '../../lib/ExventDevice';
import { EAIR_HOLDING_REGISTERS } from '../../lib/exvent';
import { EAIR_CARDS } from './cards';

class MyeAirDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'eAirstatus';
  protected readonly statusModeCapability = 'eAirstatus_mode';
  protected readonly driverCards = EAIR_CARDS;

  // The eAir register list has a long away coil; Home and Enhanced
  // ventilation turn it off, as they do on EDA.
  protected readonly longAwayCoil = 2;

  registers = { ...EAIR_HOLDING_REGISTERS };

  /** eAir has the effective fan speeds in percent, but no boost duration register. */
  protected capabilityIds(): string[] {
    return super.capabilityIds().concat(['fan_output.supply', 'fan_output.extract']);
  }
}

module.exports = MyeAirDevice;

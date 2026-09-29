import { ExventModbusDevice } from '../../lib/ExventDevice';
import { EWIND_HOLDING_REGISTERS } from '../../lib/exvent';
import { EWIND_CARDS } from './cards';

class MyeWindDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'eWindstatus';
  protected readonly statusModeCapability = 'eWindstatus_mode';
  protected readonly driverCards = EWIND_CARDS;

  registers = { ...EWIND_HOLDING_REGISTERS };
}

module.exports = MyeWindDevice;

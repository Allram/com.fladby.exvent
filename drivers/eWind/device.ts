import { ExventModbusDevice } from '../../lib/ExventDevice';
import { EWIND_HOLDING_REGISTERS } from '../../lib/exvent';
import { EWIND_CARDS } from './cards';

class MyeWindDevice extends ExventModbusDevice {
  protected readonly statusCapability = 'eWindstatus';
  protected readonly statusModeCapability = 'eWindstatus_mode';
  protected readonly driverCards = EWIND_CARDS;
  // An eWind answers HREG 3-30 and 44-66 in one read each (checked on a
  // unit 29.10.2026), so the poll needs six requests instead of ten.
  protected readonly holdingReadGap = 15;

  registers = { ...EWIND_HOLDING_REGISTERS };
}

module.exports = MyeWindDevice;

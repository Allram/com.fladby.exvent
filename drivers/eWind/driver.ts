import { ExventDriver } from '../../lib/ExventDriver';
import { EWIND_CARDS } from './cards';

class MyeWindDriver extends ExventDriver {
  protected readonly driverCards = EWIND_CARDS;
}

module.exports = MyeWindDriver;

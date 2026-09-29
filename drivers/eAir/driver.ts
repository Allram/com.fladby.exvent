import { ExventDriver } from '../../lib/ExventDriver';
import { EAIR_CARDS } from './cards';

class MyeAirDriver extends ExventDriver {
  protected readonly driverCards = EAIR_CARDS;
}

module.exports = MyeAirDriver;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ExventDevice_1 = require("../../lib/ExventDevice");
const exvent_1 = require("../../lib/exvent");
const cards_1 = require("./cards");
class MyeWindDevice extends ExventDevice_1.ExventModbusDevice {
    statusCapability = 'eWindstatus';
    statusModeCapability = 'eWindstatus_mode';
    driverCards = cards_1.EWIND_CARDS;
    registers = { ...exvent_1.EWIND_HOLDING_REGISTERS };
}
module.exports = MyeWindDevice;

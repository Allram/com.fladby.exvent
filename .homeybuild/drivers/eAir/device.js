"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ExventDevice_1 = require("../../lib/ExventDevice");
const exvent_1 = require("../../lib/exvent");
const cards_1 = require("./cards");
class MyeAirDevice extends ExventDevice_1.ExventModbusDevice {
    statusCapability = 'eAirstatus';
    statusModeCapability = 'eAirstatus_mode';
    driverCards = cards_1.EAIR_CARDS;
    // The eAir register list has a long away coil; Home and Enhanced
    // ventilation turn it off, as they do on EDA.
    longAwayCoil = 2;
    registers = { ...exvent_1.EAIR_HOLDING_REGISTERS };
    /** eAir has the effective fan speeds in percent, but no boost duration register. */
    capabilityIds() {
        return super.capabilityIds().concat(['fan_output.supply', 'fan_output.extract']);
    }
}
module.exports = MyeAirDevice;

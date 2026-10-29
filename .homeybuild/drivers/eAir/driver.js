"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ExventDriver_1 = require("../../lib/ExventDriver");
const cards_1 = require("./cards");
class MyeAirDriver extends ExventDriver_1.ExventDriver {
    driverCards = cards_1.EAIR_CARDS;
}
module.exports = MyeAirDriver;

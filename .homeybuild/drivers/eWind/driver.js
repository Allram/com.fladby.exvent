"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ExventDriver_1 = require("../../lib/ExventDriver");
const cards_1 = require("./cards");
class MyeWindDriver extends ExventDriver_1.ExventDriver {
    driverCards = cards_1.EWIND_CARDS;
}
module.exports = MyeWindDriver;

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExventDriver = void 0;
const net = __importStar(require("net"));
const Modbus = __importStar(require("jsmodbus"));
const homey_1 = __importDefault(require("homey"));
const flowCards_1 = require("./flowCards");
const modbus_1 = require("./modbus");
const settings_1 = require("./settings");
const PAIR_TEST_TIMEOUT_MS = 5000;
/**
 * Shared driver: registers the driver's flow cards once, before its devices
 * start, and answers the pairing view's connection test.
 */
class ExventDriver extends homey_1.default.Driver {
    /** The Modbus unit ID and holding register the pairing test reads. */
    pairUnitId = 255;
    pairTestRegister = 44;
    /** Locale key of the message for a refused connection. */
    refusedMessage = 'pair.test.refused';
    async onInit() {
        (0, flowCards_1.registerFlowCards)(this.homey, this.driverCards);
        this.registerDriverFlowCards();
    }
    /** Flow cards of this driver only. */
    registerDriverFlowCards() { }
    async onPair(session) {
        session.setHandler('test', async (data) => this.testConnection(data ?? {}));
    }
    /**
     * Connects to the address, reads one register and closes again. The view
     * shows the message and still lets the user add the device, since the
     * unit may just be switched off for now.
     */
    async testConnection({ address, port }) {
        const host = String(address ?? '').trim();
        const portNumber = Number(port);
        if (!(0, settings_1.isValidHost)(host) || !(0, settings_1.isValidPort)(portNumber)) {
            return { ok: false, code: 'invalid', message: this.homey.__('pair.invalidip') };
        }
        const duplicate = this.getDevices().some((device) => String(device.getSetting('address') ?? '').trim() === host
            && Number(device.getSetting('port')) === portNumber);
        if (duplicate)
            return { ok: false, code: 'duplicate', message: this.homey.__('pair.test.duplicate') };
        const socket = new net.Socket();
        const client = new Modbus.client.TCP(socket, this.pairUnitId, PAIR_TEST_TIMEOUT_MS);
        try {
            await new Promise((resolve, reject) => {
                const timer = this.homey.setTimeout(() => socket.destroy(Object.assign(new Error('Connect timeout'), { code: 'ETIMEDOUT' })), PAIR_TEST_TIMEOUT_MS);
                socket.once('connect', () => {
                    this.homey.clearTimeout(timer);
                    resolve();
                });
                socket.once('error', (err) => {
                    this.homey.clearTimeout(timer);
                    reject(err);
                });
                socket.connect({ host, port: portNumber });
            });
            const { response } = await client.readHoldingRegisters(this.pairTestRegister, 1);
            return this.checkPairReading(response.body.valuesAsArray[0]);
        }
        catch (err) {
            this.log(`Pairing test to ${host}:${portNumber} failed: ${(0, modbus_1.describeError)(err)}`);
            if ((0, modbus_1.requestFailure)(err) === 'exception')
                return { ok: false, code: 'notExvent', message: this.homey.__('pair.test.notExvent') };
            if (err && err.code === 'ECONNREFUSED')
                return { ok: false, code: 'refused', message: this.homey.__(this.refusedMessage) };
            if ((0, modbus_1.requestFailure)(err) === 'timeout' || (err && ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(err.code))) {
                return { ok: false, code: 'timeout', message: this.homey.__('pair.test.timeout') };
            }
            return { ok: false, code: 'failed', message: this.homey.__('pair.test.failed', { error: (0, modbus_1.describeError)(err) }) };
        }
        finally {
            socket.removeAllListeners();
            socket.on('error', () => { });
            socket.destroy();
        }
    }
    /** Whether the value read looks like this driver's unit. */
    checkPairReading(value) {
        return { ok: true };
    }
}
exports.ExventDriver = ExventDriver;

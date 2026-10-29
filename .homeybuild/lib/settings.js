"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toNumber = toNumber;
exports.inRange = inRange;
exports.isValidHost = isValidHost;
exports.isValidPort = isValidPort;
/** A number given as a number or numeric text, or undefined for anything else. */
function toNumber(value) {
    let number = NaN;
    if (typeof value === 'number')
        number = value;
    else if (typeof value === 'string' && value.trim() !== '')
        number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
/** The value if it is a number within [min, max], else undefined. */
function inRange(value, [min, max]) {
    const number = toNumber(value);
    return number !== undefined && number >= min && number <= max ? number : undefined;
}
/**
 * Whether the text is an IPv4 address without leading zeros or a host name.
 * The pairing views carry their own copy of this check.
 */
function isValidHost(value) {
    if (typeof value !== 'string')
        return false;
    const host = value.trim();
    // Only digits and dots: it has to be a whole IPv4 address.
    if (/^[\d.]+$/.test(host)) {
        const octets = host.split('.');
        return octets.length === 4 && octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
    }
    return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);
}
/** Whether the value is a whole TCP port number. */
function isValidPort(value) {
    const port = toNumber(value);
    return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535;
}

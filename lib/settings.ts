/** A number given as a number or numeric text, or undefined for anything else. */
export function toNumber(value: unknown): number | undefined {
  let number = NaN;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** The value if it is a number within [min, max], else undefined. */
export function inRange(value: unknown, [min, max]: [number, number]): number | undefined {
  const number = toNumber(value);
  return number !== undefined && number >= min && number <= max ? number : undefined;
}

/**
 * Whether the text is an IPv4 address without leading zeros or a host name.
 * The pairing views carry their own copy of this check.
 */
export function isValidHost(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  // Only digits and dots: it has to be a whole IPv4 address.
  if (/^[\d.]+$/.test(host)) {
    const octets = host.split('.');
    return octets.length === 4 && octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);
}

/** Whether the value is a whole TCP port number. */
export function isValidPort(value: unknown): boolean {
  const port = toNumber(value);
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535;
}

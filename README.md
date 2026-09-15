# Exvent for Homey

Homey app to control and monitor Exvent **eWind**, **eAir** and **EDA** ventilation systems over **Modbus TCP**.

## Features

- Live readings every 60 seconds: fresh/supply/extract/exhaust air temperatures, extract air humidity, heat recovery efficiency (supply and extract), fan speed level and temperature setpoint
- Status and mode (Home / Away / Overpressure / Boost / Off), heater, heat exchanger and heating coil states, eco mode and filter alarm
- Control from the device UI or Flows: set mode, target temperature, eco mode and heating coil
- Flow cards: action cards (set mode, temperature, eco mode, heating coil), condition cards (mode, heater, heat exchanger) and triggers (mode changed, heater changed, heat exchanger changed, filter alarm)
- "Last poll time" shows when values were last refreshed — in your Homey's own timezone and language — and reads "No connection" while the unit is unreachable

### EDA units

Units with EDA automation, connected through a Freeway WEB adapter, have their own driver and a few extras:

- Overpressure as the device's quick action, with its duration as a setting and a Flow card
- Season control: allow or block heating and cooling, and the outdoor temperatures that block them
- Fan level in percent, set with a slider or a Flow card (units with EC fans), next to the level in effect
- Heat pump readings: cooling active and defrosting
- Service reminder on or off, and its interval

EDA units have no eco mode, Enhanced ventilation mode or service countdown.

## Setup

1. Activate **Modbus TCP** on the ventilation unit (in the eWind/eAir panel or app).
2. Give the unit a **static IP address** (DHCP reservation) in your router.
3. Add the device in Homey and enter the unit's IP address and port (default 502).

For **EDA** units, open the Freeway WEB adapter's web interface, go to Configuration → Access control configuration, enter your Homey's IP address as the Modbus/TCP client and save. The adapter accepts Modbus connections from that one address only, so give Homey a static IP address too, and add the device with the adapter's IP address.

## Reliability

- Registers are read in batched Modbus requests (6 requests per poll) to keep the load on the unit's Modbus module low, with automatic fallback to individual reads
- Writes are serialized through a queue with spacing between commands, so simultaneous Flows and manual changes can't conflict
- Automatic reconnection with backoff when the unit drops off the network; a confirmation poll a few seconds after every command shows the unit's actual state

## Development

TypeScript, Homey SDK v3. Pull requests are welcome.

```bash
npm ci
npm test                                # unit tests (node --test)
npx homey app validate --level publish  # full validation
npx homey app run                       # run against your own Homey
```

Use `npx homey app run --remote` with an EDA unit. Without `--remote` the app runs in Docker on your computer, and the Freeway WEB adapter refuses the connection because it only accepts Homey's IP address.

CI validates every push and publishes tagged releases (`v*`) to the Homey App Store.

[docs/README.md](docs/README.md) describes the EDA register map and what has been verified against a live unit.

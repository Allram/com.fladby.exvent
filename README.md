# Exvent for Homey

Homey app to control and monitor Exvent **eWind** and **eAir** ventilation systems over **Modbus TCP**.

## Features

- Live readings every 60 seconds: fresh/supply/extract/exhaust air temperatures, extract air humidity, heat recovery efficiency (supply and extract), fan speed level and temperature setpoint
- Status and mode (Home / Away / Fireplace / Boost / Off), heater, heat exchanger and heating coil states, eco mode and filter alarm
- Control from the device UI or Flows: set mode, target temperature, eco mode and heating coil
- Flow cards: action cards (set mode, temperature, eco mode, heating coil), condition cards (mode, heater, heat exchanger) and triggers (mode changed, heater changed, heat exchanger changed, filter alarm)
- "Last poll time" shows when values were last refreshed — in your Homey's own timezone and language — and reads "No connection" while the unit is unreachable

## Setup

1. Activate **Modbus TCP** on the ventilation unit (in the eWind/eAir panel or app).
2. Give the unit a **static IP address** (DHCP reservation) in your router.
3. Add the device in Homey and enter the unit's IP address and port (default 502).

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

CI validates every push and publishes tagged releases (`v*`) to the Homey App Store.

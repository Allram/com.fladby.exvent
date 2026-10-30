# Security policy

## Reporting a vulnerability

Please report security problems privately to Vegard Fladby, not in a public issue or pull request: use the contact address on the app's Homey App Store page, or a private message on GitHub to @Allram. Say which version you tested (Settings → Apps → Exvent on your Homey) and how to reproduce the problem. You will get an answer within a week.

Only the latest version published on the Homey App Store is supported with fixes.

## What the app trusts

- **Your Homey and its owner.** The app runs inside Homey's app sandbox. Anyone who can add devices, change device settings or build flows on your Homey can control the ventilation unit through this app; the app has no access control of its own beyond Homey's.
- **Your home network.** Modbus TCP has no encryption or authentication. Anyone on the same network can read and write the unit directly, with or without this app, and a device on the network can answer as if it were the unit. Keep the unit and the Freeway WEB adapter on a trusted network, and on EDA use the adapter's access list so only Homey can connect.
- **The address you enter.** When you add a unit, the app opens a connection to the address and port you type to check that it answers. It connects nowhere else.

## Out of scope

- Weaknesses in Modbus TCP itself, in the unit's firmware or in the Freeway WEB adapter.
- Attacks that need control of your Homey account or your home network.
- The Homey platform and the Homey App Store.

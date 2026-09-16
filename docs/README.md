# Modbus reference

Reference material for the Modbus register maps this app talks to.

## Automation platforms

Exvent units, made by Enervent and sold under that name outside Norway, come with one of two
automation families, and they do **not** share a register map:

| Platform | App driver | Register list |
| --- | --- | --- |
| **MD** | `eWind`, `eAir` | `eAirMD-modbus-register-list-public.xlsx`, `eWind-modbus-register-list-public.xlsx` |
| **EDA** | `eda` | `EDA_Modbus_Registers_2011_09_14.pdf` (in this folder) |

EDA units reach the network through a Freeway WEB bus adapter. It presents the unit on Modbus
unit ID 1 and accepts Modbus TCP connections from a single client address, configured in its
web interface.

The MD lists are published on the [Enervent document
server](https://doc.enervent.com/out/out.ViewFolder.php?folderid=16&showtree=1) and are not
duplicated here — download them from the source so they stay current.

A unit reports its own platform in holding register **599** (software version):

| Value | Platform |
| --- | --- |
| `< 190` | MD |
| `190`–`201` | Legacy EDA |
| `> 201` | EDA |

## EDA_Modbus_Registers_2011_09_14.pdf

The English EDA register list, authored by Mikael Karlsson and edited 14 September 2011.

Enervent published it at `http://enervent.fi/data/freeway/EDA_Modbus_Registers_2011_09_14.pdf`.
That URL now returns 404 and the document is no longer on Enervent's current document server,
so the copy here is preserved from the [Internet Archive snapshot of
2015-03-22](https://web.archive.org/web/20150322001720/http://enervent.fi/data/freeway/EDA_Modbus_Registers_2011_09_14.pdf).

```
sha256  1d95e4232a2316c095f5d961a3fe4dee315b4ede8c4daa3df74199637377c090
```

This supersedes the older Finnish edition (`eda_modbus_rekisterilista_2011-02-16.pdf`, 17
February 2011), which circulates on forums and covers the same registers in less detail. Use
this file instead.

## Register numbering

The PDF writes coils as `1xNNNN` and holding registers as `3xNNNN`. **`NNNN` is the Modbus data
address used on the wire** — there is no ±1 offset, despite what the `1x`/`3x` convention
normally implies.

Verified against a live unit by reading the real-time clock block, which is unambiguous:

| Register | Meaning | Read | Actual |
| --- | --- | --- | --- |
| 40 | Day | 12 | 12 |
| 41 | Month | 9 | September |
| 42 | Year (+2000) | 26 | 2026 |

## Writing through Freeway WEB

Freeway WEB answers "write single coil" (function code 5) and "write single register" (6) with
a well-formed echo, but does not pass the write on to the unit. "Write multiple coils" (15) and
"write multiple registers" (16) go through, so the `eda` driver writes with those.

Verified on a live unit:

| Write | Function code | Result |
| --- | --- | --- |
| Setpoint 20.0 °C to holding register 135 | 6 | Acknowledged, but the register still read 22.0 °C immediately, after 5 s and in the Freeway web interface |
| The same setpoint | 16 | Applied at once |
| Stop on, coil 0 | 5 | No effect; the echo carried value 0 and the coil read back 0 |
| Overpressure on, coil 3 | 15 | Applied; status bit 1024 set and 10 minutes remaining |

eWind and eAir are reached through other gateways and keep using codes 5 and 6.

## Holding register 44 — status bit field

Several states can be active at once; the register holds their sum. The Freeway WEB interface
renders the same bits under **Status**, with slightly different wording:

| Bit | Register list | Freeway WEB label |
| --- | --- | --- |
| 1 | Max cooling | Max cooling |
| 2 | Max heating | Max heating |
| 4 | Emergency stop | Emergency stop |
| 8 | Stop | Fans are stopped |
| 16 | Away | Away |
| 32 | Long away | Away long |
| 64 | Temperature boost | Temperature boost |
| 128 | CO2 boost | CO2 boost |
| 256 | Rh boost | Relative humidity |
| 512 | Boost | Manual boost |
| 1024 | Overpressure | Overpressure |
| 2048 | Cooker hood | — |
| 4096 | Central vacuum cleaner | CVC mode |
| 8192 | ELH cooling | SLP cooling |
| 16384 | Summernight cooling | Summer night cooling |
| 32768 | EDX defrosting | EXT melting |

Read as a signed 16-bit value the defrosting bit arrives as a negative number, so the `eda`
driver reads the register as unsigned and masks it with `0xffff` before testing bits.

## Defrosting

Bit 32768 is named after the EDX product line, which uses an outdoor unit, but it is **also**
how a unit with an *integrated* heat pump reports that it is defrosting. Holding register 639
distinguishes the two (`1` = outdoor pump unit fitted, `0` = not fitted); coil 46 carries the
defrost signal from an outdoor unit and stays 0 on integrated units.

Do not confuse this with coil 55, "defrosting function of heat recovery". That governs
anti-icing of the heat exchanger via the pressure switch (limits in registers 168–170) and is a
separate mechanism that may well be switched off on a unit that still defrosts its heat pump.
Register 644 sets how long the heat pump stays off after a defrost cycle.

## Registers the `eda` driver uses

| Address | Meaning | In the app |
| --- | --- | --- |
| Coils 0, 1, 3, 10 | Stop, away, overpressure, manual boost | Mode picker, overpressure quick action |
| Coil 16 | Fan type, EC 1 / AC 0 | Fan level slider only on EC fans |
| Coil 28 | Cooling in operation | Cooling active |
| Coil 30 | Heat recovery running | Heat exchanger |
| Coil 32 | Heating in operation | Heating active |
| Coil 42 | B alarm active | Filter alarm |
| Coil 49 | Service reminder on or off | Device setting |
| Coil 52 | Cooling allowed | Device setting and picker |
| Coil 54 | Heating allowed | Device setting and picker |
| Holding 6–10, 13 | Temperatures, extract air humidity | Readings |
| Holding 29, 30 | Heat recovery efficiency | Readings |
| Holding 44 | Status bit field | Mode, defrosting, overpressure |
| Holding 45 | Temperature control step | Status |
| Holding 50 | Fan level in effect | Reading |
| Holding 53 | Fan level set on the panel, 20–100% on EC fans | Slider and flow card |
| Holding 57 | Overpressure duration in minutes | Device setting |
| Holding 135 | Temperature setpoint, ×10 | Target temperature |
| Holding 164, 196 | Outdoor temperature below which cooling and above which heating are blocked, ×10 | Device settings |
| Holding 538 | Service reminder interval in days, 180 by default | Device setting |

Device settings are stored on the unit. The app reads them back on every poll, so a change made
on the unit's panel shows up in Homey.

## Where EDA differs from eWind and eAir

The shared device class in `lib/ExventDevice.ts` was written for the MD register lists. These
MD registers mean something else on EDA, or are missing, and the `eda` driver avoids them:

- **Holding register 56** is the overpressure time *left* and read only. The duration is 57.
- **Holding register 710** (days since the service reminder) does not exist; reading it returns
  "Illegal data address". There is no service countdown or reset card on EDA.
- **Holding register 50** is the ventilation level in effect, in percent (20–100) on EC fans,
  and read only. Register 53 holds the level selected on the panel. There is no Enhanced
  ventilation mode, and Home does not write a fan level.
- **Coil 40** (eco mode) is reserved.
- Holding register 135 (temperature setpoint) accepts 10–30 °C, scaled ×10. EDA units also hold
  the setpoint limits allowed on the panel in registers 140 and 141.

## Heat pump units

Heat-pump units force the fans to at least 70% whenever the heat pump runs, regardless of the
level set on the panel. Expect register 50 to jump to 70 on its own; that is the unit, not a
bug. For the same reason the manual advises against Away and Long away on these units — they
drop the fans to 30% and 20%, and save no energy.

Coil 52 is "cooling allowed" and coil 54 is "heating allowed". They are configuration bits that
persist across power cycles, not momentary commands, which is what makes them useful for
keeping the heat pump from heating in summer or cooling the rest of the year.

## Alarms

The newest alarm is in holding registers 385–391: type, state (`0` off, `1` reset, `2` on) and
time. Type 14 is the service reminder and types 16 and 17 are dirty supply and extract filters.
Coil 42 is set while any B alarm is active, which is what the app shows as the filter alarm, so
it also covers the service reminder.

According to the register list and eda-modbus-bridge, writing `1` to register 386 acknowledges
the newest alarm. The app does not do this, and it has not been tested.

The filter alarms rely on differential pressure transmitters, which are an accessory. Without
them, registers 14 and 15 and the alarm limits in 566 and 567 read 0, and the service reminder is
the unit's only prompt to change the filters.

## Maximum heating and cooling

Coils 6 and 7 do not force heating or cooling unconditionally. The function runs only until the
temperature setpoint is reached. On a unit already at its setpoint the write is accepted and the
coil drops back to 0 at once, as seen with an extract air temperature of 22.5 °C against a
setpoint of 22.0 °C. Raising the setpoint is what makes the unit heat.

## Credits

The register semantics here were cross-checked against
[Jalle19/eda-modbus-bridge](https://github.com/Jalle19/eda-modbus-bridge) (GPL-3.0), an
HTTP/MQTT bridge for Enervent units with EDA or MD automation. It is a well-tested independent
implementation of the same register maps and a useful reference when extending this app.

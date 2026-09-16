import { RegisterMap } from './modbus';

// Exvent units with EDA automation, reached through a Freeway WEB adapter.
// The register numbers are the addresses used on the wire; docs/README.md
// describes the register list and what has been verified on a live unit.

/** Bits of holding register 44, the state bit field. */
export const EDA_STATE = {
  EMERGENCY_STOP: 4,
  STOP: 8,
  AWAY: 16,
  LONG_AWAY: 32,
  BOOST: 512,
  OVERPRESSURE: 1024,
  DEFROSTING: 32768,
};

export const EDA_HOLDING_REGISTERS: RegisterMap = {
  air_outside: [6, 1, 'INT16', 'Fresh air'],
  air_supply_HRC: [7, 1, 'INT16', 'Supply air after heat recovery'],
  air_supply: [8, 1, 'INT16', 'Supply air'],
  air_exhaust: [9, 1, 'INT16', 'Exhaust air'],
  air_extract: [10, 1, 'INT16', 'Extract air'],
  air_humidity: [13, 1, 'UINT16', 'Extract air humidity'],
  air_supply_eff: [29, 1, 'UINT16', 'Heat recovery efficiency, supply air'],
  air_extract_eff: [30, 1, 'UINT16', 'Heat recovery efficiency, extract air'],
  status_mode: [44, 1, 'UINT16', 'State bit field'],
  status: [45, 1, 'UINT16', 'Temperature control step'],
  // Percent on EC fans, and the level in effect after boost, overpressure
  // and heat pump overrides. Read only on EDA.
  fan_speed_level: [50, 1, 'UINT16', 'Ventilation level in effect'],
  // The level selected on the panel, and writable: 20-100% on EC fans, 1-8 on
  // AC fans. Heat pump units run the fans at 70% or more while the heat pump
  // runs, whatever the panel says.
  fan_speed_panel: [53, 1, 'UINT16', 'Ventilation level selected on the panel'],
  // HREG 56 is the time left and read only; 57 is the duration itself.
  fireplace_duration: [57, 1, 'UINT16', 'Overpressure duration in minutes'],
  temperature_setpoint: [135, 1, 'INT16', 'Temperature setpoint'],
  cooling_block_temperature: [164, 1, 'INT16', 'Outdoor temperature below which cooling is blocked'],
  heating_block_temperature: [196, 1, 'INT16', 'Outdoor temperature above which heating is blocked'],
  service_interval_days: [538, 1, 'UINT16', 'Service reminder interval in days'],
};

// Coil 40 (eco mode) is reserved on EDA, and HREG 710 (days since the
// service reminder) does not exist.
export const EDA_COILS: RegisterMap = {
  fan_type: [16, 1, 'UINT32', 'Fan type, EC 1 / AC 0'],
  cooling_status: [28, 1, 'UINT32', 'Cooling running'],
  heat_exchanger_state: [30, 1, 'UINT32', 'Heat recovery running'],
  heater_status: [32, 1, 'UINT32', 'Heating running'],
  alarm_b_desc: [42, 1, 'UINT32', 'B alarm active'],
  service_reminder: [49, 1, 'UINT32', 'Service reminder on'],
  cooling_allowed: [52, 1, 'UINT32', 'Cooling allowed'],
  heating_coil: [54, 1, 'UINT32', 'Heating allowed'],
};

/**
 * The status mode ('0' home, '1' away, '2' overpressure, '3' boost, '4' off)
 * for a value of the state bit field. Several bits can be set at once, such
 * as overpressure during a heat pump defrost, so the register cannot be
 * matched against single values.
 */
export function edaStatusMode(state: number): string {
  const bits = state & 0xffff;
  if (bits & (EDA_STATE.EMERGENCY_STOP | EDA_STATE.STOP)) return '4';
  if (bits & EDA_STATE.OVERPRESSURE) return '2';
  if (bits & EDA_STATE.BOOST) return '3';
  if (bits & (EDA_STATE.AWAY | EDA_STATE.LONG_AWAY)) return '1';
  return '0';
}

/**
 * Whether the heat pump is defrosting. The bit is named after the EDX line
 * with an outdoor unit, but units with an integrated heat pump set it too.
 */
export function edaDefrosting(state: number): boolean {
  return ((state & 0xffff) & EDA_STATE.DEFROSTING) !== 0;
}

/** Whether overpressure is on, including while the unit is stopped. */
export function edaOverpressure(state: number): boolean {
  return ((state & 0xffff) & EDA_STATE.OVERPRESSURE) !== 0;
}

import { RegisterMap } from './modbus';

// Register maps of eWind and eAir (the MD platform). The addresses are the
// ones used on the wire; see the eWind and eAir register lists (Enervent
// documents 60 and 59). EDA units have their own maps in lib/eda.ts.

/** Holding registers read on both eWind and eAir. */
export const EXVENT_HOLDING_REGISTERS: RegisterMap = {
  air_outside: [6, 1, 'INT16', 'Fresh air'],
  air_supply_HRC: [7, 1, 'INT16', 'Supply air after HRC'],
  air_supply: [8, 1, 'INT16', 'Supply air'],
  air_exhaust: [9, 1, 'INT16', 'Exhaust air'],
  air_extract: [10, 1, 'INT16', 'Extract air temperature'],
  air_humidity: [13, 1, 'UINT16', 'Air humidity extract'],
  air_supply_eff: [29, 1, 'UINT16', 'Heat recovery efficiency, supply air'],
  air_extract_eff: [30, 1, 'UINT16', 'Heat recovery efficiency, exhaust air'],
  // A bit field: several states can be set at once. See statusModeFromRegister.
  status_mode: [44, 1, 'UINT16', 'Mode bit field'],
  // Bits 0-3 are the temperature control step; bits 12-15 are extra states.
  status: [45, 1, 'UINT16', 'Temperature control step'],
  // -100..-1 cooling, 1..100 heat recovery, 101..200 after-heating or heat
  // pump, 201..300 extra heating on heat pump units. Also joins 44-45 and 50
  // into one request.
  controller_output: [49, 1, 'INT16', 'Temperature controller output'],
  fan_speed_level: [50, 1, 'UINT16', 'Fan speed level'],
  fireplace_duration: [56, 1, 'UINT16', 'Overpressure (fireplace) duration in minutes'],
  // The unit copies 57 into 56 when it starts, so 57 is the duration the
  // fireplace mode keeps after a power cut.
  fireplace_duration_default: [57, 1, 'UINT16', 'Default overpressure duration in minutes'],
  outdoor_24h_average: [134, 1, 'INT16', '24-hour outside temperature average'],
  temperature_setpoint: [135, 1, 'INT16', 'Temperature setpoint'],
  summer_winter_threshold: [137, 1, 'INT16', 'Summer/winter threshold temperature'],
  alarm_type: [385, 1, 'UINT16', 'Newest alarm, type'],
  alarm_state: [386, 1, 'UINT16', 'Newest alarm, state (low byte)'],
  service_interval_days: [538, 1, 'UINT16', 'Days until service reminder alarm'],
  days_since_service_ack: [710, 1, 'UINT16', 'Days since service reminder was acknowledged'],
};

/** eWind: the manual boost duration is documented there, not on eAir. */
export const EWIND_HOLDING_REGISTERS: RegisterMap = {
  ...EXVENT_HOLDING_REGISTERS,
  boost_duration: [66, 1, 'UINT16', 'Manual boost duration in minutes'],
};

/** eAir: the effective fan speeds are documented there, not on eWind. */
export const EAIR_HOLDING_REGISTERS: RegisterMap = {
  ...EXVENT_HOLDING_REGISTERS,
  supply_fan_speed: [3, 1, 'UINT16', 'Effective supply fan speed in percent'],
  extract_fan_speed: [4, 1, 'UINT16', 'Effective extract fan speed in percent'],
};

export const EXVENT_COILS: RegisterMap = {
  heat_exchanger_state: [30, 1, 'BIT', 'State of Heat exchanger On/Off'],
  heater_status: [32, 1, 'BIT', 'After-heater On/Off'],
  eco_mode: [40, 1, 'BIT', 'eco Mode'],
  alarm_a: [41, 1, 'BIT', 'Class A alarm active'],
  alarm_b_desc: [42, 1, 'BIT', 'Class B alarm active'],
  service_reminder: [49, 1, 'BIT', 'Service reminder enabled'],
  heating_coil: [54, 1, 'BIT', 'State of Heater coil On/Off'],
};

/** Bits of holding register 44 on eWind and eAir. */
export const MODE_BITS = {
  ALARM_A: 4,
  STOP: 8,
  AWAY: 16,
  LONG_AWAY: 32,
  TEMPERATURE_BOOST: 64,
  CO2_BOOST: 128,
  RH_BOOST: 256,
  MANUAL_BOOST: 512,
  OVERPRESSURE: 1024,
};

/** Bits the unit sets on its own when it boosts the fans. */
export const UNIT_BOOST_BITS = MODE_BITS.TEMPERATURE_BOOST | MODE_BITS.CO2_BOOST | MODE_BITS.RH_BOOST;

/**
 * The status mode ('0' home, '1' away, '2' fireplace, '3' boost, '4' off,
 * '5' enhanced ventilation) for a value of holding register 44. Several bits
 * can be set at once, such as away while the cooker hood runs, so the value
 * cannot be matched as a whole. A stop from the panel or by an A alarm shows
 * as off. The unit's own temperature, CO2 and humidity boost show as enhanced
 * ventilation, as does home with the panel fan speed at level 3.
 */
export function exventStatusMode(state: number, fanSpeedLevel?: number): string {
  const bits = state & 0xffff;
  if (bits & (MODE_BITS.ALARM_A | MODE_BITS.STOP)) return '4';
  if (bits & MODE_BITS.OVERPRESSURE) return '2';
  if (bits & MODE_BITS.MANUAL_BOOST) return '3';
  if (bits & (MODE_BITS.AWAY | MODE_BITS.LONG_AWAY)) return '1';
  if (bits & UNIT_BOOST_BITS) return '5';
  if (fanSpeedLevel === 3) return '5';
  return '0';
}

/**
 * The status ('0' no heating or cooling, '1' cooling, '2' heat recovery,
 * '3' heating coil, '4' starting up, '5' dehumidification, '6' summer night
 * cooling) for a value of holding register 45. Only bits 0-3 are the step.
 */
const EXVENT_STATUS: Record<number, string> = {
  0: '0', 1: '1', 2: '2', 4: '3', 6: '6', 7: '4', 8: '5',
};

export function exventStatus(value: number): string | undefined {
  return EXVENT_STATUS[(value & 0xffff) & 0x0f];
}

/**
 * Heat recovery and after-heating in percent from the temperature
 * controller output (HREG 49). Heat recovery runs at full before the heater
 * takes over, so it reads 100% while the heater is on.
 */
export function controllerOutputs(output: number): { heatRecovery: number; afterHeating: number } {
  if (output <= 0) return { heatRecovery: 0, afterHeating: 0 };
  return {
    heatRecovery: Math.min(100, output),
    afterHeating: Math.min(100, Math.max(0, output - 100)),
  };
}

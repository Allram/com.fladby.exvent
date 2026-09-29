/**
 * Alarm types in holding register 385 (the newest entry of the alarm log),
 * as named in the eWind, eAir and EDA register lists. The lists use the same
 * numbers; EDA names 13 fire risk where MD units have an external alarm.
 */
const ALARM_TYPES: Record<number, { en: string; no: string }> = {
  1: { en: 'Supply air after heat recovery too cold', no: 'For kald tilluft etter varmegjenvinner' },
  2: { en: 'Supply air after the heater too cold', no: 'For kald tilluft etter ettervarmer' },
  3: { en: 'Supply air after the heater too hot', no: 'For varm tilluft etter ettervarmer' },
  4: { en: 'Room temperature too high', no: 'For høy romtemperatur' },
  5: { en: 'Extract air too cold', no: 'For kald avtrekksluft' },
  6: { en: 'Extract air too hot', no: 'For varm avtrekksluft' },
  7: { en: 'Heat pump fault', no: 'Feil på varmepumpe' },
  8: { en: 'Electric heater fault', no: 'Feil på elektrisk ettervarmer' },
  9: { en: 'Return water too cold', no: 'For kaldt returvann' },
  10: { en: 'Heat recovery fault', no: 'Feil på varmegjenvinner' },
  11: { en: 'Cooling fault', no: 'Feil på kjøling' },
  12: { en: 'Emergency stop', no: 'Nødstopp' },
  13: { en: 'External alarm', no: 'Ekstern alarm' },
  14: { en: 'Service reminder', no: 'Servicepåminnelse' },
  15: { en: 'Pressure switch', no: 'Trykkvakt' },
  16: { en: 'Supply air filter dirty', no: 'Tilluftsfilter tett' },
  17: { en: 'Extract air filter dirty', no: 'Avtrekksfilter tett' },
  20: { en: 'Supply fan pressure fault', no: 'Trykkfeil på tilluftsvifte' },
  21: { en: 'Extract fan pressure fault', no: 'Trykkfeil på avtrekksvifte' },
  22: { en: 'Extract air too hot', no: 'For varm avtrekksluft' },
  24: { en: 'Temperature TE52 too high', no: 'For høy temperatur TE52' },
  25: { en: 'Supply fan rotation fault', no: 'Rotasjonsfeil på tilluftsvifte' },
  26: { en: 'Extract fan rotation fault', no: 'Rotasjonsfeil på avtrekksvifte' },
  27: { en: 'Temperature TE02 too high', no: 'For høy temperatur TE02' },
  28: { en: 'Service reminder', no: 'Servicepåminnelse' },
  29: { en: 'Temperature TE49 too low', no: 'For lav temperatur TE49' },
};

const EDA_ALARM_TYPES: Record<number, { en: string; no: string }> = {
  13: { en: 'Fire risk', no: 'Brannfare' },
  15: { en: 'Electric heater pressure switch', no: 'Trykkvakt for elektrisk ettervarmer' },
};


/** The text for an alarm type, in the language given ('no' or anything else for English). */
export function alarmText(type: number, language: string, eda = false): string {
  const names = (eda && EDA_ALARM_TYPES[type]) || ALARM_TYPES[type];
  const no = language === 'no';
  if (!names) return `Alarm ${type}`;
  return no ? names.no : names.en;
}

/** Whether the newest alarm is on, from the state register (low byte 2). */
export function alarmOn(state: number): boolean {
  return (state & 0xff) === 2;
}

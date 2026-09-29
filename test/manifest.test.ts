import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT, readJson } from './device-harness';
import { DriverCards } from '../lib/flowCards';
import { EWIND_CARDS } from '../drivers/eWind/cards';
import { EAIR_CARDS } from '../drivers/eAir/cards';
import { EDA_CARDS } from '../drivers/eda/cards';

const DRIVERS: Array<[string, DriverCards, string]> = [
  ['eWind', EWIND_CARDS, 'eWindstatus_mode'],
  ['eAir', EAIR_CARDS, 'eAirstatus_mode'],
  ['eda', EDA_CARDS, 'edastatus_mode'],
];

const app = readJson('app.json');

function flowCard(id: string): any {
  for (const kind of ['actions', 'conditions', 'triggers']) {
    const card = app.flow[kind].find((item: any) => item.id === id);
    if (card) return card;
  }
  return undefined;
}

test('every flow card id of a driver exists for that driver', () => {
  for (const [driver, cards] of DRIVERS) {
    for (const [key, id] of Object.entries(cards.ids)) {
      if (key === 'heatingcoilArg') continue;
      const card = flowCard(id as string);
      assert.ok(card, `${driver}: ${key} = ${id} is not in app.json`);
      const device = card.args.find((arg: any) => arg.type === 'device');
      assert.equal(device.filter.split('&')[0], `driver_id=${driver}`, `${driver}: ${id} belongs to another driver`);
    }
  }
});

test('mode dropdowns map to values of the mode capability', () => {
  for (const [driver, cards, capability] of DRIVERS) {
    const values = app.capabilities[capability].values.map((value: any) => value.id);
    for (const id of [cards.ids.statusMode, cards.ids.statusModeIs, cards.ids.statusModeChanged]) {
      const arg = flowCard(id).args.find((item: any) => item.type === 'dropdown');
      for (const option of arg.values) {
        if (option.id === 'any') continue;
        const mapped = cards.statusModeArgMap[option.id] ?? option.id;
        assert.ok(values.includes(mapped), `${driver}: ${id} offers ${option.id}, which is no ${capability} value`);
      }
    }
  }
});

test('trigger tokens match what the app fires', () => {
  for (const [, cards] of DRIVERS) {
    for (const id of [cards.ids.statusModeChanged, cards.ids.heaterChanged, cards.ids.heatExchangerChanged]) {
      assert.deepEqual(flowCard(id).tokens.map((token: any) => token.name), ['mode'], id);
    }
    for (const id of [cards.ids.alarmATriggered, cards.ids.alarmBTriggered]) {
      assert.deepEqual(flowCard(id).tokens.map((token: any) => token.name), ['alarm'], id);
    }
  }
});

test('the three pairing views differ only in their driver', () => {
  const view = (driver: string) => fs.readFileSync(path.join(ROOT, `drivers/${driver}/pair/connect.html`), 'utf8');
  const eWind = view('eWind');
  for (const [driver, name] of [['eAir', 'eAir'], ['eda', 'EDA']]) {
    const expected = eWind
      .replace('pair.intro_eWind', `pair.intro_${driver}`)
      .replace("name: 'eWind',", `name: '${name}',`)
      .replace('pair.title_eWind', `pair.title_${driver}`);
    assert.equal(view(driver), expected, `drivers/${driver}/pair/connect.html has drifted from the eWind view`);
  }
});

function keys(object: any, prefix = ''): string[] {
  return Object.entries(object).flatMap(([key, value]) => (typeof value === 'object'
    ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

test('both languages have the same texts, and every text the code uses exists', () => {
  const en = readJson('locales/en.json');
  const no = readJson('locales/no.json');
  assert.deepEqual(keys(no).sort(), keys(en).sort());
  const sources = ['lib', 'drivers/eWind', 'drivers/eAir', 'drivers/eda'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith('.ts') || file.endsWith('.html'))
    .map((file) => fs.readFileSync(path.join(ROOT, dir, file), 'utf8')))
    .concat(['eWind', 'eAir', 'eda'].map((driver) => fs.readFileSync(path.join(ROOT, `drivers/${driver}/pair/connect.html`), 'utf8')));
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:__|\bt)\('([\w.]+)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/data-i18n="([\w.]+)"/g)) used.add(match[1]);
    for (const match of source.matchAll(/(?:refusedMessage|showWarning\()\s*=?\s*'([\w.]+)'/g)) used.add(match[1]);
  }
  const known = new Set(keys(en));
  for (const key of used) assert.ok(known.has(key), `locales are missing ${key}`);
});

test('the version is the same everywhere and the changelog has both languages', () => {
  const { version } = readJson('package.json');
  assert.equal(readJson('app.json').version, version);
  assert.equal(readJson('.homeycompose/app.json').version, version);
  const entry = readJson('.homeychangelog.json')[version];
  assert.ok(entry && entry.en && entry.no, `.homeychangelog.json has no en and no entry for ${version}`);
});

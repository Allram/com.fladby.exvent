// Smoke test of the pairing pages, drivers/*/pair/setup.html.
//
// Homey's firmware does not open a view as a page of its own. It fetches the
// HTML and inserts it with jQuery, `$(viewEl).html(html)`, into its pairing
// page, which has long since loaded; jQuery runs the inline script at that
// point. DOMContentLoaded has already fired, so a page that waits for it never
// binds the Connect button (the regression in v4.6.0). An ordinary jsdom load
// of the file would fire DOMContentLoaded and pass such a page. This test
// inserts the view the way the firmware does, types an address, clicks
// Connect and checks that the device is created.
//
// The firmware ships jQuery 3.3.1 (GET /js/jquery.js on the Homey, checked
// 2026-09-29); the jQuery 3.x from npm inserts HTML and runs its scripts the
// same way. jsdom and jQuery are loaded without type packages on purpose:
// @types/jsdom pulls the DOM lib into the whole compilation, which would let
// app code use browser globals without a type error.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// jsdom and jQuery are devDependencies, used only by this test.
// eslint-disable-next-line node/no-unpublished-require
const { JSDOM, VirtualConsole } = require('jsdom');

/** The repository root, from .homeybuild/test. */
const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line node/no-unpublished-require
const JQUERY = fs.readFileSync(require.resolve('jquery/dist/jquery.js'), 'utf8');
const DRIVERS = ['eWind', 'eAir', 'eda'];

/** The firmware's pairing page, reduced to what a view needs. */
const PAIRING_PAGE = `<!doctype html>
<html><head></head><body id="hy-wrap"><div id="hy-views"><div class="hy-view" data-id="setup"></div></div></body></html>`;

interface Pairing {
  document: any;
  window: any;
  /** Every device the view asked Homey to create. */
  created: any[];
  /** How many times the view called Homey.done(). */
  done: number;
  /** Titles the view set with Homey.setTitle(). */
  titles: string[];
  /** Script errors reported by jsdom. */
  errors: string[];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, what: string) {
  for (let round = 0; round < 100; round++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Shows the driver's pairing view the way the firmware does. */
async function showPairingView(driver: string): Promise<Pairing> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  const dom = new JSDOM(PAIRING_PAGE, { runScripts: 'dangerously', virtualConsole });
  const { window } = dom;
  const { document } = window;

  // Loaded by the pairing page's head, like /js/jquery.js on the Homey.
  const script = document.createElement('script');
  script.textContent = JQUERY;
  document.head.appendChild(script);
  if (document.readyState !== 'complete') {
    await new Promise((resolve) => window.addEventListener('load', resolve));
  }

  const pairing: Pairing = {
    document, window, created: [], done: 0, titles: [], errors,
  };

  // What the firmware's homey.js and homey.drivers.js provide to a view.
  window.__ = (key: string) => key;
  window.translateElement = () => {};
  const homey: any = {
    __: window.__,
    setTitle(title: string) {
      pairing.titles.push(title);
    },
    createDevice(data: any, callback?: (error: Error | null, result?: any) => void) {
      pairing.created.push(data);
      const result = Promise.resolve(data);
      if (typeof callback !== 'function') return result;
      result.then((value) => callback(null, value), (error) => callback(error));
      return undefined;
    },
    // The firmware keeps addDevice as a deprecated alias of createDevice.
    addDevice(data: any, callback?: (error: Error | null, result?: any) => void) {
      return homey.createDevice(data, callback);
    },
    done() {
      pairing.done++;
    },
  };
  window.Homey = homey;

  const html = fs.readFileSync(path.join(ROOT, 'drivers', driver, 'pair', 'setup.html'), 'utf8');
  const viewEl = document.querySelector('.hy-view');
  window.$(viewEl).html(html);
  window.translateElement(viewEl);
  // jQuery runs ready handlers asynchronously once the page has loaded.
  await delay(50);
  return pairing;
}

function type(pairing: Pairing, id: string, value: string) {
  const input = pairing.document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new pairing.window.Event('input', { bubbles: true }));
}

function errorBox(pairing: Pairing): string {
  const box = pairing.document.getElementById('error');
  return box.style.display === 'block' ? box.textContent : '';
}

for (const driver of DRIVERS) {
  test(`${driver} pairing view creates the device when Connect is clicked`, async () => {
    const pairing = await showPairingView(driver);
    try {
      const button = pairing.document.getElementById('connect');
      type(pairing, 'address', '192.168.1.50');
      assert.equal(button.disabled, false, 'Connect is still disabled after an address was typed');
      button.click();
      await until(() => pairing.done > 0, 'Homey.done() after Connect');

      assert.equal(pairing.created.length, 1);
      const [device] = pairing.created;
      assert.equal(typeof device.name, 'string');
      assert.ok(device.name.length > 0, 'the device has a name');
      assert.equal(typeof device.data.id, 'string');
      // Spread into a plain object: the view builds it in the jsdom realm.
      assert.deepEqual({ ...device.settings }, { address: '192.168.1.50', port: 502 });
      assert.equal(pairing.done, 1);
      assert.deepEqual(pairing.titles, [`pair.title_${driver}`]);
      assert.equal(errorBox(pairing), '');
      assert.deepEqual(pairing.errors, []);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view refuses an invalid address`, async () => {
    const pairing = await showPairingView(driver);
    try {
      type(pairing, 'address', '300.1.1.1');
      pairing.document.getElementById('connect').click();
      await until(() => errorBox(pairing) !== '', 'the error message');

      assert.equal(errorBox(pairing), 'pair.invalidip');
      assert.deepEqual(pairing.created, []);
      assert.equal(pairing.done, 0);
      assert.deepEqual(pairing.errors, []);
    } finally {
      pairing.window.close();
    }
  });
}

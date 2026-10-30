// Smoke test of the pairing pages, drivers/*/pair/connect.html.
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
import { ROOT, delay } from './device-harness';

// jsdom and jQuery are devDependencies, used only by this test.
// eslint-disable-next-line node/no-unpublished-require
const { JSDOM, VirtualConsole } = require('jsdom');

// eslint-disable-next-line node/no-unpublished-require
const JQUERY = fs.readFileSync(require.resolve('jquery/dist/jquery.js'), 'utf8');
const DRIVERS = ['eWind', 'eAir', 'eda'];

/** The firmware's pairing page, reduced to what a view needs. */
const PAIRING_PAGE = `<!doctype html>
<html><head></head><body id="hy-wrap"><div id="hy-views"><div class="hy-view" data-id="connect"></div></div></body></html>`;

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
  /** How many connection tests the view ran. */
  tests: number;
}

async function until(check: () => boolean, what: string) {
  for (let round = 0; round < 100; round++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Shows the driver's pairing view the way the firmware does. With `test`,
 * Homey.emit('test') answers the view's connection test with it; without,
 * the Homey has no emit, as on older firmware.
 */
async function showPairingView(driver: string, test?: any): Promise<Pairing> {
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
    await new Promise((resolve) => {
      window.addEventListener('load', resolve);
    });
  }

  const pairing: Pairing = {
    document, window, created: [], done: 0, titles: [], errors, tests: 0,
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
  if (test) {
    homey.emit = (event: string) => {
      if (event !== 'test') return Promise.reject(new Error(event));
      pairing.tests++;
      return Promise.resolve(test);
    };
  }
  window.Homey = homey;

  const html = fs.readFileSync(path.join(ROOT, 'drivers', driver, 'pair', 'connect.html'), 'utf8');
  const viewEl = document.querySelector('.hy-view');
  window.$(viewEl).html(html);
  window.translateElement(viewEl);
  // jQuery runs ready handlers asynchronously once the page has loaded.
  // The ready handler binds the Connect button and then initialises the view.
  await until(() => Boolean(window.$._data(document.getElementById('connect'), 'events')?.click), 'the Connect button to be bound');
  return pairing;
}

function type(pairing: Pairing, id: string, value: string) {
  const input = pairing.document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new pairing.window.Event('input', { bubbles: true }));
}

function errorBox(pairing: Pairing): string {
  return pairing.document.getElementById('error').textContent;
}

function progressBox(pairing: Pairing): string {
  return pairing.document.getElementById('progress').textContent;
}

/** The Add anyway button, when the view offers it. */
function addAnyway(pairing: Pairing): any {
  const button = pairing.document.getElementById('add-anyway');
  return button.hidden ? null : button;
}

for (const driver of DRIVERS) {
  test(`${driver} pairing view without a connection test says so and adds the device on Add anyway`, async () => {
    const pairing = await showPairingView(driver);
    try {
      const button = pairing.document.getElementById('connect');
      assert.equal(addAnyway(pairing), null, 'Add anyway is hidden before a test');
      type(pairing, 'address', '192.168.1.50');
      assert.equal(button.disabled, false, 'Connect is still disabled after an address was typed');
      button.click();
      await until(() => addAnyway(pairing) !== null, 'the Add anyway button');
      assert.equal(progressBox(pairing), 'pair.untested');
      assert.equal(pairing.document.getElementById('add-anyway-hint').textContent, 'pair.autoConnect');
      assert.equal(button.textContent, 'pair.tryAgain');
      assert.equal(pairing.created.length, 0);
      addAnyway(pairing).click();
      await until(() => pairing.done > 0, 'Homey.done() after Add anyway');

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

      assert.equal(errorBox(pairing), 'pair.invalidAddress');
      assert.equal(pairing.document.getElementById('address').getAttribute('aria-invalid'), 'true');
      assert.deepEqual(pairing.created, []);
      assert.equal(pairing.done, 0);
      assert.deepEqual(pairing.errors, []);
    } finally {
      pairing.window.close();
    }
  });
}

for (const driver of DRIVERS) {
  test(`${driver} pairing view adds the device when the connection test passes`, async () => {
    const pairing = await showPairingView(driver, { ok: true });
    try {
      type(pairing, 'address', '192.168.1.50');
      pairing.document.getElementById('connect').click();
      await until(() => pairing.done > 0, 'Homey.done() after a passed test');
      assert.equal(pairing.created.length, 1);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view numbers a second unit`, async () => {
    const pairing = await showPairingView(driver, { ok: true, devices: 1 });
    try {
      type(pairing, 'address', '192.168.1.51');
      pairing.document.getElementById('connect').click();
      await until(() => pairing.done > 0, 'Homey.done() after a passed test');
      assert.match(pairing.created[0].name, / 2$/);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view warns about a failed test, tests again, and adds on Add anyway`, async () => {
    const pairing = await showPairingView(driver, { ok: false, code: 'timeout', message: 'pair.test.timeout' });
    try {
      const button = pairing.document.getElementById('connect');
      type(pairing, 'address', '192.168.1.50');
      button.click();
      await until(() => addAnyway(pairing) !== null, 'the Add anyway button');
      // A failure the user can fix is a warning, not an error.
      assert.equal(errorBox(pairing), '');
      assert.equal(progressBox(pairing), 'pair.test.timeout');
      assert.equal(pairing.document.getElementById('add-anyway-hint').textContent, 'pair.autoConnect');
      assert.equal(button.textContent, 'pair.tryAgain');
      assert.deepEqual(pairing.created, []);
      // Try again tests again; it never adds an untested device.
      button.click();
      await until(() => pairing.tests === 2, 'the second test');
      await until(() => addAnyway(pairing) !== null, 'the Add anyway button again');
      assert.deepEqual(pairing.created, []);
      addAnyway(pairing).click();
      await until(() => pairing.done > 0, 'Homey.done() after Add anyway');
      assert.equal(pairing.created.length, 1);
      assert.deepEqual(pairing.errors, []);
    } finally {
      pairing.window.close();
    }
  });
}

for (const driver of DRIVERS) {
  test(`${driver} pairing view refuses a port out of range and marks the field`, async () => {
    const pairing = await showPairingView(driver);
    try {
      type(pairing, 'address', '192.168.1.50');
      type(pairing, 'port', '70000');
      pairing.document.getElementById('connect').click();
      await until(() => errorBox(pairing) !== '', 'the error message');
      assert.equal(errorBox(pairing), 'pair.invalidPort');
      assert.equal(pairing.document.getElementById('port').getAttribute('aria-invalid'), 'true');
      assert.equal(pairing.document.getElementById('address').getAttribute('aria-invalid'), null);
      assert.deepEqual(pairing.created, []);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view does not offer to add a unit that is already added`, async () => {
    const pairing = await showPairingView(driver, { ok: false, code: 'duplicate', message: 'pair.test.duplicate' });
    try {
      const button = pairing.document.getElementById('connect');
      type(pairing, 'address', '192.168.1.50');
      button.click();
      await until(() => errorBox(pairing) !== '', 'the test message');
      assert.equal(errorBox(pairing), 'pair.test.duplicate');
      assert.equal(button.textContent, 'pair.connect');
      assert.equal(addAnyway(pairing), null);
      assert.equal(pairing.document.getElementById('address').getAttribute('aria-invalid'), 'true');
      // The same test would fail the same way, so Connect waits for a change.
      assert.equal(button.disabled, true);
      type(pairing, 'address', '192.168.1.51');
      assert.equal(button.disabled, false);
      assert.equal(errorBox(pairing), '');
      assert.deepEqual(pairing.created, []);
      assert.equal(pairing.done, 0);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view does not blame the address for the wrong driver`, async () => {
    const pairing = await showPairingView(driver, { ok: false, code: 'platform', message: 'pair.test.notEda' });
    try {
      type(pairing, 'address', '192.168.1.50');
      pairing.document.getElementById('connect').click();
      await until(() => errorBox(pairing) !== '', 'the test message');
      assert.equal(pairing.document.getElementById('address').getAttribute('aria-invalid'), null);
      assert.equal(addAnyway(pairing), null);
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view asks for certainty before adding something that is not an Exvent unit`, async () => {
    const pairing = await showPairingView(driver, { ok: false, code: 'notExvent', message: 'pair.test.notExvent' });
    try {
      type(pairing, 'address', '192.168.1.50');
      pairing.document.getElementById('connect').click();
      await until(() => addAnyway(pairing) !== null, 'the Add anyway button');
      assert.equal(progressBox(pairing), 'pair.test.notExvent');
      assert.equal(pairing.document.getElementById('add-anyway-hint').textContent, 'pair.addOnlyIfSure');
    } finally {
      pairing.window.close();
    }
  });

  test(`${driver} pairing view shows a plain message when Homey cannot add the device`, async () => {
    const pairing = await showPairingView(driver, { ok: true });
    try {
      pairing.window.Homey.addDevice = (data: any, callback: (error: Error) => void) => callback(new Error('ECONNRESET internal'));
      type(pairing, 'address', '192.168.1.50');
      pairing.document.getElementById('connect').click();
      await until(() => errorBox(pairing) !== '', 'the error message');
      assert.equal(errorBox(pairing), 'pair.addFailed');
      assert.equal(pairing.done, 0);
    } finally {
      pairing.window.close();
    }
  });
}

import Homey from 'homey';

class MyExventApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyExventApp has been initialized');
  }

}

module.exports = MyExventApp;

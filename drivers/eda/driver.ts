import Homey from 'homey';

class MyEdaDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyEdaDriver has been initialized');
  }

}

module.exports = MyEdaDriver;

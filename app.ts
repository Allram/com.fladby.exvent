import Homey from 'homey';


class MyExventApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // Start debuger
if (process.env.DEBUG === '1'){
  try{ 
    require('inspector').waitForDebugger();
  }
  catch(error){
    require('inspector').open(9225, '0.0.0.0', true);
  }
}
    this.log('MyExventApp has been initialized');
  }

}

module.exports = MyExventApp;

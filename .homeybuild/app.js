'use strict';

const Homey = require('homey');

class FerroampControlApp extends Homey.App {
  
  async onInit() {
    this.log('Ferroamp Control has been initialized');
    this.log('All Flow Cards registered');
  }
}

module.exports = FerroampControlApp;

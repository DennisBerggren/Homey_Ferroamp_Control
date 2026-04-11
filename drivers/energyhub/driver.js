'use strict';

const { Driver } = require('homey');
const FerroampAPI = require('../../ferroamp-homey-api.js');

class EnergyHubDriver extends Driver {

  async onInit() {
    this.log('EnergyHub Driver has been initialized');
  }

  async onPair(session) {
    let credentials = {
      systemId: '',
      email: '',
      password: ''
    };

    // Hantera login från custom view
    session.setHandler('login', async (data) => {
      try {
        this.log('Login attempt for system:', data.systemId);
        
        credentials = {
          systemId: parseInt(data.systemId),
          email: data.email,
          password: data.password
        };
        
        // Testa login
        const api = new FerroampAPI(credentials.systemId, credentials.email, credentials.password);
        await api.login();
        
        this.log('✅ Login successful!');
        return true;
        
      } catch (error) {
        this.error('❌ Login failed:', error.message);
        throw new Error('Login failed. Please check your credentials.');
      }
    });

    // Returnera device efter lyckad login
    session.setHandler('list_devices', async () => {
      return [
        {
          name: `Ferroamp EnergyHub (${credentials.systemId})`,
          data: {
            id: `ferroamp_${credentials.systemId}`
          },
          store: credentials
        }
      ];
    });
  }
}

module.exports = EnergyHubDriver;


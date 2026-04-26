'use strict';

const { Device } = require('homey');
const FerroampAPI = require('../../ferroamp-homey-api.js');

class EnergyHubDevice extends Device {

  async onInit() {
    this.log('EnergyHub Device has been initialized');
    
    const store = this.getStore();
    this.log('Device store:', {
      systemId: store.systemId,
      email: store.email,
      hasPassword: !!store.password
    });
    
    // Initiera API
    await this.initializeAPI();
    
    // Registrera flow card actions
    this.registerFlowCardActions();

    // Starta polling av live-data (SOC + solar var 60:e sekund)
    await this.pollStatus();
    this._pollInterval = this.homey.setInterval(() => this.pollStatus(), 60 * 1000);

    // Starta SSE-ström för realtids grid/consumption/battery
    await this.startStream();
    
    this.log('Device ready!');
  }

  async initializeAPI() {
    try {
      const store = this.getStore();
      
      this.api = new FerroampAPI(
        store.systemId,
        store.email,
        store.password
      );
      
      // Försök återanvända sparade tokens
      const savedTokens = this.getStoreValue('tokens');
      if (savedTokens) {
        this.log('📦 Found saved tokens, attempting to reuse...');
        this.api.accessToken = savedTokens.accessToken;
        this.api.refreshToken = savedTokens.refreshToken;
        this.api.tokenExpiry = savedTokens.tokenExpiry;
        
        try {
          await this.api.getConfig();
          this.log('✅ Saved tokens work! Skipping login.');
          return;
        } catch (error) {
          this.log('⚠️ Saved tokens expired, will login...');
        }
      }
      
      // Login
      this.log('📭 No valid tokens, logging in...');
      await this.api.login();
      
      // Spara tokens
      await this.setStoreValue('tokens', {
        accessToken: this.api.accessToken,
        refreshToken: this.api.refreshToken,
        tokenExpiry: this.api.tokenExpiry
      });
      
      this.log('✅ Successfully connected to Ferroamp!');
      
      // Callback för token-förnyelse
      this.api.on_token_refreshed = async (accessToken, refreshToken, tokenExpiry) => {
        this.log('🔄 Tokens refreshed, saving...');
        await this.setStoreValue('tokens', {
          accessToken,
          refreshToken,
          tokenExpiry
        });
      };
      
    } catch (error) {
      this.error('❌ Failed to initialize API:', error.message);
      throw error;
    }
  }

  async pollStatus() {
    try {
      const s = await this.api.getStatus();

      if (s.soc != null)         await this.setCapabilityValue('measure_battery', s.soc);
      if (s.solar != null)       await this.setCapabilityValue('measure_power.solar', s.solar);
      if (s.grid != null)        await this.setCapabilityValue('measure_power.grid', s.grid);
      if (s.battery != null)     await this.setCapabilityValue('measure_power.battery', s.battery);
      if (s.consumption != null) await this.setCapabilityValue('measure_power.consumption', s.consumption);

      this.log(`📊 SOC=${s.soc}% Solar=${s.solar}W Grid=${s.grid}W Battery=${s.battery}W Consumption=${s.consumption}W`);
    } catch (error) {
      this.error('⚠️ pollStatus failed:', error.message);
      // Inte fatalt — försöker igen vid nästa intervall
    }
  }

  registerFlowCardActions() {
    // CHARGE BATTERY
    this.homey.flow.getActionCard('charge_battery')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        
        try {
          this.log(`🔋 Charging battery: ${args.watts}W`);
          await this.api.setBatteryPower(0, args.watts);
          this.log(`✅ Battery charging: ${args.watts}W`);
          return true;
        } catch (error) {
          this.error('❌ Failed to charge battery:', error.message);
          throw new Error(`Failed to charge battery: ${error.message}`);
        }
      });
    
    // DISCHARGE BATTERY
    this.homey.flow.getActionCard('discharge_battery')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log(`🔋 Discharging battery: ${args.watts}W`);
          await this.api.setBatteryPower(args.watts, 0);
          this.log(`✅ Battery discharging: ${args.watts}W`);
          return true;
        } catch (error) {
          this.error('❌ Failed to discharge battery:', error.message);
          throw new Error(`Failed to discharge battery: ${error.message}`);
        }
      });

    // SET SELF-CONSUMPTION
    this.homey.flow.getActionCard('set_self_consumption')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log('☀️ Setting Self-Consumption mode');
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          payload.mode = 3;
          payload.grid.thresholds.high = 0;
          payload.grid.thresholds.low = 0;
          if (args.discharge_reference != null) payload.battery.powerRef.discharge = args.discharge_reference;
          if (args.charge_reference != null) payload.battery.powerRef.charge = args.charge_reference;
          if (args.soc_lower != null) payload.battery.socRef.low = args.soc_lower;
          if (args.soc_upper != null) payload.battery.socRef.high = args.soc_upper;
          await this.api.setConfig(payload);
          this.log('✅ Self-Consumption mode set');
          return true;
        } catch (error) {
          this.error('❌ Failed to set Self-Consumption:', error.message);
          throw new Error(`Failed to set Self-Consumption: ${error.message}`);
        }
      });

    // SET PEAK SHAVING
    this.homey.flow.getActionCard('set_peak_shaving')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log('📊 Setting Peak Shaving mode');
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          payload.mode = 2;
          if (args.import_threshold != null) payload.grid.thresholds.high = args.import_threshold;
          if (args.export_threshold != null) payload.grid.thresholds.low = args.export_threshold;
          if (args.discharge_reference != null) payload.battery.powerRef.discharge = args.discharge_reference;
          if (args.charge_reference != null) payload.battery.powerRef.charge = args.charge_reference;
          if (args.soc_lower != null) payload.battery.socRef.low = args.soc_lower;
          if (args.soc_upper != null) payload.battery.socRef.high = args.soc_upper;
          await this.api.setConfig(payload);
          this.log('✅ Peak Shaving mode set');
          return true;
        } catch (error) {
          this.error('❌ Failed to set Peak Shaving:', error.message);
          throw new Error(`Failed to set Peak Shaving: ${error.message}`);
        }
      });

    // SOLAR PRODUCTION ON/OFF
    this.homey.flow.getActionCard('set_solar_production')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log(`🌞 Solar Production: ${args.enabled}`);
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          payload.pv.mode = args.enabled === 'true' ? 1 : 0;
          await this.api.setConfig(payload);
          this.log(`✅ Solar Production set to: ${args.enabled}`);
          return true;
        } catch (error) {
          this.error('❌ Failed to set Solar Production:', error.message);
          throw new Error(`Failed to set Solar Production: ${error.message}`);
        }
      });

    // LIMIT IMPORT (Use only Solar for EV charging)
    this.homey.flow.getActionCard('set_limit_import')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log(`🚗 Limit Import for EV: ${args.enabled}`);
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          payload.grid.limitImport = args.enabled === 'true';
          await this.api.setConfig(payload);
          this.log(`✅ Limit Import set to: ${args.enabled}`);
          return true;
        } catch (error) {
          this.error('❌ Failed to set Limit Import:', error.message);
          throw new Error(`Failed to set Limit Import: ${error.message}`);
        }
      });

    // LIMIT EXPORT OF SOLAR PRODUCTION
    this.homey.flow.getActionCard('set_limit_export')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        try {
          this.log(`📤 Limit Export: ${args.enabled}`);
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          payload.grid.limitExport = args.enabled === 'true';
          await this.api.setConfig(payload);
          this.log(`✅ Limit Export set to: ${args.enabled}`);
          return true;
        } catch (error) {
          this.error('❌ Failed to set Limit Export:', error.message);
          throw new Error(`Failed to set Limit Export: ${error.message}`);
        }
      });

    // HEMS MODE
    this.homey.flow.getActionCard('hems_mode')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;

        const cmd = (args.command || '').toLowerCase().trim();
        const power = args.power || 0;

        this.log(`🤖 HEMS command: "${cmd}", power: ${power}W`);

        // unchanged = do nothing
        if (cmd === 'unchanged') {
          this.log('⏭️ HEMS: unchanged, skipping');
          return true;
        }

        try {
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;

          if (cmd === 'charge') {
            // Manual, charge battery with HEMS power
            payload.mode = 1;
            payload.battery.powerRef.charge = power;
            payload.battery.powerRef.discharge = 0;
            payload.grid.limitExport = false;
            this.log(`⚡ HEMS: Charge ${power}W`);

          } else if (cmd === 'export') {
            // Manual, discharge battery with HEMS power
            payload.mode = 1;
            payload.battery.powerRef.discharge = power;
            payload.battery.powerRef.charge = 0;
            payload.grid.limitExport = false;
            this.log(`🔋 HEMS: Export/Discharge ${power}W`);

          } else if (cmd === 'selfconsumption' || cmd === 'chargesolar') {
            // Self-Consumption, max charge and discharge
            payload.mode = 3;
            payload.grid.thresholds.high = 0;
            payload.grid.thresholds.low = 0;
            payload.battery.powerRef.charge = 12000;
            payload.battery.powerRef.discharge = 12000;
            payload.grid.limitExport = false;
            this.log(`☀️ HEMS: Self-Consumption (${cmd})`);

          } else if (cmd === 'sellsolar') {
            // Self-Consumption, discharge only (no charging into battery)
            payload.mode = 3;
            payload.grid.thresholds.high = 0;
            payload.grid.thresholds.low = 0;
            payload.battery.powerRef.charge = 0;
            payload.battery.powerRef.discharge = 12000;
            payload.grid.limitExport = false;
            this.log(`🌞 HEMS: Sell Solar`);

          } else if (cmd === 'pause') {
            // Manual, battery off
            payload.mode = 1;
            payload.battery.powerRef.charge = 0;
            payload.battery.powerRef.discharge = 0;
            payload.grid.limitExport = false;
            this.log(`⏸️ HEMS: Pause (battery off)`);

          } else if (cmd === 'peakshaving') {
            // Peak Shaving, discharge threshold from HEMS power, charge threshold 0
            payload.mode = 2;
            payload.grid.thresholds.high = power;
            payload.grid.thresholds.low = 0;
            payload.battery.powerRef.charge = 12000;
            payload.battery.powerRef.discharge = 12000;
            payload.grid.limitExport = false;
            this.log(`📊 HEMS: Peak Shaving, discharge threshold ${power}W`);

          } else if (cmd === 'zeroexport') {
            // Self-Consumption + limit export on
            payload.mode = 3;
            payload.grid.thresholds.high = 0;
            payload.grid.thresholds.low = 0;
            payload.battery.powerRef.charge = 12000;
            payload.battery.powerRef.discharge = 12000;
            payload.grid.limitExport = true;
            this.log(`🚫 HEMS: Zero Export`);

          } else {
            this.log(`⚠️ HEMS: Unknown command "${cmd}", ignoring`);
            return true;
          }

          await this.api.setConfig(payload);
          this.log(`✅ HEMS mode applied: ${cmd}`);
          return true;

        } catch (error) {
          this.error('❌ HEMS mode failed:', error.message);
          throw new Error(`HEMS mode failed: ${error.message}`);
        }
      });

    // CONFIGURE FERROAMP
    this.homey.flow.getActionCard('configure_ferroamp')
      .registerRunListener(async (args) => {
        if (args.device.getData().id !== this.getData().id) return;
        
        try {
          this.log('🔧 Configure Ferroamp triggered');
          
          const config = await this.api.getConfig();
          const payload = config.emsConfig.data;
          
          // OPERATION MODE
          if (args.operation_mode && args.operation_mode !== 'keep') {
            switch (args.operation_mode) {
              case 'default': payload.mode = 1; break;
              case 'peak_shaving': payload.mode = 2; break;
              case 'self_consumption': payload.mode = 3; break;
            }
          }
          
          // BATTERY MODE (Default only)
          if (payload.mode === 1 && args.battery_mode && args.battery_mode !== 'keep') {
            switch (args.battery_mode) {
              case 'off':
                payload.battery.powerRef.discharge = 0;
                payload.battery.powerRef.charge = 0;
                break;
              case 'charge':
                payload.battery.powerRef.discharge = 0;
                break;
              case 'discharge':
                payload.battery.powerRef.charge = 0;
                break;
            }
          }
          
          // PV
          if (args.pv_enabled && args.pv_enabled !== 'keep') {
            payload.pv.mode = args.pv_enabled === 'true' ? 1 : 0;
          }
          
          // ACE
          if (args.ace_enabled && args.ace_enabled !== 'keep') {
            payload.grid.ace.mode = args.ace_enabled === 'true' ? 1 : 0;
          }
          if (args.ace_threshold != null) {
            payload.grid.ace.threshold = args.ace_threshold;
          }
          
          // GRID LIMITS
          if (args.limit_import && args.limit_import !== 'keep') {
            payload.grid.limitImport = args.limit_import === 'true';
          }
          if (args.limit_export && args.limit_export !== 'keep') {
            payload.grid.limitExport = args.limit_export === 'true';
          }
          
          // THRESHOLDS
          if (payload.mode === 2) {
            if (args.discharge_threshold != null) payload.grid.thresholds.high = args.discharge_threshold;
            if (args.charge_threshold != null) payload.grid.thresholds.low = args.charge_threshold;
          } else {
            if (args.import_threshold != null) payload.grid.thresholds.high = args.import_threshold;
            if (args.export_threshold != null) payload.grid.thresholds.low = args.export_threshold;
          }
          
          // BATTERY REFERENCES
          if (args.discharge_reference != null) payload.battery.powerRef.discharge = args.discharge_reference;
          if (args.charge_reference != null) payload.battery.powerRef.charge = args.charge_reference;
          
          // SOC
          if (args.soc_lower != null) payload.battery.socRef.low = args.soc_lower;
          if (args.soc_upper != null) payload.battery.socRef.high = args.soc_upper;
          
          // SEND
          await this.api.setConfig(payload);
          this.log('✅ Configuration updated!');
          return true;
          
        } catch (error) {
          this.error('❌ Failed to configure:', error.message);
          throw new Error(`Failed to configure: ${error.message}`);
        }
      });
  }

  async startStream() {
    const store = this.getStore();
    try {
      this._stopStream = await this.api.startPowerStream(
        store.systemId,
        async (d) => {
          // SSE-data i kW — konvertera till W
          const grid    = d.gridPower    != null ? Math.round(d.gridPower    * 1000) : null;
          const consumption = d.loadPower != null ? Math.round(d.loadPower   * 1000) : null;
          const battery = d.batteryPower != null ? Math.round(-d.batteryPower * 1000) : null;
          const solar   = d.pvPower      != null ? Math.round(d.pvPower      * 1000) : null;

          if (grid != null)        await this.setCapabilityValue('measure_power.grid', grid).catch(() => {});
          if (consumption != null) await this.setCapabilityValue('measure_power.consumption', consumption).catch(() => {});
          if (battery != null)     await this.setCapabilityValue('measure_power.battery', battery).catch(() => {});
          if (solar != null)       await this.setCapabilityValue('measure_power.solar', solar).catch(() => {});
        },
        async (err) => {
          this.error('⚠️ SSE stream error:', err.message);
          // Försök reconnecta efter 30 sekunder
          this.homey.setTimeout(() => this.startStream(), 30 * 1000);
        }
      );
      this.log('📡 SSE stream started');
    } catch (err) {
      this.error('⚠️ Could not start SSE stream:', err.message);
      // Försök igen efter 60 sekunder
      this.homey.setTimeout(() => this.startStream(), 60 * 1000);
    }
  }

  async onDeleted() {
    this.log('Device has been deleted');
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    if (this._stopStream) this._stopStream();
  }
}

module.exports = EnergyHubDevice;

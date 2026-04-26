/**
 * Ferroamp API Client for Homey - Token Persistent Version
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

class FerroampAPI {
    constructor(systemId, email, password) {
        this.systemId = systemId;
        this.email = email;
        this.password = password;
        
        this.authBaseUrl = 'https://auth.eu.prod.ferroamp.com/realms/public/protocol/openid-connect';
        this.portalBaseUrl = 'https://portal.ferroamp.com';
        this.clientId = 'portal-frontend-ng-production';
        
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
        this.cookies = {};
        
        // Callback för när tokens förnyas
        this.on_token_refreshed = null;
    }

    generatePKCE() {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256')
            .update(verifier)
            .digest('base64url');
        return { verifier, challenge };
    }

    async login() {
        try {
            console.log('--- Starting Ferroamp login process (Persistent Version) ---');
            this.cookies = {}; // Rensa sessionen
            
            const pkce = this.generatePKCE();
            const state = crypto.randomBytes(16).toString('hex');
            const nonce = crypto.randomBytes(16).toString('hex');
            
            const authUrl = `${this.authBaseUrl}/auth?` + new URLSearchParams({
                client_id: this.clientId,
                redirect_uri: `${this.portalBaseUrl}/en/callback`,
                response_type: 'code',
                scope: 'openid',
                state: state,
                nonce: nonce,
                code_challenge: pkce.challenge,
                code_challenge_method: 'S256'
            });

            const commonHeaders = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
            };

            // 1. Hämta inloggningssidan
            const authResponse = await fetch(authUrl, {
                method: 'GET',
                headers: commonHeaders,
                redirect: 'manual'
            });
            
            this.extractCookies(authResponse);
            const authHtml = await authResponse.text();
            
            const actionMatch = authHtml.match(/action="([^"]+)"/);
            if (!actionMatch) throw new Error('Could not find login form action');
            const rawAction = actionMatch[1].replace(/&amp;/g, '&');
            const actionUrl = new URL(rawAction, authResponse.url).toString();

            // 2. Parse and include all form inputs (hidden fields like execution, client_id etc.)
            const formData = new URLSearchParams();
            const inputRe = /<input[^>]*name="([^"]+)"(?:[^>]*value="([^"]*)")?/g;
            let m;
            while ((m = inputRe.exec(authHtml)) !== null) {
                const name = m[1];
                const value = typeof m[2] === 'undefined' ? '' : m[2];
                formData.append(name, value);
            }
            // Override with credentials
            formData.set('username', this.email);
            formData.set('password', this.password);

            const loginResponse = await fetch(actionUrl, {
                method: 'POST',
                headers: {
                    ...commonHeaders,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': this.getCookieHeader(),
                    'Referer': authUrl,
                    'Origin': new URL(this.authBaseUrl).origin
                },
                body: formData.toString(),
                redirect: 'manual'
            });

            this.extractCookies(loginResponse);
            const redirectUrl = loginResponse.headers.get('location');
            console.log('Step 3 Status:', loginResponse.status);

            if (![302, 303].includes(loginResponse.status) || !redirectUrl) {
                throw new Error(`Login failed (Status: ${loginResponse.status}). Wait a while before retry.`);
            }

            // 3. Fånga koden
            const codeMatch = redirectUrl.match(/[?&#]code=([^&]+)/);
            let authCode = codeMatch ? codeMatch[1] : null;

            if (!authCode) {
                const codeResponse = await fetch(redirectUrl, {
                    method: 'GET',
                    headers: { ...commonHeaders, 'Cookie': this.getCookieHeader() },
                    redirect: 'manual'
                });
                const finalLoc = codeResponse.headers.get('location') || redirectUrl;
                const finalMatch = finalLoc.match(/[?&#]code=([^&]+)/);
                if (finalMatch) authCode = finalMatch[1];
            }

            if (!authCode) throw new Error('Could not find authorization code');

            // 4. Byt kod mot tokens
            const tokenData = new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: this.clientId,
                redirect_uri: `${this.portalBaseUrl}/en/callback`,
                code: authCode,
                code_verifier: pkce.verifier
            });

            const tokenResponse = await fetch(`${this.authBaseUrl}/token`, {
                method: 'POST',
                headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenData.toString()
            });

            const tokens = await tokenResponse.json();
            this.accessToken = tokens.access_token;
            this.refreshToken = tokens.refresh_token;
            this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);

            console.log('--- ✅ Login Successful! ---');
            return true;

        } catch (error) {
            console.error('Login error:', error.message);
            throw error;
        }
    }

    async ensureValidToken() {
        if (!this.accessToken || Date.now() >= this.tokenExpiry - 30000) {
            if (this.refreshToken) await this.refreshAccessToken();
            else await this.login();
        }
    }

    async refreshAccessToken() {
        try {
            console.log('🔄 Refreshing access token...');
            const tokenData = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.clientId,
                refresh_token: this.refreshToken
            });
            const response = await fetch(`${this.authBaseUrl}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenData.toString()
            });
            if (response.ok) {
                const tokens = await response.json();
                this.accessToken = tokens.access_token;
                this.refreshToken = tokens.refresh_token;
                this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
                
                // Notify app that tokens were refreshed
                if (this.on_token_refreshed) {
                    this.on_token_refreshed(this.accessToken, this.refreshToken, this.tokenExpiry);
                }
                
                console.log('✅ Token refreshed successfully!');
            } else {
                console.log('⚠️ Token refresh failed, logging in again...');
                await this.login();
            }
        } catch (e) { 
            console.log('⚠️ Token refresh error, logging in again...');
            await this.login(); 
        }
    }

    async getStatus() {
        await this.ensureValidToken();
        // Portal dashboard endpoint — returnerar last_ui, esos (SOC), ssos (PV-strängar)
        const url = `https://api.eu.prod.ferroamp.com/settings/topology/get?facility_id=${this.systemId}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        if (!response.ok) throw new Error(`getStatus HTTP ${response.status}`);
        const data = await response.json();

        const ui = data.last_ui || {};

        // SOC: medelvärde av alla ESO-enheter
        const esoEntries = Object.values(data.esos || {});
        const socValues = esoEntries.map(e => e.last?.soc).filter(v => v != null);
        const soc = socValues.length > 0
            ? Math.round(socValues.reduce((a, b) => a + b, 0) / socValues.length)
            : null;

        // Solproduktion: summa av PV-strängar
        const ssoEntries = Object.values(data.ssos || {});
        const solar = Math.round(ssoEntries.length > 0
            ? ssoEntries.reduce((sum, s) => sum + (s.last?.p ?? 0), 0)
            : (ui.pvPower?.val ?? 0));

        // Förbrukning: summa av pLoadQ1+Q2+Q3 om last_ui är färsk, annars okänd
        // pLoadQ = aktiv lasteffekt per fas (Q = quadrature/active i Ferroamps nomenklatur)
        const consumption = Math.round(
            (ui.pLoadQ1?.val ?? 0) + (ui.pLoadQ2?.val ?? 0) + (ui.pLoadQ3?.val ?? 0)
        );

        // Batteri: beräknas från ESO-enheternas ström × spänning
        // Negativt i = laddar batteri (ström flödar in), positivt = laddar ur
        // Vi vänder: positivt = laddar, negativt = laddar ur
        const batteryRaw = esoEntries.reduce((sum, e) => {
            const i = e.last?.i ?? 0;
            const u = e.last?.u ?? 0;
            return sum + (i * u);
        }, 0);
        const battery = Math.round(-batteryRaw);

        // Grid: energibalans — Solar - Consumption - (-battery) = Grid export
        // battery är nu positivt vid laddning (tar från solceller)
        // Grid (negativt = export, positivt = import)
        const grid = Math.round(consumption + battery - solar);

        return { soc, solar, grid, battery, consumption };
    }

    async getConfig() {
        await this.ensureValidToken();
        const url = `${this.portalBaseUrl}/service/ems-config/v1/current/${this.systemId}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    }

    async setConfig(payload) {
        await this.ensureValidToken();
        const url = `${this.portalBaseUrl}/service/ems-config/v1/commands/set/${this.systemId}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.accessToken}`
            },
            body: JSON.stringify({ payload })
        });
        return response.status === 201 || (await response.text()) === 'Created';
    }

    async setBatteryPower(discharge, charge) {
        const config = await this.getConfig();
        const payload = config.emsConfig.data;
        payload.mode = 1; // Default mode för manuell styrning
        payload.battery.powerRef.discharge = discharge;
        payload.battery.powerRef.charge = charge;
        return await this.setConfig(payload);
    }

    extractCookies(response) {
        // Prefer raw() when available (node-fetch provides an array of set-cookie headers)
        try {
            const raw = (response.headers && typeof response.headers.raw === 'function') ? response.headers.raw() : null;
            const setCookies = raw && raw['set-cookie'] ? raw['set-cookie'] : (response.headers.get && response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
            setCookies.forEach(cookieStr => {
                const firstPart = cookieStr.split(';')[0];
                const idx = firstPart.indexOf('=');
                if (idx > 0) {
                    const name = firstPart.substring(0, idx).trim();
                    const value = firstPart.substring(idx + 1).trim();
                    this.cookies[name] = value;
                }
            });
        } catch (e) {
            // Fallback to previous naive parsing
            const setCookie = response.headers.get && response.headers.get('set-cookie');
            if (setCookie) {
                const cookies = setCookie.split(/,(?=[^;]*=)/);
                cookies.forEach(cookie => {
                    const parts = cookie.split(';')[0].split('=');
                    if (parts.length === 2) this.cookies[parts[0].trim()] = parts[1].trim();
                });
            }
        }
    }

    getCookieHeader() {
        return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

module.exports = FerroampAPI;

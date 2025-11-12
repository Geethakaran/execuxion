/**
 * SecureStore - HMAC-Protected Electron Store
 *
 * Wraps electron-store to add HMAC integrity verification.
 * Detects tampering of encrypted data on disk.
 *
 * Architecture:
 * - Data format: { data: <actualValue>, hmac: <hmacHash> }
 * - HMAC computed over JSON-serialized data using encryption key
 * - Read operations verify HMAC before returning data
 * - Write operations wrap data with HMAC before storing
 * - Migration support for existing data without HMAC
 *
 * Security Properties:
 * - Encryption: Provided by electron-store's built-in encryption
 * - Integrity: HMAC-SHA256 ensures data hasn't been modified
 * - Key Derivation: Uses SHA256 of encryption key for HMAC
 */

import Store from 'electron-store';
import HmacSHA256 from 'crypto-js/hmac-sha256';
import SHA256 from 'crypto-js/sha256';

class SecureStore {
  constructor(options) {
    this.innerStore = new Store(options);
    this.encryptionKey = options.encryptionKey;
    this.name = options.name || 'store';

    // Migration flag - set to true after first successful migration
    this._migrated = false;

    console.log(`[SecureStore] Initialized: ${this.name}`);
  }

  /**
   * Compute HMAC for a value
   * @private
   */
  _computeHmac(value) {
    // Serialize value deterministically
    const serialized = JSON.stringify(value);

    // HMAC using SHA256-derived key (same pattern as credentialUtil.js)
    const hmac = HmacSHA256(serialized, SHA256(this.encryptionKey)).toString();

    return hmac;
  }

  /**
   * Check if a value is already HMAC-wrapped
   * @private
   */
  _isHmacWrapped(value) {
    return (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'data' in value &&
      'hmac' in value &&
      typeof value.hmac === 'string' &&
      value.hmac.length === 64 // SHA256 hex length
    );
  }

  /**
   * Wrap value with HMAC
   * @private
   */
  _wrapWithHmac(value) {
    // Already wrapped? Return as-is to avoid double-wrapping
    if (this._isHmacWrapped(value)) {
      return value;
    }

    return {
      data: value,
      hmac: this._computeHmac(value),
      _v: 1 // Version marker for future format changes
    };
  }

  /**
   * Verify and unwrap value
   * @private
   * @throws {Error} If HMAC verification fails
   */
  _unwrapWithHmac(wrapped, key) {
    // Not wrapped? Return as-is (for backwards compatibility during migration)
    if (!this._isHmacWrapped(wrapped)) {
      return wrapped;
    }

    const { data, hmac } = wrapped;
    const expectedHmac = this._computeHmac(data);

    if (hmac !== expectedHmac) {
      console.error(`[SecureStore] ❌ HMAC VERIFICATION FAILED for key: ${key}`);
      console.error(`[SecureStore] Expected HMAC: ${expectedHmac.substring(0, 16)}...`);
      console.error(`[SecureStore] Actual HMAC:   ${hmac.substring(0, 16)}...`);
      throw new Error(`HMAC verification failed for key: ${key}. Data may be tampered or corrupted.`);
    }

    return data;
  }

  /**
   * Migrate a single key from unwrapped to HMAC-wrapped format
   * @private
   */
  _migrateKey(key) {
    try {
      const rawValue = this.innerStore.get(key);

      // Skip if undefined or already wrapped
      if (rawValue === undefined || this._isHmacWrapped(rawValue)) {
        return false;
      }

      // Wrap and save
      const wrapped = this._wrapWithHmac(rawValue);
      this.innerStore.set(key, wrapped);

      console.log(`[SecureStore] ✅ Migrated key: ${key}`);
      return true;
    } catch (error) {
      console.error(`[SecureStore] ❌ Failed to migrate key: ${key}`, error);
      return false;
    }
  }

  /**
   * Migrate all existing data to HMAC-wrapped format
   * @public
   */
  migrateToHmac() {
    if (this._migrated) {
      return { migrated: 0, skipped: 0, failed: 0 };
    }

    console.log('[SecureStore] 🔄 Checking for HMAC migration...');

    const allData = this.innerStore.store;
    const keys = Object.keys(allData);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    keys.forEach(key => {
      try {
        const value = allData[key];

        if (this._isHmacWrapped(value)) {
          skipped++;
        } else {
          const success = this._migrateKey(key);
          if (success) {
            migrated++;
          } else {
            failed++;
          }
        }
      } catch (error) {
        console.error(`[SecureStore] Migration error for key: ${key}`, error);
        failed++;
      }
    });

    this._migrated = true;

    console.log(`[SecureStore] ✅ Migration complete: ${migrated} migrated, ${skipped} already wrapped, ${failed} failed`);

    return { migrated, skipped, failed };
  }

  /**
   * Set a value in storage (with HMAC wrapping)
   * @public
   */
  set(key, value) {
    try {
      const wrapped = this._wrapWithHmac(value);
      this.innerStore.set(key, wrapped);
      return true;
    } catch (error) {
      console.error(`[SecureStore] ❌ Failed to set key: ${key}`, error);
      return false;
    }
  }

  /**
   * Get a value from storage (with HMAC verification)
   * @public
   */
  get(key, defaultValue) {
    try {
      const wrapped = this.innerStore.get(key);

      if (wrapped === undefined) {
        return defaultValue;
      }

      // Verify HMAC and unwrap
      const data = this._unwrapWithHmac(wrapped, key);
      return data;

    } catch (error) {
      // HMAC verification failed - data is corrupted or tampered
      console.error(`[SecureStore] ❌ HMAC verification failed for key: ${key}`);
      console.error(`[SecureStore] Returning default value for safety`);

      // Log incident for security monitoring
      this._logIntegrityFailure(key, error);

      // Return default value - DO NOT return corrupted data
      return defaultValue;
    }
  }

  /**
   * Get entire store (with HMAC verification for each key)
   * @public
   */
  get store() {
    const allData = this.innerStore.store;
    const verified = {};

    Object.entries(allData).forEach(([key, wrapped]) => {
      try {
        verified[key] = this._unwrapWithHmac(wrapped, key);
      } catch (error) {
        console.error(`[SecureStore] ❌ Skipping corrupted key: ${key}`);
        // Skip corrupted keys - do not include in output
      }
    });

    return verified;
  }

  /**
   * Delete a key from storage
   * @public
   */
  delete(key) {
    try {
      this.innerStore.delete(key);
      return true;
    } catch (error) {
      console.error(`[SecureStore] ❌ Failed to delete key: ${key}`, error);
      return false;
    }
  }

  /**
   * Clear all data from storage
   * @public
   */
  clear() {
    try {
      this.innerStore.clear();
      return true;
    } catch (error) {
      console.error('[SecureStore] ❌ Failed to clear store', error);
      return false;
    }
  }

  /**
   * Check if a key exists in storage
   * @public
   */
  has(key) {
    return this.innerStore.has(key);
  }

  /**
   * Log integrity failure for security monitoring
   * @private
   */
  _logIntegrityFailure(key, error) {
    // In production, this should alert administrators
    const incident = {
      timestamp: new Date().toISOString(),
      store: this.name,
      key,
      error: error.message,
      type: 'HMAC_VERIFICATION_FAILED'
    };

    console.error('[SecureStore] 🚨 SECURITY INCIDENT:', JSON.stringify(incident, null, 2));

    // TODO: Send to security monitoring system in production
    // e.g., send to SIEM, log aggregation service, etc.
  }
}

export default SecureStore;

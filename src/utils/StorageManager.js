/**
 * Production-Grade Storage Manager
 *
 * Provides enterprise-level storage operations with:
 * - Automatic retry with exponential backoff
 * - Backup system before critical writes
 * - Health checks and integrity validation
 * - Error notifications and detailed logging
 * - Data migration support
 *
 * CRITICAL: Use this instead of direct browser.storage.local calls for critical data
 */

import browser from '@/utils/browser-polyfill';

const MAX_RETRIES = 3;
const BACKUP_PREFIX = '__backup__';
const MIGRATION_VERSION_KEY = '__storage_version__';
const CURRENT_VERSION = '1.0.0';

/**
 * Storage Manager class for production-grade storage operations
 */
class StorageManager {
  constructor() {
    this.isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
    this.migrationHandlers = new Map();
    this._registerMigrations();
  }

  /**
   * Register data migration handlers
   * @private
   */
  _registerMigrations() {
    // Example: Version 1.0.0 - Initial version (no migration needed)
    this.migrationHandlers.set('1.0.0', (data) => data);

    // Future migrations can be added here:
    // this.migrationHandlers.set('1.1.0', (data) => {
    //   // Migrate workflows to new format
    //   return migratedData;
    // });
  }

  /**
   * Perform data migration if needed
   * @private
   */
  async _runMigrations() {
    try {
      const { [MIGRATION_VERSION_KEY]: currentVersion } = await browser.storage.local.get(MIGRATION_VERSION_KEY);

      if (!currentVersion || currentVersion === CURRENT_VERSION) {
        if (!currentVersion) {
          // First time setup
          await browser.storage.local.set({ [MIGRATION_VERSION_KEY]: CURRENT_VERSION });
          console.log('[StorageManager] 🔧 Storage version initialized:', CURRENT_VERSION);
        }
        return;
      }

      console.log('[StorageManager] 🔧 Migration needed:', currentVersion, '→', CURRENT_VERSION);

      // Get all data
      const allData = await browser.storage.local.get(null);

      // Apply migrations in order
      let migratedData = { ...allData };
      const versions = Array.from(this.migrationHandlers.keys()).sort();
      const startIndex = versions.indexOf(currentVersion) + 1;

      for (let i = startIndex; i < versions.length; i++) {
        const version = versions[i];
        const migrationFn = this.migrationHandlers.get(version);
        console.log(`[StorageManager] Applying migration ${version}...`);
        migratedData = migrationFn(migratedData);
      }

      // Save migrated data
      await browser.storage.local.set(migratedData);
      await browser.storage.local.set({ [MIGRATION_VERSION_KEY]: CURRENT_VERSION });

      console.log('[StorageManager] ✅ Migration complete:', CURRENT_VERSION);

    } catch (error) {
      console.error('[StorageManager] ❌ Migration failed:', error);
      throw new Error(`Migration failed: ${error.message}`);
    }
  }

  /**
   * Initialize storage manager and run migrations
   */
  async initialize() {
    console.log('[StorageManager] Initializing...');
    await this._runMigrations();
    console.log('[StorageManager] ✅ Ready');
  }

  /**
   * Create backup of data before critical write
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} Success status
   */
  async createBackup(key) {
    try {
      const { [key]: currentValue } = await browser.storage.local.get(key);

      if (currentValue !== undefined) {
        const backupKey = `${BACKUP_PREFIX}${key}`;
        const backup = {
          data: currentValue,
          timestamp: Date.now(),
          version: CURRENT_VERSION
        };

        await browser.storage.local.set({ [backupKey]: backup });
        console.log(`[StorageManager] 💾 Backup created for ${key}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[StorageManager] Failed to create backup for ${key}:`, error);
      return false;
    }
  }

  /**
   * Restore from backup
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} Success status
   */
  async restoreFromBackup(key) {
    try {
      const backupKey = `${BACKUP_PREFIX}${key}`;
      const { [backupKey]: backup } = await browser.storage.local.get(backupKey);

      if (backup && backup.data !== undefined) {
        await browser.storage.local.set({ [key]: backup.data });
        console.log(`[StorageManager] ✅ Restored ${key} from backup (${new Date(backup.timestamp).toISOString()})`);
        return true;
      }

      console.warn(`[StorageManager] No backup found for ${key}`);
      return false;
    } catch (error) {
      console.error(`[StorageManager] Failed to restore backup for ${key}:`, error);
      return false;
    }
  }

  /**
   * Get data with automatic retry
   * @param {string|string[]|Object} keys - Key(s) to retrieve
   * @returns {Promise<Object>} Retrieved data
   */
  async get(keys) {
    let retries = MAX_RETRIES;
    let lastError;

    while (retries > 0) {
      try {
        const result = await browser.storage.local.get(keys);
        return result;
      } catch (error) {
        lastError = error;
        retries--;

        if (retries > 0) {
          const backoffDelay = Math.pow(2, MAX_RETRIES - retries) * 100;
          console.warn(`[StorageManager] Read failed, retry ${MAX_RETRIES - retries}/${MAX_RETRIES} in ${backoffDelay}ms:`, error);
          await this._sleep(backoffDelay);
        }
      }
    }

    console.error(`[StorageManager] ❌ Read failed after ${MAX_RETRIES} attempts:`, lastError);
    throw lastError;
  }

  /**
   * Set data with automatic retry and backup
   * @param {Object} items - Key-value pairs to store
   * @param {Object} options - Options { backup: boolean, critical: boolean }
   * @returns {Promise<boolean>} Success status
   */
  async set(items, options = { backup: true, critical: false }) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Items must be a non-array object');
    }

    // Create backups for critical data
    if (options.backup || options.critical) {
      for (const key of Object.keys(items)) {
        if (key === 'workflows' || key === 'savedBlocks' || options.critical) {
          await this.createBackup(key);
        }
      }
    }

    let retries = MAX_RETRIES;
    let lastError;

    while (retries > 0) {
      try {
        await browser.storage.local.set(items);

        // Verify write for critical data
        if (options.critical) {
          const verification = await browser.storage.local.get(Object.keys(items));
          for (const [key, value] of Object.entries(items)) {
            if (JSON.stringify(verification[key]) !== JSON.stringify(value)) {
              throw new Error(`Write verification failed for ${key}`);
            }
          }
        }

        return true;

      } catch (error) {
        lastError = error;
        retries--;

        if (retries > 0) {
          const backoffDelay = Math.pow(2, MAX_RETRIES - retries) * 100;
          console.warn(`[StorageManager] Write failed, retry ${MAX_RETRIES - retries}/${MAX_RETRIES} in ${backoffDelay}ms:`, error);
          await this._sleep(backoffDelay);
        }
      }
    }

    // All retries failed - attempt rollback
    console.error(`[StorageManager] ❌ Write failed after ${MAX_RETRIES} attempts, attempting rollback:`, lastError);

    if (options.backup || options.critical) {
      for (const key of Object.keys(items)) {
        await this.restoreFromBackup(key);
      }
    }

    // Notify user
    this._notifyUser('Failed to save data. Please try again or restart the application.');

    throw lastError;
  }

  /**
   * Remove items with automatic retry
   * @param {string|string[]} keys - Key(s) to remove
   * @returns {Promise<boolean>} Success status
   */
  async remove(keys) {
    let retries = MAX_RETRIES;
    let lastError;

    while (retries > 0) {
      try {
        await browser.storage.local.remove(keys);
        return true;
      } catch (error) {
        lastError = error;
        retries--;

        if (retries > 0) {
          const backoffDelay = Math.pow(2, MAX_RETRIES - retries) * 100;
          console.warn(`[StorageManager] Remove failed, retry ${MAX_RETRIES - retries}/${MAX_RETRIES} in ${backoffDelay}ms:`, error);
          await this._sleep(backoffDelay);
        }
      }
    }

    console.error(`[StorageManager] ❌ Remove failed after ${MAX_RETRIES} attempts:`, lastError);
    throw lastError;
  }

  /**
   * Validate data integrity
   * @param {string} key - Storage key
   * @param {any} data - Data to validate
   * @returns {object} Validation result { valid: boolean, errors: string[] }
   */
  validateData(key, data) {
    const errors = [];

    try {
      JSON.stringify(data);
    } catch (e) {
      errors.push(`Not JSON serializable: ${e.message}`);
    }

    // Key-specific validation
    if (key === 'workflows') {
      if (typeof data !== 'object' || data === null) {
        errors.push('Workflows must be an object');
      } else {
        Object.entries(data).forEach(([id, workflow]) => {
          if (!workflow.id) errors.push(`Workflow ${id} missing id field`);
          if (!workflow.name) errors.push(`Workflow ${id} missing name field`);
          if (!workflow.drawflow) errors.push(`Workflow ${id} missing drawflow`);
        });
      }
    }

    if (key === 'savedBlocks') {
      if (!Array.isArray(data)) {
        errors.push('savedBlocks must be an array');
      } else {
        data.forEach((pkg, index) => {
          if (!pkg.id) errors.push(`Package at index ${index} missing id field`);
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Health check - verify storage is accessible
   * @returns {Promise<object>} Health status
   */
  async healthCheck() {
    try {
      const testKey = '__health_check__';
      const testValue = { timestamp: Date.now() };

      await browser.storage.local.set({ [testKey]: testValue });
      const { [testKey]: result } = await browser.storage.local.get(testKey);
      await browser.storage.local.remove(testKey);

      const isHealthy = JSON.stringify(result) === JSON.stringify(testValue);

      return {
        healthy: isHealthy,
        timestamp: Date.now(),
        message: isHealthy ? 'Storage is operational' : 'Storage read/write mismatch'
      };
    } catch (error) {
      return {
        healthy: false,
        timestamp: Date.now(),
        message: `Storage error: ${error.message}`,
        error: error
      };
    }
  }

  /**
   * Notify user of critical errors
   * @private
   */
  _notifyUser(message) {
    console.error('[StorageManager] 🚨 USER ALERT:', message);

    if (this.isElectron) {
      // In Electron, could use native notification or IPC to show dialog
      // For now, just log prominently
      console.error('═══════════════════════════════════════');
      console.error('CRITICAL ERROR:', message);
      console.error('═══════════════════════════════════════');
    } else {
      // In web, could show toast notification
      console.error('CRITICAL ERROR:', message);
    }
  }

  /**
   * Sleep utility for retry backoff
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get storage statistics
   * @returns {Promise<object>} Storage stats
   */
  async getStats() {
    try {
      const allData = await browser.storage.local.get(null);
      const keys = Object.keys(allData);
      const size = JSON.stringify(allData).length;

      const stats = {
        keyCount: keys.length,
        estimatedSize: size,
        estimatedSizeKB: (size / 1024).toFixed(2),
        estimatedSizeMB: (size / 1024 / 1024).toFixed(2),
        keys: keys.filter(k => !k.startsWith(BACKUP_PREFIX))
      };

      console.log('[StorageManager] 📊 Storage stats:', stats);
      return stats;
    } catch (error) {
      console.error('[StorageManager] Failed to get stats:', error);
      throw error;
    }
  }

  /**
   * Clear all backups
   * @returns {Promise<number>} Number of backups cleared
   */
  async clearBackups() {
    try {
      const allData = await browser.storage.local.get(null);
      const backupKeys = Object.keys(allData).filter(k => k.startsWith(BACKUP_PREFIX));

      if (backupKeys.length > 0) {
        await browser.storage.local.remove(backupKeys);
        console.log(`[StorageManager] 🧹 Cleared ${backupKeys.length} backups`);
      }

      return backupKeys.length;
    } catch (error) {
      console.error('[StorageManager] Failed to clear backups:', error);
      throw error;
    }
  }
}

// Export singleton instance
const storageManager = new StorageManager();

export default storageManager;

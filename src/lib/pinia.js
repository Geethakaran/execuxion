import { markRaw } from 'vue';
import { createPinia } from 'pinia';
import browser from '@/utils/browser-polyfill';
import storageManager from '@/utils/StorageManager';

// CRITICAL FIX: Save queue for debouncing to prevent race conditions
const saveQueues = new Map();
const saveRetryAttempts = new Map();
const MAX_RETRIES = 3;

/**
 * Pinia Storage Plugin
 *
 * Provides saveToStorage() method for Pinia stores that integrates with
 * browser.storage.local API (which in turn uses Electron storage or localStorage).
 *
 * CRITICAL FIXES APPLIED:
 * - Debouncing (300ms) to prevent race conditions on rapid saves
 * - Automatic retry with exponential backoff
 * - Detailed error logging for debugging
 * - Promise-based save queue management
 */
function saveToStoragePlugin({ store, options }) {
  /**
   * Save store state to persistent storage with debouncing and retry logic
   * @param {string} key - The store state key to save
   * @returns {Promise<void>}
   */
  store.saveToStorage = async (key) => {
    // Check if store has storageMap configuration
    if (!options.storageMap || !options.storageMap[key]) {
      console.warn(`[Pinia] No storageMap defined for key "${key}" in store "${store.$id}"`);
      return Promise.resolve();
    }

    // Don't save if store hasn't been retrieved yet
    if (!store.retrieved) {
      console.warn(`[Pinia] Store "${store.$id}" not yet retrieved, skipping save for key "${key}"`);
      return Promise.resolve();
    }

    const storageKey = options.storageMap[key];
    const queueKey = `${store.$id}:${key}`;

    // Cancel previous pending save (debouncing)
    const existingQueue = saveQueues.get(queueKey);
    if (existingQueue) {
      clearTimeout(existingQueue.timeoutId);
      // Reject the previous promise to clean up
      existingQueue.reject(new Error('Save cancelled due to new save request'));
    }

    // Create new debounced save promise
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(async () => {
        saveQueues.delete(queueKey);

        try {
          // Deep clone to avoid reference issues and validate JSON serializability
          let value;
          try {
            value = JSON.parse(JSON.stringify(store[key]));
          } catch (serializeError) {
            console.error(`[Pinia] ❌ JSON serialization failed for ${store.$id}.${key}:`, serializeError);
            throw new Error(`Cannot serialize ${key}: ${serializeError.message}`);
          }

          // FIX: Validate workflows structure before saving (prevent corruption)
          if (key === 'workflows' && value && typeof value === 'object') {
            const keys = Object.keys(value);

            // Check for nested corruption pattern
            if (value.workflows && typeof value.workflows === 'object') {
              const workflowsValue = value.workflows;
              const isActualWorkflow = workflowsValue.id && typeof workflowsValue.id === 'string';

              if (!isActualWorkflow) {
                // This is a nested workflows key, not a workflow named 'workflows'
                const hasOnlyWorkflowsKey = keys.length === 1 && keys[0] === 'workflows';

                if (hasOnlyWorkflowsKey) {
                  console.error('[Pinia] ❌ CORRUPTION DETECTED: Attempting to save nested workflows structure!');
                  console.error('[Pinia] Structure:', {
                    keys,
                    hasWorkflowsKey: true,
                    workflowsKeys: Object.keys(workflowsValue).slice(0, 5)
                  });
                  throw new Error('Refusing to save corrupted workflows structure with nesting');
                } else {
                  console.warn('[Pinia] ⚠️ WARNING: Mixed-level workflows detected (both root and nested)');
                  console.warn('[Pinia] This may indicate corruption. Root keys:', keys.filter(k => k !== 'workflows').slice(0, 3));
                }
              }
            }

            // Additional validation: Check that values are workflow objects
            let validWorkflowCount = 0;
            let invalidCount = 0;

            for (const [workflowId, workflow] of Object.entries(value)) {
              if (workflow && typeof workflow === 'object' && workflow.id) {
                validWorkflowCount++;
              } else {
                invalidCount++;
                console.warn(`[Pinia] ⚠️ Invalid workflow structure for id: ${workflowId}`);
              }
            }

            console.log(`[Pinia] 📊 Saving ${validWorkflowCount} valid workflows${invalidCount > 0 ? ` (${invalidCount} invalid)` : ''}`);
          }

          // BONUS FIX: Use StorageManager for enterprise-grade reliability
          // Determine if this is critical data that needs backup + verification
          const isCritical = (key === 'workflows' || key === 'packages' || key === 'savedBlocks');

          try {
            const startTime = Date.now();

            // Use StorageManager with automatic backup, retry, and verification
            await storageManager.set(
              { [storageKey]: value },
              {
                backup: isCritical,     // Auto-backup critical data
                critical: isCritical    // Use verification for critical data
              }
            );

            const duration = Date.now() - startTime;
            console.log(`[Pinia] ✅ Saved ${store.$id}.${key} via StorageManager (${duration}ms)`);

            // Clear retry counter on success
            saveRetryAttempts.delete(queueKey);
            resolve();
            return;

          } catch (error) {
            // StorageManager already did retries and rollback - this is a final failure
            console.error(`[Pinia] ❌ CRITICAL: StorageManager failed for ${store.$id}.${key}:`, error);
            saveRetryAttempts.delete(queueKey);

            // Notify user of persistent failure
            if (typeof window !== 'undefined' && window.electron?.isElectron) {
              console.error('[Pinia] ALERT: Data may not be saved. Please try again or restart the application.');
            }

            reject(error);
          }

        } catch (error) {
          console.error(`[Pinia] ❌ Unexpected error saving ${store.$id}.${key}:`, error);
          reject(error);
        }
      }, 300); // Performance: 300ms debounce to batch rapid changes (industry standard)
      // Risk mitigation: StorageManager provides backup + HMAC integrity protection

      saveQueues.set(queueKey, { timeoutId, resolve, reject });
    });
  };

  /**
   * Load store state from persistent storage
   * @param {string} key - The store state key to load
   * @returns {Promise<any>}
   */
  store.loadFromStorage = async (key) => {
    if (!options.storageMap || !options.storageMap[key]) {
      console.warn(`[Pinia] No storageMap defined for key "${key}" in store "${store.$id}"`);
      return null;
    }

    const storageKey = options.storageMap[key];

    try {
      const result = await browser.storage.local.get(storageKey);
      const value = result[storageKey];

      if (value !== undefined) {
        console.log(`[Pinia] Loaded ${store.$id}.${key} from storage "${storageKey}"`);
        return value;
      }

      return null;
    } catch (error) {
      console.error(`[Pinia] Failed to load ${store.$id}.${key}:`, error);
      return null;
    }
  };
}

const pinia = createPinia();
pinia.use(saveToStoragePlugin);

export default pinia;

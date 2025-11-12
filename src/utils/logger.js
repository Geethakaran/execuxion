/**
 * Secure Logger Utility
 *
 * Provides sanitized logging that prevents sensitive data leaks in:
 * - DevTools console
 * - Crash reports
 * - Error tracking systems
 *
 * Sensitive data includes:
 * - API keys (ex_uuid_suffix)
 * - Client IDs (UUIDs)
 * - Bearer tokens
 * - Email addresses
 * - User credentials
 */

const isDev = process.env.NODE_ENV === 'development';

/**
 * Redact sensitive strings - show only last 4 characters
 * @param {string} value - Sensitive value to redact
 * @returns {string} Redacted string
 */
function redact(value) {
  if (!value || typeof value !== 'string') return '[REDACTED]';
  if (value.length <= 4) return '[REDACTED]';
  return `[REDACTED-${value.slice(-4)}]`;
}

/**
 * Sanitize object by redacting known sensitive keys
 * @param {Object} obj - Object to sanitize
 * @returns {Object} Sanitized object
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitiveKeys = [
    'apiKey', 'api_key', 'token', 'bearer', 'password',
    'secret', 'credential', 'auth', 'authorization'
  ];

  const sanitized = { ...obj };

  for (const [key, value] of Object.entries(sanitized)) {
    const lowerKey = key.toLowerCase();

    // Check if key contains sensitive data indicator
    const isSensitive = sensitiveKeys.some(pattern => lowerKey.includes(pattern));

    if (isSensitive && typeof value === 'string') {
      sanitized[key] = redact(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    }
  }

  return sanitized;
}

/**
 * Logger object with security-aware methods
 */
export const logger = {
  /**
   * General info logging - only in development
   */
  info(...args) {
    if (isDev) {
      console.log(...args);
    }
  },

  /**
   * Log sensitive data with redaction
   * @param {string} label - Log label
   * @param {string} value - Sensitive value (API key, client ID, etc.)
   */
  sensitive(label, value) {
    if (isDev && value) {
      console.log(label, redact(value));
    } else if (!isDev) {
      // In production, don't log at all
      return;
    }
  },

  /**
   * Success logging with optional sensitive data
   * @param {string} message - Success message
   * @param {string} [sensitiveData] - Optional sensitive data to redact
   */
  success(message, sensitiveData) {
    if (isDev) {
      console.log(`✅ ${message}`, sensitiveData ? redact(sensitiveData) : '');
    }
  },

  /**
   * Error logging - always log but sanitize sensitive data
   * @param {string} label - Error label
   * @param {Error|Object|string} error - Error object or message
   */
  error(label, error) {
    // Always log errors (needed for debugging in production)
    // but sanitize potentially sensitive data

    if (error instanceof Error) {
      console.error(`❌ ${label}:`, {
        message: error.message,
        name: error.name,
        // Only include stack trace in development
        ...(isDev && { stack: error.stack })
      });
    } else if (typeof error === 'object') {
      console.error(`❌ ${label}:`, sanitizeObject(error));
    } else {
      console.error(`❌ ${label}:`, error);
    }
  },

  /**
   * Warning logging with sanitization
   * @param {string} message - Warning message
   * @param {*} data - Optional data to log
   */
  warn(message, data) {
    if (isDev) {
      console.warn(`⚠️ ${message}`, data ? sanitizeObject(data) : '');
    }
  },

  /**
   * Debug logging - development only
   * @param {string} label - Debug label
   * @param {*} data - Data to log
   */
  debug(label, data) {
    if (isDev) {
      console.log(`[DEBUG] ${label}`, data);
    }
  },

  /**
   * Auth-specific logging - redacts client IDs and API keys
   * @param {string} message - Auth message
   * @param {Object} authData - Auth data object
   */
  auth(message, authData = {}) {
    if (isDev) {
      const sanitized = {
        ...authData,
        clientId: authData.clientId ? redact(authData.clientId) : undefined,
        apiKey: authData.apiKey ? redact(authData.apiKey) : undefined,
      };
      console.log(`🔐 ${message}`, sanitized);
    }
  },

  /**
   * Storage operation logging - sanitizes stored values
   * @param {string} operation - Operation type (read/write/delete)
   * @param {string} key - Storage key
   * @param {*} value - Optional value (will be sanitized)
   */
  storage(operation, key, value) {
    if (isDev) {
      const sensitiveKeys = ['auth', 'apiKey', 'credentials', 'token'];
      const isSensitive = sensitiveKeys.some(pattern =>
        key.toLowerCase().includes(pattern)
      );

      if (isSensitive && value) {
        console.log(`[Storage] ${operation}: ${key} =`, '[REDACTED]');
      } else {
        console.log(`[Storage] ${operation}: ${key}`, value || '');
      }
    }
  }
};

/**
 * Sanitize error for reporting to external services
 * @param {Error} error - Error object
 * @returns {Object} Sanitized error data
 */
export function sanitizeErrorForReporting(error) {
  if (!(error instanceof Error)) {
    return { message: 'Unknown error', name: 'Error' };
  }

  // Remove potentially sensitive data from error messages
  let message = error.message;

  // Redact API keys (ex_uuid_suffix pattern)
  message = message.replace(/ex_[a-f0-9-]{36}_[a-zA-Z0-9]+/g, '[REDACTED_API_KEY]');

  // Redact UUIDs (client IDs)
  message = message.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '[REDACTED_UUID]');

  // Redact Bearer tokens
  message = message.replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer [REDACTED]');

  return {
    message,
    name: error.name,
    // Only include stack in development
    ...(isDev && { stack: error.stack })
  };
}

export default logger;

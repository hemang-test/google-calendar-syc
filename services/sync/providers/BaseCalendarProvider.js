/**
 * Abstract base class for calendar providers.
 * Each provider normalizes its API into a common event shape for sync orchestration.
 */
class BaseCalendarProvider {
  constructor(id, displayName) {
    if (new.target === BaseCalendarProvider) {
      throw new Error('BaseCalendarProvider cannot be instantiated directly');
    }
    this.id = id;
    this.displayName = displayName;
  }

  /** @returns {Promise<boolean>} */
  async isConnected(_userId) {
    throw new Error(`${this.id}: isConnected() not implemented`);
  }

  /**
   * Pull remote changes into the local database.
   * @returns {Promise<{ totalSynced: number, calendars?: number }>}
   */
  async pullChanges(_userId, _options = {}) {
    throw new Error(`${this.id}: pullChanges() not implemented`);
  }

  /**
   * Push a local change to the remote provider.
   * @param {object} change - { type: 'create'|'update', event: NormalizedEvent }
   */
  async pushChange(_userId, _change) {
    throw new Error(`${this.id}: pushChange() not implemented`);
  }

  /**
   * List events from the local DB in normalized form.
   * @returns {Promise<NormalizedEvent[]>}
   */
  async listLocalEvents(_userId, _options = {}) {
    throw new Error(`${this.id}: listLocalEvents() not implemented`);
  }

  /**
   * @param {object} row - DB row
   * @returns {NormalizedEvent}
   */
  normalizeEvent(_row) {
    throw new Error(`${this.id}: normalizeEvent() not implemented`);
  }
}

/**
 * @typedef {object} NormalizedEvent
 * @property {string} provider
 * @property {string} externalId
 * @property {string} calendarId
 * @property {string} summary
 * @property {string|null} description
 * @property {string|null} startTime
 * @property {string|null} endTime
 * @property {string} status
 * @property {string|null} version - remote version token (etag, updated timestamp)
 * @property {string|null} updatedAt - local DB updated_at
 * @property {object} raw
 */

module.exports = BaseCalendarProvider;
